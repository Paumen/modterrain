import { writeFileSync, existsSync } from 'node:fs';
import { readGlb, readAccessor, nodeWorldMatrices, transformPoint } from './glb.mjs';
import { buildIndex, raycast } from './ray.mjs';

const input = process.argv[2];
if (!input) {
  console.error('usage: node tools/build-grid-cells.mjs <scene.glb> [--force]');
  process.exit(1);
}
const outPath = input.replace(/\.glb$/, '_grid2.json');
if (existsSync(outPath) && !process.argv.includes('--force')) {
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
const CLIFF = /^(Basic_|Cracked_|Wall_|Cave_Edge_)/;
const CAVE_FLOOR = /^(Cave_Center_|Floor_)/;
const WALKWAY = /^Tiered_Walkway_/;
const FLOOR_MAT = /^(Grass|Dirt)$/;
const isWater = (m) => /Water|Pool/.test(m);
const PATHY = new Set(['Carved Stone Walkway', 'Wood Dark', 'Wood Light', 'Wood Light End', 'Wood Medium']);

const CUBE = 0.5;
const RISE = 0.55;
const LAT = 0.2;
const STEP = 0.1;
const EPS = 0.02;
const HEART = 0.25;

const glb = readGlb(input);
const { json } = glb;
const world = nodeWorldMatrices(json);
const pos3 = [];
const waterPos = [];
const triMat = [];
const triFloor = [];
const triAlways = [];
const sealed = new Set();
const cellKey = (cx, cy, cz) => cx * 4000000 + cy * 4000 + cz + 2000000000;
const candidates = new Map();

(json.nodes ?? []).forEach((node, i) => {
  if (node.mesh === undefined || !world[i]) return;
  const piece = (node.name || '').split('__')[0];
  for (const prim of json.meshes[node.mesh].primitives ?? []) {
    if ((prim.mode ?? 4) !== 4) continue;
    const mat = json.materials?.[prim.material]?.name ?? '';
    if (/^Hidden/.test(mat)) continue;
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
      const lo = [0, 1, 2].map((a) => Math.min(p[0][a], p[1][a], p[2][a]));
      const hi = [0, 1, 2].map((a) => Math.max(p[0][a], p[1][a], p[2][a]));
      if (water) {
        waterPos.push(...p[0], ...p[1], ...p[2]);
        continue;
      }
      if (cliff) {
        for (let cx = Math.floor(lo[0] + EPS); cx <= Math.floor(hi[0] - EPS); cx++)
          for (let cz = Math.floor(lo[2] + EPS); cz <= Math.floor(hi[2] - EPS); cz++) {
            let poly = p;
            for (const [axis, limit, keep] of [[0, cx + HEART, 1], [0, cx + 1 - HEART, -1], [2, cz + HEART, 1], [2, cz + 1 - HEART, -1]]) {
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
            if (!poly.length) continue;
            let y0 = Infinity, y1 = -Infinity;
            for (const q of poly) { y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
            for (let cy = Math.floor(y0); cy <= Math.floor(y1); cy++)
              if (y1 > cy + EPS && y0 < cy + 1 - EPS) sealed.add(cellKey(cx, cy, cz));
          }
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

const index = buildIndex(Float64Array.from(pos3), 1);
const { tris, box, bins, cols, bx, bz } = index;
const wIdx = buildIndex(Float64Array.from(waterPos), 1);

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

function waterTopAt(x, z) {
  let top = -Infinity;
  for (const t of wIdx.bins[wIdx.bz(z) * wIdx.cols + wIdx.bx(x)]) {
    const h = hitY(wIdx.tris, t, x, z);
    if (h) top = Math.max(top, h.y);
  }
  return top;
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

function headGap(x, y, z) {
  return raycast(index, x, y + 0.03, z, 0, 1, 0, CUBE - 0.06) >= CUBE - 0.06;
}

function corridor(x0, z0, g0, x1, z1, checkSeal, declared) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / STEP));
  const sl = len / n;
  const ux = (x1 - x0) / len, uz = (z1 - z0) / len;
  const gs = [g0];
  const lane = [g0, g0, g0];
  for (let i = 1; i <= n; i++) {
    const x = x0 + ux * sl * i, z = z0 + uz * sl * i;
    for (let l = 0; l < 3; l++) {
      const off = [0, LAT, -LAT][l];
      const ox = uz * off, oz = -ux * off;
      let hit = groundAt(x + ox, z + oz, lane[l] + RISE + 0.05, RISE * 2 + 0.2);
      if (!hit && declared) hit = { y: declared[0] + (declared[1] - declared[0]) * i / n };
      if (l === 0) {
        if (!hit) return false;
        if (Math.abs(hit.y - gs[Math.max(0, i - Math.round(0.5 / sl))]) >= RISE) return false;
        if (checkSeal && sealed.has(cellKey(Math.floor(x), Math.floor(hit.y + 0.25), Math.floor(z)))) return false;
        if (waterTopAt(x, z) > hit.y - 0.02) return false;
        if (!headGap(x, hit.y, z)) return false;
        gs.push(hit.y);
      }
      const gNew = hit ? hit.y : lane[0];
      const hi = Math.max(lane[l], gNew);
      for (const h of [hi + 0.28, hi + CUBE - 0.06]) {
        if (raycast(index, x - ux * sl + ox, h, z - uz * sl + oz, ux, 0, uz, sl) < sl) return false;
      }
      lane[l] = gNew;
    }
  }
  return true;
}

function sweep(x0, z0, g0, x1, z1, checkSeal, declared) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const px = (z1 - z0) / len, pz = -(x1 - x0) / len;
  for (const off of [0, 0.15, -0.15, 0.25, -0.25]) {
    if (corridor(x0 + px * off, z0 + pz * off, g0, x1 + px * off, z1 + pz * off, checkSeal, declared)) return true;
  }
  return false;
}

const nodes = [];
const byCell = new Map();
for (const { cx, cy, cz } of candidates.values()) {
  const x = cx + 0.5, z = cz + 0.5;
  let hit = groundAt(x, z, cy + 0.999, 0.999);
  if (!hit) continue;
  if (!triFloor[hit.t]) {
    const under = groundAt(x, z, hit.y - 0.001, 0.25);
    if (!under || !triFloor[under.t]) continue;
    hit = { y: hit.y, t: under.t };
  }
  const always = triAlways[hit.t];
  if (!always && sealed.has(cellKey(cx, cy, cz))) continue;
  if (!always && waterTopAt(x, z) > hit.y - 0.02) continue;
  if (!headGap(x, hit.y, z)) continue;
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
      if (!sweep(a.x, a.z, a.y, b.x, b.z, !(a.always && b.always), a.always && b.always ? [a.y, b.y] : null)) continue;
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

writeFileSync(outPath, JSON.stringify({
  meta: {
    scene: input.split('/').pop(),
    cell: 1,
    origin: { c: minX, r: minZ },
    size: { cols: maxX - minX + 1, rows: maxZ - minZ + 1 },
    eye: 1.5,
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
console.log(`${outPath}: ${outNodes.length} cells, ${outEdges.length / 2} edges, main ${mainCount}, ${compCount} components, ${sealed.size} sealed cells`);
console.log([...byMat.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', '));
