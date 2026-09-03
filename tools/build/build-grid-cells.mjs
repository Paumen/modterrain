import { writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, readAccessor, nodeWorldMatrices, transformPoint } from '../lib/glb.mjs';
import { buildIndex, raycast } from '../lib/ray.mjs';
import { TERRAIN } from '../lib/see-through.mjs';
import { sourceVersion } from '../lib/version.mjs';

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const VERSION = sourceVersion([
  fileURLToPath(import.meta.url),
  resolve(LIB, 'glb.mjs'),
  resolve(LIB, 'ray.mjs'),
  resolve(LIB, 'see-through.mjs'),
]);

const input = process.argv[2];
if (!input) {
  console.error('usage: node tools/build/build-grid-cells.mjs <scene.glb> [--force]');
  process.exit(1);
}
if (!/\.glb$/i.test(input)) {
  console.error(`${input}: input must be a .glb file`);
  process.exit(1);
}
const LINT = process.argv.includes('--lint');
const outPath = input.replace(/\.glb$/i, '_grid2.json');
const writeGrid = !existsSync(outPath) || process.argv.includes('--force');
if (!writeGrid && !LINT) {
  console.error(`${outPath} exists; pass --force to overwrite`);
  process.exit(1);
}

const NEVER = new Set(['Prop_Bridge_Rope_Middle_Cracked_2_1x1']);
const ALWAYS = new Set([
  'Docks_Decking_Flat_1x1', 'Docks_Decking_Flat_1x2', 'Docks_Decking_Steps_1x2',
  'Prop_Bridge_Rope_Middle_Cracked_1_1x1', 'Prop_Bridge_Rope_Middle_Basic_1x1',
  'Prop_Bridge_Rope_End_Basic_1x3', 'Path_Bridge_Center_Top_1x2',
  'Path_Bridge_Edge_Top_1x2', 'Prop_Bridge_Center_1x2', 'Prop_Bridge_End_2x2',
]);
const CLIFF = /^(Basic_|Cracked_|Cave_Edge_)/;
const WALL13 = /^Tiered_Retaining_Wall_/;
const CAVE_FLOOR = /^(Cave_Center_|Floor_)/;
const WALKWAY = /^Tiered_Walkway_/;
const FLOOR_MAT = /^(Grass|Dirt)$/;
const isWater = (m) => /Water|Pool/.test(m);
const PATHY = new Set(['Carved Stone Walkway', 'Wood Dark', 'Wood Light', 'Wood Light End', 'Wood Medium']);

const CUBE = 0.5;
const RISE = 0.499;
const STEP = 0.1;
const EPS = 0.02;

const glb = readGlb(input);
const { json } = glb;
const world = nodeWorldMatrices(json);
const pos3 = [];
const wallPos = [];
const obsPos = [];
const triMat = [];
const triFloor = [];
const triAlways = [];
const camPos = [];
const camPiece = [];
const sealed = new Set();
const cellKey = (cx, cy, cz) => cx * 4000000 + cy * 4000 + cz + 2000000000;
const candidates = new Map();

function clip(poly, x0, x1, z0, z1) {
  for (const [axis, limit, keep] of [[0, x0, 1], [0, x1, -1], [2, z0, 1], [2, z1, -1]]) {
    const next = [];
    for (let v = 0; v < poly.length; v++) {
      const a = poly[v], b = poly[(v + 1) % poly.length];
      const ia = (a[axis] - limit) * keep >= 0, ib = (b[axis] - limit) * keep >= 0;
      if (ia) next.push(a);
      if (ia !== ib) {
        const f = (limit - a[axis]) / (b[axis] - a[axis]);
        next.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
      }
    }
    poly = next;
    if (!poly.length) break;
  }
  return poly;
}

