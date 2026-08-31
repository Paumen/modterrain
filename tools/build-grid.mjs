import { readGlb } from './glb.mjs';
import { buildIndex, raycast } from './ray.mjs';
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

const CAVE_FLOOR = /^Floor_/;
const WALKABLE = /^(Docks_(Decking|Ladder_Top)_|Grass_|Path_(Bridge|Terrain)_|Prop_(Bridge|Protrusion_Floor)_|Terrain_Sand_|Tiered_(Grass|Walkway)_|Floor_)/;
const WATER = /^(Terrain_Water_|Water_|Waterfall_)/;
const BLOCKING = /^(Basic_|Cave_|Ceiling_|Cracked_|Docks_(Bumper|Ladder_Middle|Railing|Support)_|Path_Edging_|Path_Fence_|Prop_(Column|Stalactite|Stalagmite)_|Tiered_Retaining_Wall_|Wall_)/;

function classify(piece) {
  if (WALKABLE.test(piece)) return { blocking: false, cave: CAVE_FLOOR.test(piece) };
  if (WATER.test(piece)) return { blocking: true, cave: false, water: true };
  if (BLOCKING.test(piece)) return { blocking: true, cave: false };
  return null;
}
const unknown = new Set();

const CELL = 1;
const EYE = 1.5;
const STEP = 0.75;
const REACH = 0.2;
const KNEE = 0.5;
const HEAD = 1.6;
const GAP = 0.12;

const pos = [];
const triMat = [];
const triUp = [];
const triBlocking = [];
const triCave = [];
const triWater = [];
const triPiece = [];
const originX = [];
const originZ = [];
const cache = new Map();

function meshGeometry(prim) {
  const key = `${prim.attributes.POSITION}/${prim.indices ?? -1}`;
  let g = cache.get(key);
  if (!g) g = cache.set(key, (g = { pos: accessorData(prim.attributes.POSITION), idx: prim.indices != null ? accessorData(prim.indices) : null })).get(key);
  return g;
}

function emitNode(nodeIndex, parent) {
  const node = json.nodes[nodeIndex];
  const world = parent === IDENTITY && node.matrix ? node.matrix : mul4(parent, localMatrix(node));
  if (node.mesh != null) {
    const piece = (node.name || '').split('__')[0];
    const kind = classify(piece);
    if (kind === null) unknown.add(piece);
    else {
      originX.push(world[12]);
      originZ.push(world[14]);
      for (const prim of json.meshes[node.mesh].primitives) {
        if ((prim.mode ?? 4) !== 4 || isHidden(prim.material)) continue;
        const { pos: src, idx } = meshGeometry(prim);
        const count = idx ? idx.length : src.length / 3;
        for (let t = 0; t < count; t += 3) {
          const i0 = idx ? idx[t] : t, i1 = idx ? idx[t + 1] : t + 1, i2 = idx ? idx[t + 2] : t + 2;
          const p0 = xformPoint(world, src[i0 * 3], src[i0 * 3 + 1], src[i0 * 3 + 2]);
          const p1 = xformPoint(world, src[i1 * 3], src[i1 * 3 + 1], src[i1 * 3 + 2]);
          const p2 = xformPoint(world, src[i2 * 3], src[i2 * 3 + 1], src[i2 * 3 + 2]);
          const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
          const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
          const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
          const up = ny / (Math.hypot(nx, ny, nz) || 1);
          pos.push(...p0, ...p1, ...p2);
          triMat.push(prim.material);
          triUp.push(up);
          triBlocking.push(kind.blocking);
          triCave.push(kind.cave);
          triWater.push(!!kind.water);
          triPiece.push(piece);
        }
      }
    }
  }
  for (const child of node.children || []) emitNode(child, world);
}

for (const root of json.scenes[json.scene ?? 0].nodes) emitNode(root, IDENTITY);

if (unknown.size) {
  console.error(`unclassified pieces -- add them to WALKABLE or BLOCKING:\n  ${[...unknown].join('\n  ')}`);
  process.exit(1);
}

const tris = Float64Array.from(pos);
pos.length = 0;
const index = buildIndex(tris, CELL);
const { box, bins, cols: BW, bx, bz } = index;

const PATHY = new Set(['Carved Stone Walkway', 'Wood Light', 'Wood Light End', 'Wood Medium', 'Wood Dark']);

