import { readGlb } from './glb.mjs';
import { writeFileSync, existsSync } from 'node:fs';

const input = process.argv[2];
if (!input) {
  console.error('usage: node tools/build-grid.mjs <scene.glb> [--force]');
  process.exit(1);
}
const force = process.argv.includes('--force');
const outPath = input.replace(/\.glb$/, '_grid.json');
const READ_ONLY = ['--probe', '--components'].some((f) => process.argv.includes(f));
if (existsSync(outPath) && !force && !READ_ONLY) {
  console.error(`${outPath} exists; pass --force to overwrite`);
  process.exit(1);
}

const { json, bin } = readGlb(input);

const CTOR = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function accessorData(i) {
  const a = json.accessors[i];
  const bv = json.bufferViews[a.bufferView];
  const offset = (bv.byteOffset || 0) + (a.byteOffset || 0);
  return new CTOR[a.componentType](bin.buffer, bin.byteOffset + offset, a.count * NCOMP[a.type]);
}

function xformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function mul4(a, b) {
  const r = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let ro = 0; ro < 4; ro++)
      r[c * 4 + ro] = a[ro] * b[c * 4] + a[4 + ro] * b[c * 4 + 1] + a[8 + ro] * b[c * 4 + 2] + a[12 + ro] * b[c * 4 + 3];
  return r;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function localMatrix(node) {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

const matName = (i) => json.materials?.[i]?.name ?? '(none)';
const isHidden = (i) => /^Hidden/.test(matName(i));

// Every piece is either ground you can stand on, an obstacle standing in the
// way, or water. Nothing else about a piece matters here, except that a cave
// floor is ground that is meant to have rock over it.
const CAVE_FLOOR = /^Floor_/;
const OBSTACLE = /^(Basic_|Cave_|Ceiling_|Cracked_|Docks_(Bumper|Ladder_Middle|Railing|Support)_|Path_Edging_|Path_Fence_|Prop_(Column|Stalactite|Stalagmite)_|Tiered_Retaining_Wall_|Wall_)/;
const WATER = /^(Terrain_Water_|Water_|Waterfall_)/;
const GROUND = /^(Docks_(Decking|Ladder_Top)_|Grass_|Path_(Bridge|Terrain)_|Prop_(Bridge|Protrusion_Floor)_|Terrain_Sand_|Tiered_(Grass|Walkway)_)/;

// The one piece that is both: a bridge carries its own handrails, so its deck
// is ground and only what stands up off the deck -- a post, not the edge of a
// plank -- is an obstacle.
const RAILED = /^Prop_Bridge_/;
const RAIL = 0.3;

const GROUNDS = 0, CAVE = 1, BLOCKS = 2, WET = 3;
const unknown = new Set();
function kindOf(piece) {
  if (CAVE_FLOOR.test(piece)) return CAVE;
  if (OBSTACLE.test(piece)) return BLOCKS;
  if (WATER.test(piece)) return WET;
  if (GROUND.test(piece)) return GROUNDS;
  unknown.add(piece);
  return BLOCKS;
}

// A gate is an obstacle only while it is shut. A shut leaf hangs in line with
// the frame it is hinged to; an open one has swung away from it.
const yawOf = (m) => Math.atan2(m[8], m[0]);
const hinges = [];
for (const node of json.nodes || []) {
  if (/^Path_Fence_Gate_Frame_Hinged_/.test(node.name || '') && node.matrix)
    hinges.push([node.matrix[12], node.matrix[14], yawOf(node.matrix)]);
}
function gateShut(m) {
  let best = null, bestD = Infinity;
  for (const h of hinges) {
    const d = Math.hypot(h[0] - m[12], h[1] - m[14]);
    if (d < bestD) { bestD = d; best = h; }
  }
  if (!best) return true;
  const turn = Math.abs(((yawOf(m) - best[2] + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
  return turn < 0.26;
}

const tris = [];
const triPiece = [];
const cache = new Map();

function meshGeometry(prim) {
  const key = `${prim.attributes.POSITION}/${prim.indices ?? -1}`;
  let g = cache.get(key);
  if (!g) g = cache.set(key, (g = { pos: accessorData(prim.attributes.POSITION), idx: prim.indices != null ? accessorData(prim.indices) : null })).get(key);
  return g;
}

const FLAT = 0.5;

function emitNode(nodeIndex, parent) {
  const node = json.nodes[nodeIndex];
  const world = parent === IDENTITY && node.matrix ? node.matrix : mul4(parent, localMatrix(node));
  if (node.mesh != null) {
    const piece = (node.name || '').split('__')[0];
    const open = /^Path_Fence_Gate_Door_/.test(piece) && !gateShut(world);
    const kind = kindOf(piece);
    const railed = RAILED.test(piece);
    if (!open) for (const prim of json.meshes[node.mesh].primitives) {
      if ((prim.mode ?? 4) !== 4 || isHidden(prim.material)) continue;
      const { pos, idx } = meshGeometry(prim);
      const count = idx ? idx.length : pos.length / 3;
      for (let t = 0; t < count; t += 3) {
        const i0 = idx ? idx[t] : t, i1 = idx ? idx[t + 1] : t + 1, i2 = idx ? idx[t + 2] : t + 2;
        const p0 = xformPoint(world, pos[i0 * 3], pos[i0 * 3 + 1], pos[i0 * 3 + 2]);
        const p1 = xformPoint(world, pos[i1 * 3], pos[i1 * 3 + 1], pos[i1 * 3 + 2]);
        const p2 = xformPoint(world, pos[i2 * 3], pos[i2 * 3 + 1], pos[i2 * 3 + 2]);
        const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
        const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
        const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const up = ny / (Math.hypot(nx, ny, nz) || 1);
        const post = railed && Math.abs(up) < FLAT
          && Math.max(p0[1], p1[1], p2[1]) - Math.min(p0[1], p1[1], p2[1]) >= RAIL;
        tris.push([...p0, ...p1, ...p2, prim.material, up, post ? BLOCKS : kind]);
        triPiece.push(piece);
      }
    }
  }
  for (const child of node.children || []) emitNode(child, world);
}

for (const root of json.scenes[json.scene ?? 0].nodes) emitNode(root, IDENTITY);

if (unknown.size) {
  console.error(`unclassified pieces -- add them to OBSTACLE, WATER or GROUND:\n  ${[...unknown].join('\n  ')}`);
  process.exit(1);
}

const CELL = 1;
const EYE = 1.5;
const MIN_EYE = 0.5;
const STEP = 0.75;
const CLUSTER = 0.3;
const REACH = 0.1;
const KNEE = 0.5;
const HEAD = 1.6;
const WADE = 1.0;

const PATHY = new Set(['Carved Stone Walkway', 'Wood Light', 'Wood Light End', 'Wood Medium', 'Wood Dark']);

let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const [x0, , z0, x1, , z1, x2, , z2] of tris) {
  minX = Math.min(minX, x0, x1, x2); maxX = Math.max(maxX, x0, x1, x2);
  minZ = Math.min(minZ, z0, z1, z2); maxZ = Math.max(maxZ, z0, z1, z2);
}
const C0 = Math.floor(minX), R0 = Math.floor(minZ);
const COLS = Math.ceil(maxX) - C0, ROWS = Math.ceil(maxZ) - R0;

const BW = COLS + 2, BH = ROWS + 2;
const bx = (x) => Math.max(0, Math.min(BW - 1, Math.floor(x - C0) + 1));
const bz = (z) => Math.max(0, Math.min(BH - 1, Math.floor(z - R0) + 1));
const bins = Array.from({ length: BW * BH }, () => []);
const triBox = tris.map(([x0, y0, z0, x1, y1, z1, x2, y2, z2]) => [
  Math.min(x0, x1, x2), Math.min(y0, y1, y2), Math.min(z0, z1, z2),
  Math.max(x0, x1, x2), Math.max(y0, y1, y2), Math.max(z0, z1, z2),
]);
tris.forEach((_, t) => {
  const b = triBox[t];
  for (let iz = bz(b[2]); iz <= bz(b[5]); iz++)
    for (let ix = bx(b[0]); ix <= bx(b[3]); ix++) bins[iz * BW + ix].push(t);
});

// The one thing that stops you: an obstacle standing where you want to be. It
// has to stand more than knee high over your feet to count -- every kerb in
// the kit is a quarter high and every fence four fifths -- and it is asked of
// a point, a stride wide, rather than of a whole cell: a wall that leans into
// a cell without reaching the middle of it still leaves you somewhere to
// stand, and a fence laid along a cell line blocks the step across it without
// closing the cells to either side.
function inTheWay(x, z, y) {
  for (let iz = bz(z - REACH); iz <= bz(z + REACH); iz++)
    for (let ix = bx(x - REACH); ix <= bx(x + REACH); ix++)
      for (const t of bins[iz * BW + ix]) {
        if (tris[t][11] !== BLOCKS) continue;
        const b = triBox[t];
        if (b[3] < x - REACH || b[0] > x + REACH || b[5] < z - REACH || b[2] > z + REACH) continue;
        if (b[4] > y + KNEE && b[1] < y + HEAD) return true;
      }
  return false;
}

// The same question asked the whole way from one cell to the next, close
// enough together that nothing thin slips between two samples.
function inTheWayBetween(ax, az, ay, bx2, bz2, by) {
  const steps = Math.ceil(Math.hypot(bx2 - ax, bz2 - az) / REACH);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (inTheWay(ax + (bx2 - ax) * t, az + (bz2 - az) * t, ay + (by - ay) * t)) return true;
  }
  return false;
}

function heightsAt(x, z) {
  const hits = [];
  for (const t of bins[bz(z) * BW + bx(x)]) {
    const b = triBox[t];
    if (x < b[0] || x > b[3] || z < b[2] || z > b[5]) continue;
    const [x0, y0, z0, x1, y1, z1, x2, y2, z2, mat, up, kind] = tris[t];
    const d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
    if (Math.abs(d) < 1e-9) continue;
    const w0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / d;
    const w1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / d;
    const w2 = 1 - w0 - w1;
    if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
    hits.push([w0 * y0 + w1 * y1 + w2 * y2, mat, up, kind, t]);
  }
  return hits;
}

const seen = new Int32Array(tris.length);
let seenStamp = 0;
function raycast(ox, oy, oz, dx, dy, dz, tMin, tMax) {
  let best = Infinity;
  const stamp = ++seenStamp;
  const testBin = (ix, iz) => {
    if (ix < 0 || ix >= BW || iz < 0 || iz >= BH) return;
    for (const t of bins[iz * BW + ix]) {
      if (seen[t] === stamp) continue;
      seen[t] = stamp;
      const [x0, y0, z0, x1, y1, z1, x2, y2, z2] = tris[t];
      const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
      const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const tx = ox - x0, ty = oy - y0, tz = oz - z0;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (hit > tMin && hit < tMax && hit < best) best = hit;
    }
  };
  let ix = bx(ox), iz = bz(oz);
  const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  let tX = dx !== 0 ? ((C0 + (ix - 1) + (dx > 0 ? 1 : 0)) - ox) / dx : Infinity;
  let tZ = dz !== 0 ? ((R0 + (iz - 1) + (dz > 0 ? 1 : 0)) - oz) / dz : Infinity;
  const dX = dx !== 0 ? Math.abs(1 / dx) : Infinity, dZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let t = 0;
  for (let i = 0; i < BW + BH && t <= tMax && t < best; i++) {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) testBin(ix + a, iz + b);
    if (tX < tZ) { t = tX; tX += dX; ix += stepX; } else { t = tZ; tZ += dZ; iz += stepZ; }
  }
  return best;
}

function floorsAt(x, z) {
  const hits = heightsAt(x, z).filter((h) => h[2] > FLAT && h[3] <= CAVE).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (let i = 0; i < hits.length;) {
    let j = i;
    while (j + 1 < hits.length && hits[j + 1][0] - hits[j][0] <= CLUSTER) j++;
    out.push({ y: hits[j][0], mat: hits[j][1], up: hits[j][2], kind: hits[j][3] });
    i = j + 1;
  }
  return out;
}

// Nine samples over the cell: a floor has to be under most of it, so a cell
// with a hole in the middle of it is no floor at all.
const OFFSETS = [[0, 0], [0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35],
  [0.3, 0.3], [0.3, -0.3], [-0.3, 0.3], [-0.3, -0.3]];
const NEED = 5;

const reject = { hole: 0, obstacle: 0, wet: 0 };

function floorsIn(c, r, note) {
  const x = C0 + c + 0.5, z = R0 + r + 0.5;

  const flat = [];
  OFFSETS.forEach(([ox, oz], s) => floorsAt(x + ox, z + oz).forEach((f) => flat.push({ ...f, s })));
  if (!flat.length) return [];
  flat.sort((a, b) => a.y - b.y);

  const clusters = [];
  for (const f of flat) {
    const last = clusters[clusters.length - 1];
    if (last && f.y - last[last.length - 1].y <= 0.4) last.push(f);
    else clusters.push([f]);
  }

  const here = [];
  for (const k of clusters) {
    const y = k[Math.floor(k.length / 2)].y;
    const centre = k.find((f) => f.s === 0);
    const name = matName((centre || k[k.length - 1]).mat);

    const support = new Set(k.map((f) => f.s)).size;
    if (support < NEED) { reject.hole++; note?.(y, name, `only ${support} of ${OFFSETS.length} samples`); continue; }
    if (inTheWay(x, z, y)) { reject.obstacle++; note?.(y, name, 'an obstacle stands here'); continue; }
    if (heightsAt(x, z).some((h) => h[3] === WET && h[0] > y - 0.05 && h[0] < y + WADE)) {
      reject.wet++; note?.(y, name, 'under water'); continue;
    }

    const room = raycast(x, y + 0.2, z, 0, 1, 0, 0.001, 40);
    const eye = room === Infinity ? EYE : Math.max(MIN_EYE, Math.min(EYE, room - 0.5));
    note?.(y, name, 'open');
    here.push({ c, r, y, m: name, e: Math.round(eye * 100) / 100,
      home: room === Infinity || k.some((f) => f.kind === CAVE) });
  }
  return here;
}

const probeArg = process.argv.indexOf('--probe');
if (probeArg > 0) {
  const [px, pz] = process.argv[probeArg + 1].split(',').map(Number);
  const c = Math.floor(px) - C0, r = Math.floor(pz) - R0;
  console.log(`cell ${c},${r} -- centred on ${C0 + c + 0.5}, ${R0 + r + 0.5}`);
  console.log('surfaces under the centre:');
  for (const h of heightsAt(px, pz).sort((a, b) => a[0] - b[0]))
    console.log(`  y ${h[0].toFixed(3)}  ${matName(h[1]).padEnd(22)} tilt ${h[2].toFixed(2)}  ${['ground', 'cave floor', 'obstacle', 'water'][h[3]].padEnd(11)} ${triPiece[h[4]]}`);
  console.log('in the way of the point itself:');
  for (let iz = bz(pz - REACH); iz <= bz(pz + REACH); iz++)
    for (let ix = bx(px - REACH); ix <= bx(px + REACH); ix++)
      for (const t of bins[iz * BW + ix]) {
        if (tris[t][11] !== BLOCKS) continue;
        const b = triBox[t];
        if (b[3] < px - REACH || b[0] > px + REACH || b[5] < pz - REACH || b[2] > pz + REACH) continue;
        console.log(`  ${triPiece[t].padEnd(44)} y ${b[1].toFixed(2)}..${b[4].toFixed(2)}`);
      }
  console.log('floors:');
  floorsIn(c, r, (y, name, why) => console.log(`  y ${y.toFixed(3)}  ${name.padEnd(22)} ${why}`));
  process.exit(0);
}

const nodes = [];
const byCell = new Map();

for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const here = floorsIn(c, r);
    if (!here.length) continue;
    byCell.set(c * ROWS + r, here.map((n) => { n.i = nodes.length; nodes.push(n); return n; }));
  }
}