function sealCells(p, lo, hi) {
  for (let cx = Math.floor(lo[0] + EPS); cx <= Math.floor(hi[0] - EPS); cx++)
    for (let cz = Math.floor(lo[2] + EPS); cz <= Math.floor(hi[2] - EPS); cz++) {
      const poly = clip(p, cx + EPS, cx + 1 - EPS, cz + EPS, cz + 1 - EPS);
      if (!poly.length) continue;
      let y0 = Infinity, y1 = -Infinity;
      for (const q of poly) { y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
      for (let cy = Math.floor(y0); cy <= Math.floor(y1); cy++)
        if (y1 > cy + EPS && y0 < cy + 1 - EPS) sealed.add(cellKey(cx, cy, cz));
    }
}

(json.nodes ?? []).forEach((node, i) => {
  if (node.mesh === undefined || !world[i]) return;
  const piece = (node.name || '').split('__')[0];
  for (const prim of json.meshes[node.mesh].primitives ?? []) {
    if ((prim.mode ?? 4) !== 4) continue;
    const mat = json.materials?.[prim.material]?.name ?? '';
    const hidden = /^Hidden/.test(mat);
    if (hidden) continue;
    const solid = TERRAIN.has(mat);
    const water = isWater(mat);
    const cliff = CLIFF.test(piece);
    const always = ALWAYS.has(piece);
    const floorSrc = !NEVER.has(piece) && !water && (
      always || (FLOOR_MAT.test(mat) && !cliff) || CAVE_FLOOR.test(piece) || WALKWAY.test(piece));
    const pos = readAccessor(glb, prim.attributes.POSITION);
    const idx = prim.indices !== undefined ? readAccessor(glb, prim.indices).data : null;
    const count = idx ? idx.length : pos.count;
    for (let t = 0; t < count; t += 3) {
      const p = [];
      for (let k = 0; k < 3; k++) {
        const v = idx ? idx[t + k] : t + k;
        p.push(transformPoint(world[i], pos.data[v * 3], pos.data[v * 3 + 1], pos.data[v * 3 + 2]));
      }
      if (LINT && solid) { camPos.push(...p[0], ...p[1], ...p[2]); camPiece.push(node.name || `mesh ${node.mesh}`); }
      const lo = [0, 1, 2].map((a) => Math.min(p[0][a], p[1][a], p[2][a]));
      const hi = [0, 1, 2].map((a) => Math.max(p[0][a], p[1][a], p[2][a]));
      if (water || cliff) sealCells(p, lo, hi);
      if (water) continue;
      if (WALL13.test(piece)) wallPos.push(...p[0], ...p[1], ...p[2]);
      {
        const ux2 = p[1][0] - p[0][0], uy2 = p[1][1] - p[0][1], uz2 = p[1][2] - p[0][2];
        const vx2 = p[2][0] - p[0][0], vy2 = p[2][1] - p[0][1], vz2 = p[2][2] - p[0][2];
        const nx2 = uy2 * vz2 - uz2 * vy2, ny2 = uz2 * vx2 - ux2 * vz2, nz2 = ux2 * vy2 - uy2 * vx2;
        const ln = Math.hypot(nx2, ny2, nz2);
        if (ln > 1e-12 && ny2 / ln < 0.5) obsPos.push(...p[0], ...p[1], ...p[2]);
      }
      pos3.push(...p[0], ...p[1], ...p[2]);
      triMat.push(mat);
      triFloor.push(floorSrc);
      triAlways.push(always);
      if (floorSrc) {
        for (let cx = Math.floor(lo[0]); cx <= Math.floor(hi[0]); cx++)
          for (let cy = Math.floor(lo[1] - EPS); cy <= Math.floor(hi[1] + EPS); cy++)
            for (let cz = Math.floor(lo[2]); cz <= Math.floor(hi[2]); cz++)
              candidates.set(cellKey(cx, cy, cz), { cx, cy, cz });
      }
    }
  }
});

if (!pos3.length) {
  console.error(`${input}: no visible non-water triangles found`);
  process.exit(1);
}
const index = buildIndex(Float64Array.from(pos3), 1);
const { tris, box, bins, cols, bx, bz, seen } = index;
const wIdx = wallPos.length ? buildIndex(Float64Array.from(wallPos), 1) : null;
const oIdx = obsPos.length ? buildIndex(Float64Array.from(obsPos), 1) : null;

function hitY(T, t, x, z) {
  const a = t * 9;
  const x0 = T[a], y0 = T[a + 1], z0 = T[a + 2];
  const x1 = T[a + 3], y1 = T[a + 4], z1 = T[a + 5];
  const x2 = T[a + 6], y2 = T[a + 7], z2 = T[a + 8];
  const d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
  if (Math.abs(d) < 1e-9) return null;
  const w0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / d;
  const w1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / d;
  const w2 = 1 - w0 - w1;
  if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) return null;
  return { y: w0 * y0 + w1 * y1 + w2 * y2, up: (z1 - z0) * (x2 - x0) - (x1 - x0) * (z2 - z0) > 0 };
}

