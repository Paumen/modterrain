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

const GROUND = 0, SOLID = 1, LIQUID = 2;
const ROLES = [
  [GROUND, /^(Cave_Center_|Docks_(Decking|Ladder_Top)_|Floor_|Grass_|Path_(Bridge|End|Terrain)_|Prop_(Bridge_(Center|End)|Protrusion_Floor)_|Terrain_Sand_|Tiered_(Grass|Walkway)_)/],
  [LIQUID, /^(Terrain_Water_|Water_)/],
  [SOLID, /^(Basic_|Cave_Edge_|Ceiling_|Cracked_|Docks_(Bumper|Ladder_Middle|Railing|Support)_|Path_(Edging|Fence)_|Prop_(Bridge_Rope|Column|Stalactite|Stalagmite)_|Tiered_Retaining_Wall_|Wall_|Waterfall_)/],
];
const CLIFF = /^(Basic_|Cave_Edge_|Cracked_|Wall_)/;
const CARRIED = /^(Cave_Center_|Floor_|Path_(Bridge|End)_|Prop_(Bridge_(Center|End)|Protrusion_Floor)_|Tiered_Walkway_)/;
const DECK = /^Prop_Bridge_Rope_/;
const PLANK = new Set(['Wood Dark', 'Wood Light', 'Wood Light End', 'Wood Medium']);

const roleOf = (piece) => ROLES.find(([, re]) => re.test(piece))?.[0] ?? null;
const unknown = new Set();

const CELL = 1;
const EYE = 1.5;
const STEP = 0.75;
const CLUSTER = 0.3;
const RADIUS = 0.2;
const FOOT = 0.15;
const SUPPORT = 0.5;
const SPREAD = 0.3;
const SAMPLE = 0.1;
const STEP_OVER = 0.45;
const HEAD = 1.6;
const SLOPE = 0.5;

const pos = [];
const triMat = [];
const triUp = [];
const triRole = [];
const triPiece = [];
const triRock = [];
const cache = new Map();

function meshGeometry(prim) {
  const key = `${prim.attributes.POSITION}/${prim.indices ?? -1}`;
  let g = cache.get(key);
  if (!g) {
    g = { pos: accessorData(prim.attributes.POSITION), idx: prim.indices != null ? accessorData(prim.indices) : null };
    cache.set(key, g);
  }
  return g;
}

function emitNode(nodeIndex, parent) {
  const node = json.nodes[nodeIndex];
  const world = parent === IDENTITY && node.matrix ? node.matrix : mul4(parent, localMatrix(node));
  if (node.mesh != null) {
    const piece = (node.name || '').split('__')[0];
    const pieceRole = roleOf(piece);
    if (pieceRole === null) unknown.add(piece);
    else for (const prim of json.meshes[node.mesh].primitives) {
      if ((prim.mode ?? 4) !== 4 || isHidden(prim.material)) continue;
      const role = DECK.test(piece) && PLANK.has(matName(prim.material)) ? GROUND : pieceRole;
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
        pos.push(...p0, ...p1, ...p2);
        triMat.push(prim.material);
        triUp.push(ny / (Math.hypot(nx, ny, nz) || 1));
        triRole.push(role);
        triPiece.push(piece);
        triRock.push(CLIFF.test(piece) ? 1 : 0);
      }
    }
  }
  for (const child of node.children || []) emitNode(child, world);
}

for (const root of json.scenes[json.scene ?? 0].nodes) emitNode(root, IDENTITY);

if (unknown.size) {
  console.error(`unclassified pieces -- give them a role in ROLES:\n  ${[...unknown].join('\n  ')}`);
  process.exit(1);
}

const tris = Float64Array.from(pos);
pos.length = 0;
const index = buildIndex(tris, CELL);
const { box, bins, cols: BW, bx, bz } = index;

const PATHY = new Set(['Carved Stone Walkway', 'Wood Light', 'Wood Light End', 'Wood Medium', 'Wood Dark']);

