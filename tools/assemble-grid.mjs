import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readGlb } from './glb.mjs';
import { sceneInstances, stampKey, originOf, STEP, STEP_OVER, HEAD, CLUSTER, PATHY } from './build-walkmaps.mjs';

const input = process.argv[2];
if (!input) {
  console.error('usage: node tools/assemble-grid.mjs <scene.glb> [--force]');
  process.exit(1);
}
const outPath = input.replace(/\.glb$/, '_grid2.json');
if (existsSync(outPath) && !process.argv.includes('--force')) {
  console.error(`${outPath} exists; pass --force to overwrite`);
  process.exit(1);
}

const EYE = 1.5;
const walkmaps = JSON.parse(readFileSync('catalog/walkmaps.json', 'utf8'));
const glb = readGlb(input);
const instances = sceneInstances(glb);

const missing = new Set();
const stamps = [];
for (const inst of instances) {
  const map = walkmaps.pieces[stampKey(glb, inst)];
  if (!map) { missing.add(inst.piece); continue; }
  stamps.push({ map, t: originOf(inst.matrix) });
}
if (missing.size) {
  console.error(`no walk map for:\n  ${[...missing].join('\n  ')}\nrun tools/build-walkmaps.mjs over this scene first`);
  process.exit(1);
}

let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const { map, t } of stamps) {
  for (const key of Object.keys(map)) {
    const [lx, lz] = key.split(',').map(Number);
    minX = Math.min(minX, lx + t[0]); maxX = Math.max(maxX, lx + t[0]);
    minZ = Math.min(minZ, lz + t[2]); maxZ = Math.max(maxZ, lz + t[2]);
  }
}
const C0 = Math.floor(minX), R0 = Math.floor(minZ);
const COLS = Math.ceil(maxX) - C0 + 1, ROWS = Math.ceil(maxZ) - R0 + 1;

const cellKey = (c, r) => c * 100000 + r;
const subOf = (f) => Math.min(2, Math.max(0, Math.floor((f + 0.5) * 3)));
const occGrid = new Map();
const walkGrid = new Map();
const waterGrid = new Map();
const push = (grid, k, v) => {
  const list = grid.get(k);
  if (list) list.push(v); else grid.set(k, [v]);
};

for (const { map, t } of stamps) {
  for (const [key, cell] of Object.entries(map)) {
    const [lx, lz] = key.split(',').map(Number);
    const wx = lx + t[0], wz = lz + t[2];
    for (let sub = 0; sub < 9; sub++) {
      if (!cell.o[sub].length && !cell.k[sub].length && !cell.w[sub].length) continue;
      const sx = wx + ((sub % 3) - 1) / 3, sz = wz + (Math.floor(sub / 3) - 1) / 3;
      const sc = Math.floor(sx - C0), sr = Math.floor(sz - R0);
      const si = subOf(sx - C0 - sc - 0.5) + 3 * subOf(sz - R0 - sr - 0.5);
      const k = cellKey(sc, sr) * 9 + si;
      for (const [lo, hi] of cell.o[sub]) push(occGrid, k, [lo + t[1], hi + t[1]]);
      for (const [y, mat] of cell.k[sub]) push(walkGrid, k, { y: y + t[1], mat });
      for (const y of cell.w[sub]) push(waterGrid, cellKey(sc, sr), y + t[1]);
    }
  }
}

function intruded(c, r, sub, lo, hi) {
  const list = occGrid.get(cellKey(c, r) * 9 + sub);
  if (!list) return false;
  for (const [a, b] of list) if (a < hi && b > lo) return true;
  return false;
}
function ceilingAbove(c, r, sub, y) {
  let best = Infinity;
  const list = occGrid.get(cellKey(c, r) * 9 + sub);
  if (list) for (const [a] of list) if (a > y + 0.02 && a < best) best = a;
  return best;
}
const subAt = (x, z) => {
  const c = Math.floor(x - C0), r = Math.floor(z - R0);
  return [c, r, subOf(x - C0 - c - 0.5) + 3 * subOf(z - R0 - r - 0.5)];
};