function groundAt(x, z, yTop, reach) {
  let best = null;
  for (const t of bins[bz(z) * cols + bx(x)]) {
    const b = t * 6;
    if (x < box[b] - 1e-4 || x > box[b + 3] + 1e-4 || z < box[b + 2] - 1e-4 || z > box[b + 5] + 1e-4) continue;
    if (box[b + 1] > yTop || box[b + 4] < yTop - reach) continue;
    const h = hitY(tris, t, x, z);
    if (!h || !h.up || h.y > yTop || h.y < yTop - reach) continue;
    if (!best || h.y > best.y) best = { y: h.y, t };
  }
  return best;
}

function triBoxHit(T, t, minX, minY, minZ, maxX, maxY, maxZ) {
  const a = t * 9;
  const cx2 = (minX + maxX) / 2, cy2 = (minY + maxY) / 2, cz2 = (minZ + maxZ) / 2;
  const ex = (maxX - minX) / 2, ey = (maxY - minY) / 2, ez = (maxZ - minZ) / 2;
  const v = [];
  for (let k = 0; k < 3; k++) v.push([T[a + k * 3] - cx2, T[a + k * 3 + 1] - cy2, T[a + k * 3 + 2] - cz2]);
  for (let ax = 0; ax < 3; ax++) {
    const lo = Math.min(v[0][ax], v[1][ax], v[2][ax]), hi = Math.max(v[0][ax], v[1][ax], v[2][ax]);
    if (lo > [ex, ey, ez][ax] || hi < -[ex, ey, ez][ax]) return false;
  }
  const e = [[v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]],
    [v[2][0] - v[1][0], v[2][1] - v[1][1], v[2][2] - v[1][2]],
    [v[0][0] - v[2][0], v[0][1] - v[2][1], v[0][2] - v[2][2]]];
  const n = [e[0][1] * e[1][2] - e[0][2] * e[1][1], e[0][2] * e[1][0] - e[0][0] * e[1][2], e[0][0] * e[1][1] - e[0][1] * e[1][0]];
  const dN = n[0] * v[0][0] + n[1] * v[0][1] + n[2] * v[0][2];
  const rN = ex * Math.abs(n[0]) + ey * Math.abs(n[1]) + ez * Math.abs(n[2]);
  if (Math.abs(dN) > rN) return false;
  for (const ed of e) for (let ax = 0; ax < 3; ax++) {
    const A = [0, 0, 0];
    A[(ax + 1) % 3] = -ed[(ax + 2) % 3];
    A[(ax + 2) % 3] = ed[(ax + 1) % 3];
    const ps = v.map((q) => A[0] * q[0] + A[1] * q[1] + A[2] * q[2]);
    const r = ex * Math.abs(A[0]) + ey * Math.abs(A[1]) + ez * Math.abs(A[2]);
    if (Math.min(...ps) > r || Math.max(...ps) < -r) return false;
  }
  return true;
}

function boxBlocked(idx2, minX, minY, minZ, maxX, maxY, maxZ) {
  if (!idx2) return false;
  const stamp = ++idx2.stamp;
  for (const px of [minX, maxX]) for (const pz of [minZ, maxZ]) {
    for (const t of idx2.bins[idx2.bz(pz) * idx2.cols + idx2.bx(px)]) {
      if (idx2.seen[t] === stamp) continue;
      idx2.seen[t] = stamp;
      const b = t * 6;
      if (idx2.box[b] > maxX || idx2.box[b + 3] < minX || idx2.box[b + 1] > maxY
        || idx2.box[b + 4] < minY || idx2.box[b + 2] > maxZ || idx2.box[b + 5] < minZ) continue;
      if (triBoxHit(idx2.tris, t, minX, minY, minZ, maxX, maxY, maxZ)) return true;
    }
  }
  return false;
}

function cubeFits(x, z, gTop) {
  return !boxBlocked(oIdx, x - CUBE / 2, gTop + 0.03, z - CUBE / 2, x + CUBE / 2, gTop + CUBE - 0.02, z + CUBE / 2);
}