let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (let t = 0; t < triRole.length; t++) {
  const b = t * 6;
  minX = Math.min(minX, box[b]); maxX = Math.max(maxX, box[b + 3]);
  minZ = Math.min(minZ, box[b + 2]); maxZ = Math.max(maxZ, box[b + 5]);
}
const C0 = Math.floor(minX), R0 = Math.floor(minZ);
const COLS = Math.ceil(maxX) - C0, ROWS = Math.ceil(maxZ) - R0;

const clip = [new Float64Array(16), new Float64Array(16)];

function clipTo(src, n, dst, axis, limit, keepBelow) {
  const inside = (v) => (keepBelow ? v <= limit : v >= limit);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const vi = src[i * 2 + axis], vj = src[j * 2 + axis];
    if (inside(vi)) { dst[m * 2] = src[i * 2]; dst[m * 2 + 1] = src[i * 2 + 1]; m++; }
    if (inside(vi) !== inside(vj)) {
      const f = (limit - vi) / (vj - vi);
      dst[m * 2] = src[i * 2] + (src[j * 2] - src[i * 2]) * f;
      dst[m * 2 + 1] = src[i * 2 + 1] + (src[j * 2 + 1] - src[i * 2 + 1]) * f;
      m++;
    }
  }
  return m;
}

const span = [0, 0];

function spanOver(t, x0, x1, z0, z1) {
  const a = t * 9, b = t * 6;
  const ax = tris[a], ay = tris[a + 1], az = tris[a + 2];
  const ex = tris[a + 3] - ax, ey = tris[a + 4] - ay, ez = tris[a + 5] - az;
  const fx = tris[a + 6] - ax, fy = tris[a + 7] - ay, fz = tris[a + 8] - az;
  const first = clip[0];
  first[0] = ax; first[1] = az;
  first[2] = tris[a + 3]; first[3] = tris[a + 5];
  first[4] = tris[a + 6]; first[5] = tris[a + 8];
  let n = 3, from = 0;
  for (const [axis, limit, keepBelow] of [[0, x0, false], [0, x1, true], [1, z0, false], [1, z1, true]]) {
    n = clipTo(clip[from], n, clip[1 - from], axis, limit, keepBelow);
    from = 1 - from;
    if (!n) return null;
  }
  const ny = ez * fx - ex * fz;
  if (Math.abs(ny) < 1e-9) { span[0] = box[b + 1]; span[1] = box[b + 4]; return span; }
  const nx = ey * fz - ez * fy, nz = ex * fy - ey * fx;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = ay - (nx * (clip[from][i * 2] - ax) + nz * (clip[from][i * 2 + 1] - az)) / ny;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  span[0] = Math.max(lo, box[b + 1]);
  span[1] = Math.min(hi, box[b + 4]);
  return span;
}

function intrudes(x0, x1, z0, z1, lo, hi, skip, report) {
  for (let iz = bz(z0); iz <= bz(z1); iz++)
    for (let ix = bx(x0); ix <= bx(x1); ix++)
      for (const t of bins[iz * BW + ix]) {
        if (skip(t)) continue;
        const b = t * 6;
        if (box[b + 3] < x0 || box[b] > x1 || box[b + 5] < z0 || box[b + 2] > z1) continue;
        if (box[b + 4] <= lo || box[b + 1] >= hi) continue;
        const reach = spanOver(t, x0, x1, z0, z1);
        if (!reach || reach[1] <= lo || reach[0] >= hi) continue;
        if (!report) return true;
        report(t);
      }
  return false;
}

const isLiquid = (t) => triRole[t] === LIQUID;
const notRock = (t) => !triRock[t];

function blocked(x, z, y, rad = RADIUS, report) {
  return intrudes(x - rad, x + rad, z - rad, z + rad, y + STEP_OVER, y + HEAD, isLiquid, report);
}

const ROOM = [RADIUS, RADIUS + 0.1];

function clearance(x, z, y) {
  let room = 0;
  while (room < ROOM.length && !blocked(x, z, y, ROOM[room])) room++;
  return room;
}

