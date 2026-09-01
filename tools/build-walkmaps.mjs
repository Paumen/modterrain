import { writeFileSync } from 'node:fs';
import { readGlb, readAccessor, nodeWorldMatrices } from './glb.mjs';

export const SLOPE = 0.5;
export const CLUSTER = 0.3;
export const STEP = 0.75;
export const STEP_OVER = 0.45;
export const HEAD = 0.8;
export const WALKABLE = new Set(['Grass', 'Dirt', 'Carved Stone Walkway', 'Wood Dark', 'Wood Light', 'Wood Light End', 'Wood Medium']);
export const PATHY = new Set(['Carved Stone Walkway', 'Wood Dark', 'Wood Light', 'Wood Light End', 'Wood Medium']);
export const OVERRIDES = [
  { piece: /^(Cave_Center_|Floor_)/, material: /^Cliff/ },
];
export const isWater = (name) => /Water|Pool/.test(name);

const SUB = 3;
const SAMPLES = [-0.25, 0.25];
const EPS = 1e-6;

export function sceneInstances(glb) {
  const { json } = glb;
  const world = nodeWorldMatrices(json);
  const groups = new Map();
  (json.nodes ?? []).forEach((node, i) => {
    if (node.mesh === undefined || !world[i]) return;
    const piece = (node.name || '').split('__')[0];
    const key = piece + '|' + world[i].map((v) => Math.round(v * 1e4)).join(',');
    let g = groups.get(key);
    if (!g) {
      g = { piece, matrix: world[i], nodes: [] };
      groups.set(key, g);
    }
    g.nodes.push(i);
  });
  return [...groups.values()];
}

export const linearOf = (m) => [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
export const originOf = (m) => [m[12], m[13], m[14]];

export function stampKey(glb, inst) {
  const { json } = glb;
  const parts = [];
  for (const i of inst.nodes) {
    for (const prim of json.meshes[json.nodes[i].mesh].primitives ?? []) {
      const acc = json.accessors[prim.attributes.POSITION];
      parts.push(`${acc.count}:${[...(acc.min ?? []), ...(acc.max ?? [])].map((v) => Math.round(v * 1e6)).join(',')}`);
    }
  }
  const lin = linearOf(inst.matrix).map((v) => Math.round(v * 100) / 100).join(',');
  return `${inst.piece}@${lin}#${parts.sort().join('|')}`;
}

function localTriangles(glb, instance) {
  const { json } = glb;
  const A = linearOf(instance.matrix);
  const out = [];
  for (const i of instance.nodes) {
    const node = json.nodes[i];
    for (const prim of json.meshes[node.mesh].primitives ?? []) {
      if ((prim.mode ?? 4) !== 4) continue;
      const name = json.materials?.[prim.material]?.name ?? '';
      const pos = readAccessor(glb, prim.attributes.POSITION);
      const idx = prim.indices !== undefined ? readAccessor(glb, prim.indices).data : null;
      const count = idx ? idx.length : pos.count;
      for (let ti = 0; ti < count; ti += 3) {
        const p = [];
        for (let k = 0; k < 3; k++) {
          const v = idx ? idx[ti + k] : ti + k;
          const x = pos.data[v * 3], y = pos.data[v * 3 + 1], z = pos.data[v * 3 + 2];
          p.push([
            A[0] * x + A[3] * y + A[6] * z,
            A[1] * x + A[4] * y + A[7] * z,
            A[2] * x + A[5] * y + A[8] * z,
          ]);
        }
        const ax = p[1][0] - p[0][0], ay = p[1][1] - p[0][1], az = p[1][2] - p[0][2];
        const bx = p[2][0] - p[0][0], by = p[2][1] - p[0][1], bz = p[2][2] - p[0][2];
        const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-12) continue;
        out.push({ p, ny: ny / len, mat: name });
      }
    }
  }
  return out;
}

function hitAt(tri, x, z) {
  const [a, b, c] = tri.p;
  const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
  if (Math.abs(d) < 1e-12) return null;
  const w0 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
  const w1 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
  const w2 = 1 - w0 - w1;
  if (w0 < -EPS || w1 < -EPS || w2 < -EPS) return null;
  return w0 * a[1] + w1 * b[1] + w2 * c[1];
}

function clipRect(poly, x0, x1, z0, z1) {
  const planes = [[0, x0, 1], [0, x1, -1], [2, z0, 1], [2, z1, -1]];
  let cur = poly;
  for (const [axis, limit, sign] of planes) {
    const next = [];
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i], b = cur[(i + 1) % cur.length];
      const ia = (a[axis] - limit) * sign >= 0, ib = (b[axis] - limit) * sign >= 0;
      if (ia) next.push(a);
      if (ia !== ib) {
        const f = (limit - a[axis]) / (b[axis] - a[axis]);
        next.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
      }
    }
    cur = next;
    if (!cur.length) return null;
  }
  return cur;
}