function groundUnder(x, z, yTop, reach) {
  const h = CUBE / 2;
  const stamp = ++index.stamp;
  let best = null;
  for (const px of [x - h, x + h]) for (const pz of [z - h, z + h]) for (const t of bins[bz(pz) * cols + bx(px)]) {
    if (seen[t] === stamp) continue;
    seen[t] = stamp;
    const b = t * 6, a = t * 9;
    if (box[b] > x + h || box[b + 3] < x - h || box[b + 2] > z + h || box[b + 5] < z - h || box[b + 1] > yTop || box[b + 4] < yTop - reach) continue;
    if ((tris[a + 5] - tris[a + 2]) * (tris[a + 6] - tris[a]) - (tris[a + 3] - tris[a]) * (tris[a + 8] - tris[a + 2]) <= 0) continue;
    const poly = clip([0, 3, 6].map((k) => [tris[a + k], tris[a + k + 1], tris[a + k + 2]]), x - h, x + h, z - h, z + h);
    let y0 = Infinity, y1 = -Infinity;
    for (const q of poly) { y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
    if (y1 < yTop - reach || y0 > yTop) continue;
    const top = Math.min(y1, yTop), bot = Math.max(y0, yTop - reach);
    if (!best || top > best.y) best = { y: top, t, bot: best ? Math.min(bot, best.bot) : bot };
    else best.bot = Math.min(best.bot, bot);
  }
  return best;
}

function corridor(x0, z0, g0, x1, z1, checkSeal) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / STEP));
  const sl = len / n;
  const ux = (x1 - x0) / len, uz = (z1 - z0) / len;
  let prev = groundUnder(x0, z0, g0 + RISE + 0.05, RISE * 2 + 0.2) ?? { y: g0, bot: g0 };
  const gs = [prev.y];
  for (let i = 1; i <= n; i++) {
    const x = x0 + ux * sl * i, z = z0 + uz * sl * i;
    const here = groundUnder(x, z, gs[i - 1] + RISE + 0.05, RISE * 2 + 0.2);
    if (!here) return false;
    if (Math.abs(here.y - gs[Math.max(0, i - Math.round(0.5 / sl))]) >= RISE) return false;
    if (checkSeal && sealed.has(cellKey(Math.floor(x), Math.floor(here.y + 0.25), Math.floor(z)))) return false;
    const px = x - ux * sl, pz = z - uz * sl;
    const minX = Math.min(px, x) - CUBE / 2, maxX = Math.max(px, x) + CUBE / 2;
    const minZ = Math.min(pz, z) - CUBE / 2, maxZ = Math.max(pz, z) + CUBE / 2;
    const gTop = Math.max(here.y, prev.y), gBot = Math.min(here.bot, prev.bot);
    if (boxBlocked(oIdx, minX, gTop + 0.03, minZ, maxX, gTop + CUBE - 0.02, maxZ)) return false;
    if (boxBlocked(wIdx, minX, gBot - 0.05, minZ, maxX, gTop + CUBE, maxZ)) return false;
    gs.push(here.y);
    prev = here;
  }
  return true;
}

function sweep(x0, z0, g0, x1, z1, checkSeal) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const px = (z1 - z0) / len, pz = -(x1 - x0) / len;
  for (const off of [0, 0.15, -0.15, 0.25, -0.25]) {
    if (corridor(x0 + px * off, z0 + pz * off, g0, x1 + px * off, z1 + pz * off, checkSeal)) return true;
  }
  return false;
}

const nodes = [];
const byCell = new Map();
for (const { cx, cy, cz } of candidates.values()) {
  const x = cx + 0.5, z = cz + 0.5;
  let hit = groundAt(x, z, cy + 0.98, 1.0) ?? (groundAt(x, z, cy + 1.5, 2.0) ? null : groundUnder(x, z, cy + 0.98, 1.0));
  if (!hit) continue;
  if (!triFloor[hit.t]) {
    const under = groundAt(x, z, hit.y - 0.001, 0.25);
    if (!under || !triFloor[under.t]) continue;
    hit = { y: hit.y, t: under.t };
  }
  const always = triAlways[hit.t];
  if (!always && sealed.has(cellKey(cx, cy, cz))) continue;
  if (!cubeFits(x, z, groundUnder(x, z, hit.y + RISE + 0.05, RISE * 2 + 0.2)?.y ?? hit.y)) continue;
  if (!always) {
    let open = 0;
    for (const [dx, dz] of [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, 0.5], [-0.5, -0.5]])
      if (sweep(x, z, hit.y, x + dx, z + dz, false)) open++;
    if (open < 2) continue;
  }
  const node = { cx, cy, cz, x, z, y: hit.y, m: triMat[hit.t], always, i: nodes.length };
  nodes.push(node);
  byCell.set(cellKey(cx, cy, cz), node);
}