const nodes = [];
const byCell = new Map();
const reject = { blocked: 0, water: 0 };
const cellsSeen = new Set();
for (const k9 of walkGrid.keys()) cellsSeen.add(Math.floor(k9 / 9));
for (const k of cellsSeen) {
  const c = Math.floor(k / 100000), r = k % 100000;
  const hits = [];
  for (let sub = 0; sub < 9; sub++) {
    for (const { y, mat } of walkGrid.get(k * 9 + sub) ?? []) hits.push({ y, mat, sub });
  }
  hits.sort((a, b) => a.y - b.y);
  const merged = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.y - last.top <= CLUSTER) {
      last.top = Math.max(last.top, h.y);
      last.subs.set(h.sub, Math.max(last.subs.get(h.sub) ?? -Infinity, h.y));
      if (h.y >= last.top) last.mat = h.mat;
    } else merged.push({ top: h.y, mat: h.mat, subs: new Map([[h.sub, h.y]]) });
  }
  const here = [];
  for (const s of merged) {
    let cx = 0, cz = 0, cy = 0;
    for (const [sub, y] of s.subs) {
      cx += (sub % 3) - 1; cz += Math.floor(sub / 3) - 1; cy += y;
    }
    const n = s.subs.size;
    const midX = C0 + c + 0.5 + (cx / n) / 3, midZ = R0 + r + 0.5 + (cz / n) / 3;
    const midSub = subOf(midX - C0 - c - 0.5) + 3 * subOf(midZ - R0 - r - 0.5);
    const spots = [[midSub, s.subs.get(midSub) ?? cy / n, midX, midZ]];
    for (const [sub, y] of s.subs) {
      if (sub === midSub) continue;
      spots.push([sub, y, C0 + c + 0.5 + ((sub % 3) - 1) / 3, R0 + r + 0.5 + (Math.floor(sub / 3) - 1) / 3]);
    }
    const waters = waterGrid.get(cellKey(c, r));
    let placed = false, wet = false;
    for (const [sub, y, x, z] of spots) {
      if (intruded(c, r, sub, y + STEP_OVER, y + HEAD)) continue;
      if (waters && waters.some((w) => w > y + 0.02 && w < ceilingAbove(c, r, sub, y))) { wet = true; continue; }
      here.push({ c, r, x, z, y, m: s.mat, i: nodes.length });
      nodes.push(here[here.length - 1]);
      placed = true;
      break;
    }
    if (!placed) { if (wet) reject.water++; else reject.blocked++; }
  }
  if (here.length) byCell.set(k, here);
}

const DIRS = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const FRACTIONS = [1 / 3, 1 / 2, 2 / 3];
function clearBetween(a, b) {
  for (const f of FRACTIONS) {
    const x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f;
    const y = a.y + (b.y - a.y) * f;
    const [c, r, sub] = subAt(x, z);
    if (intruded(c, r, sub, y + STEP_OVER, y + HEAD)) return false;
  }
  return true;
}
const edges = [];
const links = nodes.map(() => []);
for (const list of byCell.values()) {
  for (const a of list) {
    for (const [dc, dr] of DIRS) {
      const other = byCell.get(cellKey(a.c + dc, a.r + dr));
      if (!other) continue;
      const limit = STEP * (dc !== 0 && dr !== 0 ? Math.SQRT2 : 1);
      for (const b of other) {
        if (b.i <= a.i) continue;
        if (Math.abs(b.y - a.y) > limit) continue;
        if (!clearBetween(a, b)) continue;
        links[a.i].push(b.i); links[b.i].push(a.i);
        edges.push(a.i, b.i);
      }
    }
  }
}

const comp = new Int32Array(nodes.length).fill(-1);
let compCount = 0;
for (let i = 0; i < nodes.length; i++) {
  if (comp[i] >= 0) continue;
  const stack = [i];
  comp[i] = compCount;
  while (stack.length) {
    const n = stack.pop();
    for (const m of links[n]) if (comp[m] < 0) { comp[m] = compCount; stack.push(m); }
  }
  compCount++;
}
const sizes = new Array(compCount).fill(0);
for (const c of comp) sizes[c]++;
const main = sizes.reduce((best, n, i) => (n > sizes[best] ? i : best), 0);

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

const doc = {
  meta: {
    scene: input.split('/').pop(),
    cell: 1,
    origin: { c: C0, r: R0 },
    size: { cols: COLS, rows: ROWS },
    eye: EYE,
    step: STEP,
    main: mainCount,
    materials: mats,
    path: mats.map((m) => (PATHY.has(m) ? 1 : 0)),
  },
  nodes: outNodes.map((n) => [n.c, n.r, round(n.y), matIndex.get(n.m), round(n.x - C0 - n.c - 0.5), round(n.z - R0 - n.r - 0.5)]),
  edges: outEdges,
};

writeFileSync(outPath, JSON.stringify(doc));
const byMat = new Map();
for (const n of outNodes) byMat.set(n.m, (byMat.get(n.m) || 0) + 1);
console.log(`${outPath}: ${outNodes.length} cells, ${outEdges.length / 2} edges, ${COLS}x${ROWS} grid, main component ${mainCount}, ${compCount} components`);
console.log([...byMat.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', '));
console.log(`rejected: ${JSON.stringify(reject)}`);
