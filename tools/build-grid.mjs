// Where you can walk in a scene GLB. One cell is one world unit.
//
//   node tools/build-grid.mjs scenes/Foo.glb [--force] [--probe x,z]
//
// Four rules, and nothing else:
//   1. A cell has a floor at a level if the surface there is a walkable material.
//   2. Water on that floor means no floor.
//   3. An object taller than TALL standing on that floor closes the cell.
//   4. You can step to a touching cell whose floor is within STEP up or down.

import { readGlb } from './glb.mjs';
import { writeFileSync, existsSync } from 'node:fs';

const WALKABLE = new Set(['Grass', 'Dirt', 'Cliff', 'Carved Stone Walkway',
  'Wood Light', 'Wood Light End', 'Wood Medium', 'Wood Dark']);
const WATER = new Set(['Water River', 'Waterfall', 'Waterfall Crest', 'Cave Pool']);
const PATH = new Set(['Carved Stone Walkway', 'Wood Light', 'Wood Light End', 'Wood Medium', 'Wood Dark']);
const TALL = 0.25;    // an object shorter than this you step over
const STEP = 1.0;     // one tier
const FLAT = 0.5;     // a surface facing up at least this much is floor, not wall
const SAME = 0.4;     // surfaces this close together are one floor
const EYE = 3.6;      // camera height above the floor

const input = process.argv[2];
const probe = process.argv.indexOf('--probe');
if (!input) { console.error('usage: node tools/build-grid.mjs <scene.glb> [--force] [--probe x,z]'); process.exit(1); }
const out = input.replace(/\.glb$/, '_grid.json');
if (existsSync(out) && !process.argv.includes('--force') && probe < 0) {
  console.error(`${out} exists; pass --force`); process.exit(1);
}

const { json, bin } = readGlb(input);
const CTOR = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const data = (i) => {
  const a = json.accessors[i], b = json.bufferViews[a.bufferView];
  return new CTOR[a.componentType](bin.buffer, bin.byteOffset + (b.byteOffset || 0) + (a.byteOffset || 0), a.count * SIZE[a.type]);
};
const name = (i) => json.materials?.[i]?.name ?? '';
const apply = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

// --- every visible triangle, in world space ---------------------------------