const edges = [];
const links = nodes.map(() => []);
for (const a of nodes) {
  for (const [dx, dz] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    for (let dy = -1; dy <= 1; dy++) {
      const b = byCell.get(cellKey(a.cx + dx, a.cy + dy, a.cz + dz));
      if (!b) continue;
      if (!sweep(a.x, a.z, a.y, b.x, b.z, !(a.always && b.always))) continue;
      links[a.i].push(b.i); links[b.i].push(a.i);
      edges.push(a.i, b.i);
    }
  }
}

const comp = new Int32Array(nodes.length).fill(-1);
let compCount = 0;
for (let i = 0; i < nodes.length; i++) {
  if (comp[i] >= 0) continue;
  const stack = [i];
  comp[i] = compCount;
  while (stack.length) for (const m of links[stack.pop()]) if (comp[m] < 0) { comp[m] = compCount; stack.push(m); }
  compCount++;
}
const sizes = new Array(compCount).fill(0);
for (const c of comp) sizes[c]++;
const main = sizes.reduce((best, n, i) => (n > sizes[best] ? i : best), 0);

let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
for (const n of nodes) {
  minX = Math.min(minX, n.cx); maxX = Math.max(maxX, n.cx);
  minZ = Math.min(minZ, n.cz); maxZ = Math.max(maxZ, n.cz);
}
const order = [];
nodes.forEach((_, i) => { if (comp[i] === main) order.push(i); });
const mainCount = order.length;
nodes.forEach((_, i) => { if (comp[i] !== main) order.push(i); });
const remap = new Map(order.map((i, k) => [i, k]));
const outNodes = order.map((i) => nodes[i]);
const outEdges = [];
for (let e = 0; e < edges.length; e += 2) outEdges.push(remap.get(edges[e]), remap.get(edges[e + 1]));

const mats = [...new Set(outNodes.map((n) => n.m))].sort();
const matIndex = new Map(mats.map((m, i) => [m, i]));
const round = (v) => Math.round(v * 1000) / 1000;
const EYE = 1.5;

if (writeGrid) writeFileSync(outPath, JSON.stringify({
  meta: {
    version: VERSION,
    built: new Date().toISOString(),
    scene: input.split('/').pop(),
    cell: 1,
    origin: { c: minX, r: minZ },
    size: { cols: maxX - minX + 1, rows: maxZ - minZ + 1 },
    eye: EYE,
    step: 0.75,
    main: mainCount,
    materials: mats,
    path: mats.map((m) => (PATHY.has(m) ? 1 : 0)),
  },
  nodes: outNodes.map((n) => [n.cx - minX, n.cz - minZ, round(n.y), matIndex.get(n.m), 0, 0]),
  edges: outEdges,
}));

const byMat = new Map();
for (const n of outNodes) byMat.set(n.m, (byMat.get(n.m) || 0) + 1);
console.log(`${outPath}${writeGrid ? '' : ' (kept)'}: ${outNodes.length} cells, ${outEdges.length / 2} edges, main ${mainCount}, ${compCount} components, ${sealed.size} sealed cells`);
console.log([...byMat.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', '));