let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (let t = 0; t < triBlocking.length; t++) {
  const b = t * 6;
  minX = Math.min(minX, box[b]); maxX = Math.max(maxX, box[b + 3]);
  minZ = Math.min(minZ, box[b + 2]); maxZ = Math.max(maxZ, box[b + 5]);
}
function modalPhase(values) {
  const tally = new Map();
  for (const v of values) {
    const half = Math.round((((v % 1) + 1) % 1) * 2) % 2 ? 0.5 : 0;
    tally.set(half, (tally.get(half) || 0) + 1);
  }
  return (tally.get(0.5) || 0) >= (tally.get(0) || 0) ? 0.5 : 0;
}

const PX = modalPhase(originX), PZ = modalPhase(originZ);
const C0 = Math.floor(minX), R0 = Math.floor(minZ);
const COLS = Math.floor(maxX - PX - C0) + 1, ROWS = Math.floor(maxZ - PZ - R0) + 1;

function inTheWay(x, z, y) {
  for (let iz = bz(z - REACH); iz <= bz(z + REACH); iz++)
    for (let ix = bx(x - REACH); ix <= bx(x + REACH); ix++)
      for (const t of bins[iz * BW + ix]) {
        if (!triBlocking[t]) continue;
        const b = t * 6;
        if (box[b + 3] < x - REACH || box[b] > x + REACH || box[b + 5] < z - REACH || box[b + 2] > z + REACH) continue;
        if (box[b + 4] > y + KNEE && box[b + 1] < y + HEAD) return true;
      }
  return false;
}

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
    const b = t * 6;
    if (x < box[b] || x > box[b + 3] || z < box[b + 2] || z > box[b + 5]) continue;
    const a = t * 9;
    const x0 = tris[a], y0 = tris[a + 1], z0 = tris[a + 2];
    const x1 = tris[a + 3], y1 = tris[a + 4], z1 = tris[a + 5];
    const x2 = tris[a + 6], y2 = tris[a + 7], z2 = tris[a + 8];
    const d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
    if (Math.abs(d) < 1e-9) continue;
    const w0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / d;
    const w1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / d;
    const w2 = 1 - w0 - w1;
    if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
    if (triUp[t] <= 0) continue;
    hits.push([w0 * y0 + w1 * y1 + w2 * y2, triMat[t], triUp[t], triBlocking[t], triCave[t], t]);
  }
  return hits;
}

function floorAt(x, z) {
  const hits = heightsAt(x, z).sort((a, b) => a[0] - b[0]);
  const waterY = hits.filter((h) => triWater[h[5]]).reduce((max, h) => Math.max(max, h[0]), -Infinity);
  const out = [];
  for (const h of hits) {
    if (h[3]) continue;
    if (h[0] < waterY - 1e-3) continue;
    if (out.length && h[0] - out[out.length - 1].y <= 1e-3) continue;
    out.push({ y: h[0], mat: h[1], blocking: h[3], cave: h[4] });
  }
  return out;
}

const reject = { obstacle: 0 };

const NUDGE = [[0, 0], [GAP, 0], [-GAP, 0], [0, GAP], [0, -GAP], [GAP, GAP], [-GAP, -GAP], [GAP, -GAP], [-GAP, GAP]];

function floorsIn(c, r, note) {
  const cx = C0 + c + PX, cz = R0 + r + PZ;
  let best = [], x = cx, z = cz;
  for (const [dx, dz] of NUDGE) {
    const found = floorAt(cx + dx, cz + dz);
    if (found.length > best.length) { best = found; x = cx + dx; z = cz + dz; }
  }
  const here = [];
  for (const f of best) {
    const name = matName(f.mat);
    if (inTheWay(x, z, f.y)) { reject.obstacle++; note?.(f.y, name, 'an obstacle stands here'); continue; }
    note?.(f.y, name, 'open');
    here.push({ c, r, y: f.y, m: name,
      home: raycast(index, x, f.y + 0.2, z, 0, 1, 0, 40) === Infinity || f.cave });
  }
  return here;
}