function sweep(ax, az, ay, bx2, bz2, by) {
  const steps = Math.ceil(Math.hypot(bx2 - ax, bz2 - az) / SAMPLE);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (blocked(ax + (bx2 - ax) * t, az + (bz2 - az) * t, ay + (by - ay) * t)) return true;
  }
  return false;
}

const BOW = [0.18, -0.18, 0.32, -0.32];

function blockedBetween(a, b) {
  if (!sweep(a.x, a.z, a.y, b.x, b.z, b.y)) return false;
  const mid = (a.y + b.y) / 2;
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const px = (b.z - a.z) / len, pz = -(b.x - a.x) / len;
  for (const off of BOW) {
    const cx = (a.x + b.x) / 2 + px * off, cz = (a.z + b.z) / 2 + pz * off;
    if (!sweep(a.x, a.z, a.y, cx, cz, mid) && !sweep(cx, cz, mid, b.x, b.z, b.y)) return false;
  }
  return true;
}

const columns = new Map();

function surfaces(x, z) {
  const key = `${Math.round(x * 100)},${Math.round(z * 100)}`;
  let hits = columns.get(key);
  if (hits) return hits;
  hits = [];
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
    if (Math.abs(triUp[t]) < SLOPE) continue;
    hits.push([w0 * y0 + w1 * y1 + w2 * y2, t]);
  }
  hits.sort((p, q) => p[0] - q[0]);
  columns.set(key, hits);
  return hits;
}

const upward = (t, role) => triRole[t] === role && triUp[t] >= SLOPE;

function floorsAt(x, z) {
  const out = [];
  for (const h of surfaces(x, z)) {
    if (!upward(h[1], GROUND)) continue;
    const last = out[out.length - 1];
    if (last && h[0] - last.low <= CLUSTER) { last.y = h[0]; last.t = h[1]; }
    else out.push({ low: h[0], y: h[0], t: h[1] });
  }
  return out;
}

const CORNERS = [[FOOT, FOOT], [FOOT, -FOOT], [-FOOT, FOOT], [-FOOT, -FOOT]];

function underfoot(x, z, y) {
  for (const [dx, dz] of CORNERS)
    if (!surfaces(x + dx, z + dz).some((h) => upward(h[1], GROUND) && Math.abs(h[0] - y) <= SUPPORT)) return false;
  return true;
}

function drowned(x, z, y, ceiling) {
  const top = Math.min(ceiling, y + HEAD);
  return surfaces(x, z).some((h) => upward(h[1], LIQUID) && h[0] > y + 0.02 && h[0] < top);
}

function buried(x, z, y) {
  for (const h of surfaces(x, z))
    if (h[0] > y + 0.05 && triRole[h[1]] !== LIQUID) return triUp[h[1]] > 0;
  return false;
}

const SPOTS = [[0, 0], [SPREAD, 0], [-SPREAD, 0], [0, SPREAD], [0, -SPREAD],
  [SPREAD * 0.7, SPREAD * 0.7], [SPREAD * 0.7, -SPREAD * 0.7], [-SPREAD * 0.7, SPREAD * 0.7], [-SPREAD * 0.7, -SPREAD * 0.7]];

function cliffInCell(c, r, y) {
  const x0 = C0 + c, z0 = R0 + r;
  return intrudes(x0, x0 + 1, z0, z0 + 1, y - CLUSTER, y + HEAD, notRock);
}

const reject = { water: 0, buried: 0, cliff: 0, unsupported: 0, blocked: 0 };