const tris = [];  // [x0,y0,z0, x1,y1,z1, x2,y2,z2, material, upness]
for (const node of json.nodes) {
  if (node.mesh == null || !node.matrix) continue;
  for (const prim of json.meshes[node.mesh].primitives) {
    if ((prim.mode ?? 4) !== 4 || /^Hidden/.test(name(prim.material))) continue;
    const pos = data(prim.attributes.POSITION);
    const idx = prim.indices != null ? data(prim.indices) : null;
    const n = idx ? idx.length : pos.length / 3;
    for (let t = 0; t < n; t += 3) {
      const p = [0, 1, 2].map((k) => {
        const i = idx ? idx[t + k] : t + k;
        return apply(node.matrix, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      });
      const ax = p[1][0] - p[0][0], ay = p[1][1] - p[0][1], az = p[1][2] - p[0][2];
      const bx = p[2][0] - p[0][0], by = p[2][1] - p[0][1], bz = p[2][2] - p[0][2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      tris.push([...p[0], ...p[1], ...p[2], prim.material, ny / (Math.hypot(nx, ny, nz) || 1)]);
    }
  }
}

// --- bin them by cell so a cell can be asked what is in it ------------------

let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const [x0, , z0, x1, , z1, x2, , z2] of tris) {
  minX = Math.min(minX, x0, x1, x2); maxX = Math.max(maxX, x0, x1, x2);
  minZ = Math.min(minZ, z0, z1, z2); maxZ = Math.max(maxZ, z0, z1, z2);
}
const C0 = Math.floor(minX), R0 = Math.floor(minZ);
const COLS = Math.ceil(maxX) - C0, ROWS = Math.ceil(maxZ) - R0;
const bins = new Map();
for (let t = 0; t < tris.length; t++) {
  const [x0, , z0, x1, , z1, x2, , z2] = tris[t];
  for (let c = Math.floor(Math.min(x0, x1, x2)); c <= Math.floor(Math.max(x0, x1, x2)); c++)
    for (let r = Math.floor(Math.min(z0, z1, z2)); r <= Math.floor(Math.max(z0, z1, z2)); r++) {
      const k = c * 100000 + r;
      const list = bins.get(k);
      if (list) list.push(t); else bins.set(k, [t]);
    }
}
const inCell = (c, r) => bins.get((c + C0) * 100000 + (r + R0)) || [];

// --- rules ------------------------------------------------------------------

// Rule 1: floors, from the up-facing walkable surfaces in the cell.
// Rule 2: water at a floor's level cancels it.
// Rule 3: anything else standing on a floor closes the cell.
function floorsIn(c, r, why) {
  const here = inCell(c, r);
  const up = [], wet = [], solid = [];
  for (const t of here) {
    const tri = tris[t], mat = name(tri[9]), lo = Math.min(tri[1], tri[4], tri[7]);
    if (tri[10] > FLAT && WALKABLE.has(mat)) up.push([Math.max(tri[1], tri[4], tri[7]), mat]);
    else if (WATER.has(mat)) wet.push(lo);
    else solid.push([lo, Math.max(tri[1], tri[4], tri[7])]);
  }
  if (!up.length) return [];
  up.sort((a, b) => a[0] - b[0]);

  const floors = [];
  for (let i = 0; i < up.length;) {
    let j = i;
    while (j + 1 < up.length && up[j + 1][0] - up[j][0] <= SAME) j++;
    const y = up[j][0], mat = up[j][1];
    if (wet.some((w) => w > y - 0.05 && w < y + 1)) why?.(y, mat, 'water');
    // An object belongs to the level it stands on, and closes it if it is
    // taller than TALL. Things at other levels -- a bridge deck overhead --
    // belong to those levels, not this one.
    else if (solid.some(([lo, hi]) => lo < y + TALL && hi > y + TALL)) why?.(y, mat, 'blocked');
    else { why?.(y, mat, 'open'); floors.push({ c, r, y, mat }); }
    i = j + 1;
  }
  return floors;
}

if (probe > 0) {
  const [px, pz] = process.argv[probe + 1].split(',').map(Number);
  const c = Math.floor(px) - C0, r = Math.floor(pz) - R0;
  console.log(`cell ${C0 + c + 0.5}, ${R0 + r + 0.5}`);
  floorsIn(c, r, (y, mat, verdict) => console.log(`  ${y.toFixed(2)}  ${mat.padEnd(22)} ${verdict}`));
  process.exit(0);
}

const cells = [];
const at = new Map();
for (let r = 0; r < ROWS; r++)
  for (let c = 0; c < COLS; c++)
    for (const f of floorsIn(c, r)) {
      const k = c * 100000 + r;
      (at.get(k) || at.set(k, []).get(k)).push(f);
      f.i = cells.length; cells.push(f);
    }

// Rule 4: step to a touching cell within STEP.
const edges = [];
for (const f of cells)
  for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [1, -1]])
    for (const g of at.get((f.c + dc) * 100000 + (f.r + dr)) || [])
      if (Math.abs(g.y - f.y) <= STEP) edges.push(f.i, g.i);

const mats = [...new Set(cells.map((f) => f.mat))].sort();
writeFileSync(out, JSON.stringify({
  meta: { cell: 1, origin: { c: C0, r: R0 }, size: { cols: COLS, rows: ROWS }, eye: EYE, step: STEP,
    materials: mats, path: mats.map((m) => (PATH.has(m) ? 1 : 0)) },
  cells: cells.map((f) => [f.c, f.r, Math.round(f.y * 1000) / 1000, mats.indexOf(f.mat)]),
  edges,
}));

const tally = new Map();
for (const f of cells) tally.set(f.mat, (tally.get(f.mat) || 0) + 1);
console.log(`${out}: ${cells.length} cells, ${edges.length / 2} steps, ${COLS}x${ROWS}`);
console.log([...tally].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', '));