const probeArg = process.argv.indexOf('--probe');
if (probeArg > 0) {
  const [px, pz] = process.argv[probeArg + 1].split(',').map(Number);
  const c = Math.floor(px - C0 - PX + 0.5), r = Math.floor(pz - R0 - PZ + 0.5);
  console.log(`cell ${c},${r} -- centred on ${C0 + c + PX}, ${R0 + r + PZ}`);
  console.log('surfaces under the centre:');
  for (const h of heightsAt(px, pz).sort((a, b) => a[0] - b[0]))
    console.log(`  y ${h[0].toFixed(3)}  ${matName(h[1]).padEnd(22)} tilt ${h[2].toFixed(2)}  ${(h[3] ? 'blocking' : h[4] ? 'cave floor' : 'walkable').padEnd(11)} ${triPiece[h[5]]}`);
  console.log('in the way of the point itself:');
  for (let iz = bz(pz - REACH); iz <= bz(pz + REACH); iz++)
    for (let ix = bx(px - REACH); ix <= bx(px + REACH); ix++)
      for (const t of bins[iz * BW + ix]) {
        if (!triBlocking[t]) continue;
        const b = t * 6;
        if (box[b + 3] < px - REACH || box[b] > px + REACH || box[b + 5] < pz - REACH || box[b + 2] > pz + REACH) continue;
        console.log(`  ${triPiece[t].padEnd(44)} y ${box[b + 1].toFixed(2)}..${box[b + 4].toFixed(2)}`);
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

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const corner = (c, r, a, b) =>
  (byCell.get(c * ROWS + r) || []).some((n) => Math.abs(n.y - a.y) <= STEP && Math.abs(n.y - b.y) <= STEP)
  || inTheWay(C0 + c + PX, R0 + r + PZ, (a.y + b.y) / 2);
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
        if (inTheWayBetween(C0 + a.c + PX, R0 + a.r + PZ, a.y, C0 + b.c + PX, R0 + b.r + PZ, b.y)) continue;
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

const real = new Array(compCount).fill(false);
nodes.forEach((n, i) => { if (n.home) real[comp[i]] = true; });
const main = sizes.reduce((best, n, i) => (n > sizes[best] ? i : best), 0);
const MIN_COMP = 8;
const keep = nodes.map((_, i) => comp[i] === main || (real[comp[i]] && sizes[comp[i]] >= MIN_COMP));

if (process.argv.includes('--components')) {
  const box2 = new Map();
  nodes.forEach((n, i) => {
    const b = box2.get(comp[i]) || { n: 0, x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9, y0: 1e9, y1: -1e9 };
    b.n++; b.x0 = Math.min(b.x0, C0 + n.c); b.x1 = Math.max(b.x1, C0 + n.c);
    b.z0 = Math.min(b.z0, R0 + n.r); b.z1 = Math.max(b.z1, R0 + n.r);
    b.y0 = Math.min(b.y0, n.y); b.y1 = Math.max(b.y1, n.y);
    box2.set(comp[i], b);
  });
  [...box2.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 14).forEach(([k, b]) =>
    console.log(`comp ${k}: ${b.n} cells  x ${b.x0}..${b.x1}  z ${b.z0}..${b.z1}  y ${b.y0.toFixed(1)}..${b.y1.toFixed(1)}  real ${real[k]}  ${k === main ? 'MAIN' : ''}`));
  process.exit(0);
}

const order = [];
nodes.forEach((_, i) => { if (keep[i] && comp[i] === main) order.push(i); });
const mainCount = order.length;
nodes.forEach((_, i) => { if (keep[i] && comp[i] !== main) order.push(i); });
const remap = new Map(order.map((i, k) => [i, k]));
const outNodes = order.map((i) => nodes[i]);
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
    phase: { x: PX, z: PZ },
    size: { cols: COLS, rows: ROWS },
    eye: EYE,
    step: STEP,
    main: mainCount,
    materials: mats,
    path: mats.map((m) => (PATHY.has(m) ? 1 : 0)),
  },

  nodes: outNodes.map((n) => [n.c, n.r, Math.round(n.y * 1000) / 1000, matIndex.get(n.m)]),
  edges: outEdges,
};

writeFileSync(outPath, JSON.stringify(doc));
const byMat = new Map();
for (const n of outNodes) byMat.set(n.m, (byMat.get(n.m) || 0) + 1);
console.log(`${outPath}: ${outNodes.length} cells, ${outEdges.length / 2} edges, ${COLS}x${ROWS} grid`);
console.log([...byMat.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', '));
console.log(`rejected: ${JSON.stringify(reject)}; dropped as unreachable: ${nodes.length - outNodes.length}`);