if (LINT) {
  const BACK = 1.6, MARGIN = 0.3, MAX_R = 66, PROBE = 0.2, HEADINGS = 8;
  const VIEWS = [1.435, 1.365, 1.204, 1.029, 0.855];
  const camIdx = buildIndex(Float64Array.from(camPos), 1);
  const perp = (dx, dy, dz) => {
    const ax = Math.abs(dy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let ux = ax[1] * dz - ax[2] * dy, uy = ax[2] * dx - ax[0] * dz, uz = ax[0] * dy - ax[1] * dx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    return [[ux, uy, uz], [dy * uz - dz * uy, dz * ux - dx * uz, dx * uy - dy * ux]];
  };
  function boom(ox, oy, oz, dx, dy, dz) {
    let best = raycast(camIdx, ox, oy, oz, dx, dy, dz, MAX_R + MARGIN), tri = camIdx.hit;
    const [u, v] = perp(dx, dy, dz);
    for (const [sx, sy, sz] of [u, v, [-u[0], -u[1], -u[2]], [-v[0], -v[1], -v[2]]]) {
      const d = raycast(camIdx, ox + sx * PROBE, oy + sy * PROBE, oz + sz * PROBE, dx, dy, dz, MAX_R + MARGIN);
      if (d < best) { best = d; tri = camIdx.hit; }
    }
    return { room: Math.min(MAX_R, best - MARGIN), tri };
  }
  const pieces = new Map();
  const lintNodes = outNodes.slice(0, mainCount).map((n) => {
    let mask = 0;
    for (let k = 0; k < HEADINGS; k++) {
      const alpha = (k * 2 * Math.PI) / HEADINGS;
      let worst = null;
      for (const beta of VIEWS) {
        const h = boom(n.x, n.y + EYE, n.z, Math.cos(alpha) * Math.sin(beta), Math.cos(beta), Math.sin(alpha) * Math.sin(beta));
        if (h.room <= BACK && (!worst || h.room < worst.room)) worst = h;
      }
      if (!worst) continue;
      mask |= 1 << k;
      const name = camPiece[worst.tri];
      const rec = pieces.get(name) ?? { piece: name, family: name.split('__')[0], hits: 0, cells: new Set() };
      rec.hits++;
      rec.cells.add(`${n.cx - minX},${n.cz - minZ}`);
      pieces.set(name, rec);
    }
    let open = HEADINGS;
    for (let k = 0; k < HEADINGS; k++) if (mask & (1 << k)) open--;
    return { c: n.cx - minX, r: n.cz - minZ, y: round(n.y), open, mask };
  });
  const ranked = [...pieces.values()].sort((a, b) => b.hits - a.hits)
    .map((p) => ({ piece: p.piece, family: p.family, hits: p.hits, cells: [...p.cells] }));

  const cols = maxX - minX + 1, rows = maxZ - minZ + 1, S = 12;
  const worstAt = new Map();
  for (const n of lintNodes) {
    const key = `${n.c},${n.r}`;
    if (!worstAt.has(key) || n.open < worstAt.get(key).open) worstAt.set(key, n);
  }
  const shade = (open) => {
    const t = open / HEADINGS;
    const mix = (a, b) => Math.round(a + (b - a) * t).toString(16).padStart(2, '0');
    return open === HEADINGS ? '#3f8f4f' : `#${mix(0xe0, 0x8a)}${mix(0x3a, 0xd8)}${mix(0x3a, 0x6a)}`;
  };
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cols * S} ${rows * S}" width="${cols * S}" height="${rows * S}">`,
    `<rect width="${cols * S}" height="${rows * S}" fill="#1a2028"/>`];
  for (const n of worstAt.values()) {
    const x = n.c * S, z = n.r * S, cx = x + S / 2, cz = z + S / 2;
    const blocked = [];
    for (let k = 0; k < HEADINGS; k++) if (n.mask & (1 << k)) blocked.push(k);
    const title = `cell ${n.c},${n.r} y ${n.y} open ${n.open}/${HEADINGS}` + (blocked.length ? ` blocked ${blocked.map((k) => k * 45 + '\u00b0').join(' ')}` : '');
    svg.push(`<g><title>${esc(title)}</title><rect x="${x + 0.5}" y="${z + 0.5}" width="${S - 1}" height="${S - 1}" fill="${shade(n.open)}"/>`);
    for (const k of blocked) {
      const a = (k * 2 * Math.PI) / HEADINGS;
      svg.push(`<line x1="${cx}" y1="${cz}" x2="${round(cx + Math.cos(a) * (S / 2 - 1))}" y2="${round(cz + Math.sin(a) * (S / 2 - 1))}" stroke="#1a2028" stroke-width="1.5"/>`);
    }
    svg.push('</g>');
  }
  svg.push('</svg>');
  const lintBase = input.replace(/\.glb$/i, '_camlint');
  writeFileSync(`${lintBase}.svg`, svg.join('\n'));
  writeFileSync(`${lintBase}.json`, JSON.stringify({
    meta: { scene: input.split('/').pop(), built: new Date().toISOString(), eye: EYE, back: BACK, margin: MARGIN, probe: PROBE, views: VIEWS, headings: HEADINGS, origin: { c: minX, r: minZ }, main: mainCount },
    nodes: lintNodes.map((n) => [n.c, n.r, n.y, n.open, n.mask]),
    pieces: ranked,
  }));
  const hist = new Array(HEADINGS + 1).fill(0);
  for (const n of lintNodes) hist[n.open]++;
  console.log(`${lintBase}.svg/.json: open headings ${hist.map((n, i) => `${i}:${n}`).join(' ')}`);
  for (const p of ranked.slice(0, 15)) console.log(`  ${p.hits} ${p.piece} (${p.cells.length} cells)`);
}