function columnIntervals(crossings) {
  crossings.sort((a, b) => a.y - b.y);
  const out = [];
  let bottom = null;
  for (const c of crossings) {
    if (c.up) {
      out.push([bottom ?? c.y - 0.05, c.y]);
      bottom = null;
    } else if (bottom === null) bottom = c.y;
  }
  if (bottom !== null) out.push([bottom, bottom + 0.05]);
  return out;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

export function probeTriangles(piece, tris) {
  const walkOk = (mat) => WALKABLE.has(mat)
    || OVERRIDES.some((o) => o.piece.test(piece) && o.material.test(mat));

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const t of tris) for (const p of t.p) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
  }
  const lattice = (lo, hi) => {
    const a = Math.round(lo * 2) / 2;
    return { start: a, n: Math.max(1, Math.round(Math.round(hi * 2) / 2 - a)) };
  };
  const lx = lattice(minX, maxX), lz = lattice(minZ, maxZ);

  const cells = {};
  for (let kx = 0; kx < lx.n; kx++) for (let kz = 0; kz < lz.n; kz++) {
    const cx = lx.start + 0.5 + kx, cz = lz.start + 0.5 + kz;
    const near = tris.filter((t) =>
      Math.min(t.p[0][0], t.p[1][0], t.p[2][0]) <= cx + 0.5 + EPS
      && Math.max(t.p[0][0], t.p[1][0], t.p[2][0]) >= cx - 0.5 - EPS
      && Math.min(t.p[0][2], t.p[1][2], t.p[2][2]) <= cz + 0.5 + EPS
      && Math.max(t.p[0][2], t.p[1][2], t.p[2][2]) >= cz - 0.5 - EPS);
    if (!near.length) continue;

    const occ = Array.from({ length: SUB * SUB }, () => []);
    const walk = Array.from({ length: SUB * SUB }, () => []);
    const water = Array.from({ length: SUB * SUB }, () => []);
    for (let iz = 0; iz < SUB; iz++) for (let ix = 0; ix < SUB; ix++) {
      const sub = iz * SUB + ix;
      const sx = cx + (ix - 1) / 3, sz = cz + (iz - 1) / 3;
      const walkHits = [];
      for (const dx of SAMPLES) for (const dz of SAMPLES) {
        const x = sx + dx / 3, z = sz + dz / 3;
        const crossings = [];
        for (const t of near) {
          if (Math.abs(t.ny) < 0.05) continue;
          const y = hitAt(t, x, z);
          if (y === null) continue;
          if (isWater(t.mat)) {
            if (t.ny >= SLOPE) water[sub].push(round3(y));
            continue;
          }
          crossings.push({ y, up: t.ny > 0 });
          if (t.ny >= SLOPE && walkOk(t.mat)) walkHits.push({ y, mat: t.mat });
        }
        occ[sub].push(...columnIntervals(crossings));
      }
      for (const t of near) {
        if (Math.abs(t.ny) >= SLOPE || isWater(t.mat)) continue;
        const clipped = clipRect(t.p, sx - 1 / 6 + 0.002, sx + 1 / 6 - 0.002, sz - 1 / 6 + 0.002, sz + 1 / 6 - 0.002);
        if (!clipped) continue;
        let lo = Infinity, hi = -Infinity;
        for (const p of clipped) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
        occ[sub].push([lo, hi]);
      }
      occ[sub] = occ[sub].map(([a, b]) => [round3(a), round3(b)]);

      walkHits.sort((a, b) => a.y - b.y);
      const surfs = [];
      for (const h of walkHits) {
        const last = surfs[surfs.length - 1];
        if (last && h.y - last.top <= CLUSTER) {
          if (h.y >= last.top) { last.top = h.y; last.mat = h.mat; }
          last.n++;
        } else surfs.push({ top: h.y, mat: h.mat, n: 1 });
      }
      walk[sub] = surfs.filter((f) => f.n >= 2).map((f) => [round3(f.top), f.mat]);
      water[sub] = [...new Set(water[sub])].sort((a, b) => a - b)
        .filter((y, i, arr) => i === 0 || y - arr[i - 1] > 0.05);
    }

    if (walk.every((l) => !l.length) && water.every((l) => !l.length) && occ.every((l) => !l.length)) continue;
    cells[`${cx},${cz}`] = { k: walk, w: water, o: occ };
  }
  return cells;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const scenes = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!scenes.length) {
    console.error('usage: node tools/build-walkmaps.mjs <scene.glb> [more.glb ...]');
    process.exit(1);
  }
  const pieces = {};
  for (const path of scenes) {
    const glb = readGlb(path);
    for (const inst of sceneInstances(glb)) {
      const key = stampKey(glb, inst);
      if (pieces[key]) continue;
      pieces[key] = probeTriangles(inst.piece, localTriangles(glb, inst));
    }
  }
  writeFileSync('catalog/walkmaps.json', JSON.stringify({
    walkable: [...WALKABLE], pathy: [...PATHY], pieces,
  }));
  const ids = Object.keys(pieces);
  const walkCells = ids.reduce((n, id) => n + Object.values(pieces[id]).filter((c) => c.k.some((l) => l.length)).length, 0);
  console.log(`catalog/walkmaps.json: ${ids.length} pieces, ${walkCells} walkable piece-cells`);
}