// Neighbouring floors join when the step between them is small enough and
// nothing stands between them -- the same question the cell itself was asked,
// put to every point along the way across.
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const corner = (c, r, a, b) =>
  (byCell.get(c * ROWS + r) || []).some((n) => Math.abs(n.y - a.y) <= STEP && Math.abs(n.y - b.y) <= STEP)
  || inTheWay(C0 + c + 0.5, R0 + r + 0.5, (a.y + b.y) / 2);
const edges = [];
const links = nodes.map(() => new Set());
for (const list of byCell.values()) {
  for (const a of list) {
    for (const [dc, dr] of DIRS) {
      const other = byCell.get((a.c + dc) * ROWS + (a.r + dr));
      if (!other) continue;
      const diag = dc !== 0 && dr !== 0;
      for (const b of other) {
        if (b.i <= a.i) continue;
        if (Math.abs(b.y - a.y) > STEP * (diag ? Math.SQRT2 : 1)) continue;
        if (inTheWayBetween(C0 + a.c + 0.5, R0 + a.r + 0.5, a.y, C0 + b.c + 0.5, R0 + b.r + 0.5, b.y)) continue;
        // A diagonal cuts a corner, and what sits in that corner decides
        // whether it may. Ground you could have walked round by, or rock
        // standing in the way: fine, you are squeezing past it. Open air is
        // not -- that corner is a brink, and cutting it walks you along the
        // edge of a cliff or round the end of a railing.
        if (diag && !(corner(a.c + dc, a.r, a, b) && corner(a.c, a.r + dr, a, b))) continue;
        links[a.i].add(b.i); links[b.i].add(a.i);
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

// Cut off patches: a patch that neither sees the sky nor stands on a cave
// floor is terrain sealed inside a mountain rather than a place to be.
const real = new Array(compCount).fill(false);
nodes.forEach((n, i) => { if (n.home) real[comp[i]] = true; });
const main = sizes.indexOf(Math.max(...sizes));
const MIN_COMP = 8;
const keep = nodes.map((_, i) => comp[i] === main || (real[comp[i]] && sizes[comp[i]] >= MIN_COMP));

if (process.argv.includes('--components')) {
  const box = new Map();
  nodes.forEach((n, i) => {
    const b = box.get(comp[i]) || { n: 0, x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9, y0: 1e9, y1: -1e9 };
    b.n++; b.x0 = Math.min(b.x0, C0 + n.c); b.x1 = Math.max(b.x1, C0 + n.c);
    b.z0 = Math.min(b.z0, R0 + n.r); b.z1 = Math.max(b.z1, R0 + n.r);
    b.y0 = Math.min(b.y0, n.y); b.y1 = Math.max(b.y1, n.y);
    box.set(comp[i], b);
  });
  [...box.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 14).forEach(([k, b]) =>
    console.log(`comp ${k}: ${b.n} cells  x ${b.x0}..${b.x1}  z ${b.z0}..${b.z1}  y ${b.y0.toFixed(1)}..${b.y1.toFixed(1)}  real ${real[k]}  ${k === main ? 'MAIN' : ''}`));
  process.exit(0);
}

const remap = new Map();
const outNodes = [];
nodes.forEach((n, i) => { if (keep[i]) { remap.set(i, outNodes.length); outNodes.push(n); } });
const outEdges = [];
for (let e = 0; e < edges.length; e += 2) {
  if (!keep[edges[e]] || !keep[edges[e + 1]]) continue;
  outEdges.push(remap.get(edges[e]), remap.get(edges[e + 1]));
}

const mats = [...new Set(outNodes.map((n) => n.m))].sort();
const matIndex = new Map(mats.map((m, i) => [m, i]));

const doc = {
  meta: {
    scene: input.split('/').pop(),
    cell: CELL,
    origin: { c: C0, r: R0 },
    size: { cols: COLS, rows: ROWS },
    eye: EYE,
    step: STEP,
    materials: mats,
    path: mats.map((m) => (PATHY.has(m) ? 1 : 0)),
  },

  nodes: outNodes.map((n) => [n.c, n.r, Math.round(n.y * 1000) / 1000, n.e, matIndex.get(n.m)]),
  edges: outEdges,
};

writeFileSync(outPath, JSON.stringify(doc));
const byMat = new Map();
for (const n of outNodes) byMat.set(n.m, (byMat.get(n.m) || 0) + 1);
console.log(`${outPath}: ${outNodes.length} cells, ${outEdges.length / 2} edges, ${COLS}x${ROWS} grid`);
console.log([...byMat.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', '));
console.log(`rejected: ${JSON.stringify(reject)}; dropped as unreachable: ${nodes.length - outNodes.length}`);