function nodesIn(c, r, note) {
  const cx = C0 + c + 0.5, cz = R0 + r + 0.5;
  const here = [];
  for (const [dx, dz] of SPOTS) {
    const x = cx + dx, z = cz + dz;
    const floors = floorsAt(x, z);
    for (let i = 0; i < floors.length; i++) {
      const y = floors[i].y;
      const name = matName(triMat[floors[i].t]);
      const say = (why) => note?.(dx, dz, y, name, why);
      if (!CARRIED.test(triPiece[floors[i].t]) && cliffInCell(c, r, y)) { reject.cliff++; say('a cliff stands in this cell'); continue; }
      if (drowned(x, z, y, floors[i + 1]?.low ?? Infinity)) { reject.water++; say('water covers this'); continue; }
      if (buried(x, z, y)) { reject.buried++; say('this is the far side of a shell'); continue; }
      if (!underfoot(x, z, y)) { reject.unsupported++; say('too narrow to stand on'); continue; }
      const level = here.find((n) => Math.abs(n.y - y) <= CLUSTER);
      if (level && level.room === ROOM.length) continue;
      const room = clearance(x, z, y);
      if (!room) {
        reject.blocked++;
        const names = new Set();
        if (note) blocked(x, z, y, RADIUS, (t) => names.add(triPiece[t]));
        say(`blocked by ${[...names].join(', ')}`);
        continue;
      }
      say(`open, room ${room}`);
      if (!level) here.push({ c, r, x, z, y, room, m: name });
      else if (room > level.room) Object.assign(level, { x, z, y, room, m: name });
    }
  }
  for (const n of here) n.home = raycast(index, n.x, n.y + 0.2, n.z, 0, 1, 0, 40) === Infinity;
  return here.sort((a, b) => a.y - b.y);
}

const probeArg = process.argv.indexOf('--probe');
if (probeArg > 0) {
  const [px, pz] = process.argv[probeArg + 1].split(',').map(Number);
  const c = Math.floor(px) - C0, r = Math.floor(pz) - R0;
  console.log(`cell ${c},${r} -- centred on ${C0 + c + 0.5}, ${R0 + r + 0.5}`);
  console.log('surfaces under the centre:');
  const ROLE_NAME = ['ground', 'solid', 'liquid'];
  for (const h of surfaces(C0 + c + 0.5, R0 + r + 0.5))
    console.log(`  y ${h[0].toFixed(3)}  ${matName(triMat[h[1]]).padEnd(22)} tilt ${triUp[h[1]].toFixed(2)}  ${ROLE_NAME[triRole[h[1]]].padEnd(7)} ${triPiece[h[1]]}`);
  console.log('spots:');
  for (const n of nodesIn(c, r, (dx, dz, y, name, why) =>
    console.log(`  ${dx >= 0 ? '+' : ''}${dx.toFixed(2)},${dz >= 0 ? '+' : ''}${dz.toFixed(2)}  y ${y.toFixed(3)}  ${name.padEnd(22)} ${why}`))) {
    console.log(`node at ${n.x.toFixed(2)},${n.z.toFixed(2)} y ${n.y.toFixed(3)} ${n.m}${n.home ? ' (open sky)' : ''}`);
    const seen = new Set();
    blocked(n.x, n.z, n.y, ROOM.at(-1), (t) => {
      if (seen.has(triPiece[t])) return;
      seen.add(triPiece[t]);
      console.log(`  would block: ${triPiece[t]}`);
    });
  }
  process.exit(0);
}

const nodes = [];
const byCell = new Map();

for (let r = 0; r < ROWS; r++) {
  columns.clear();
  for (let c = 0; c < COLS; c++) {
    const here = nodesIn(c, r);
    if (!here.length) continue;
    byCell.set(c * ROWS + r, here.map((n) => { n.i = nodes.length; nodes.push(n); return n; }));
  }
}

const DIRS = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const corner = (c, r, a, b) =>
  (byCell.get(c * ROWS + r) || []).some((n) => Math.abs(n.y - a.y) <= STEP && Math.abs(n.y - b.y) <= STEP)
  || blocked(C0 + c + 0.5, R0 + r + 0.5, (a.y + b.y) / 2);
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
        if (blockedBetween(a, b)) continue;
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
const round = (v) => Math.round(v * 1000) / 1000;

const doc = {
  meta: {
    scene: input.split('/').pop(),
    cell: CELL,
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
console.log(`${outPath}: ${outNodes.length} cells, ${outEdges.length / 2} edges, ${COLS}x${ROWS} grid`);
console.log([...byMat.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', '));
console.log(`rejected: ${JSON.stringify(reject)}; dropped as unreachable: ${nodes.length - outNodes.length}`);
