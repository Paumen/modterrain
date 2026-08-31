import { readGlb } from './glb.mjs';
import { writeFileSync, existsSync } from 'node:fs';

const input = process.argv[2];
if (!input) {
  console.error('usage: node tools/build-grid.mjs <scene.glb> [--force]');
  process.exit(1);
}
const force = process.argv.includes('--force');
const outPath = input.replace(/\.glb$/, '_grid.json');
const READ_ONLY = ['--probe', '--slopes', '--door', '--components'].some((f) => process.argv.includes(f));
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

const tris = [];
const cache = new Map();

const DECK = /^(Prop_Bridge_|Path_Bridge_|Docks_Decking_|Docks_Ladder_Top)/;
const decks = [];

const CAVE = /^(Cave_|Floor_)/;
const caves = [];

const ROCK = /^(Basic_|Wall_|Cracked_|Tiered_Retaining_Wall_|Prop_Column_|Prop_Stalagmite_)/;

function notePiece(node, world) {
  const into = DECK.test(node.name || '') ? decks : CAVE.test(node.name || '') ? caves : null;
  if (!into) return;
  for (const prim of json.meshes[node.mesh].primitives) {
    const acc = json.accessors[prim.attributes.POSITION];
    if (!acc?.min || !acc?.max) continue;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let corner = 0; corner < 8; corner++) {
      const p = xformPoint(world,
        (corner & 1 ? acc.max : acc.min)[0], (corner & 2 ? acc.max : acc.min)[1], (corner & 4 ? acc.max : acc.min)[2]);
      for (let a = 0; a < 3; a++) { if (p[a] < lo[a]) lo[a] = p[a]; if (p[a] > hi[a]) hi[a] = p[a]; }
    }
    into.push([...lo, ...hi]);
    return;
  }
}

function meshGeometry(prim) {
  const key = `${prim.attributes.POSITION}/${prim.indices ?? -1}`;
  let g = cache.get(key);
  if (!g) g = cache.set(key, (g = { pos: accessorData(prim.attributes.POSITION), idx: prim.indices != null ? accessorData(prim.indices) : null })).get(key);
  return g;
}

const BARRIER = /^(Path_Fence_|Docks_Railing_|Docks_Bumper_)/;
const WATER = /^(Terrain_Water_|Water_|Waterfall_)/;
const MASS = /^(Basic_|Cave_|Ceiling_|Docks_(Decking|Support|Ladder)_|Floor_|Grass_|Path_(Bridge|Edging|Terrain)_|Prop_|Terrain_Sand_|Tiered_|Wall_)/;
const unknown = new Set();
function kindOf(piece) {
  if (BARRIER.test(piece)) return 'barrier';
  if (WATER.test(piece)) return 'water';
  if (MASS.test(piece)) return 'mass';
  unknown.add(piece);
  return 'mass';
}

function emitNode(nodeIndex, parent) {
  const node = json.nodes[nodeIndex];
  const world = parent === IDENTITY && node.matrix ? node.matrix : mul4(parent, localMatrix(node));
  if (node.mesh != null) {
    const piece = (node.name || '').split('__')[0];
    const kind = kindOf(piece);

    const bridge = /^Prop_Bridge_/.test(piece);
    notePiece(node, world);
    for (const prim of json.meshes[node.mesh].primitives) {
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

        const len = Math.hypot(nx, ny, nz) || 1;
        const up = ny / len;
        const railing = bridge && Math.abs(up) < 0.5;
        const gateway = /^Path_Fence_Gate_Frame_/.test(piece);

        const rock = ROCK.test(piece);
        const stops = (rock && Math.abs(up) < 0.5) || (!gateway && (kind === 'barrier' || railing));

        tris.push([...p0, ...p1, ...p2, prim.material, up, stops, rock]);
      }
    }
  }
  for (const child of node.children || []) emitNode(child, world);
}

for (const root of json.scenes[json.scene ?? 0].nodes) emitNode(root, IDENTITY);

if (unknown.size) {
  console.error(`unclassified pieces -- add them to BARRIER, WATER or MASS:\n  ${[...unknown].join('\n  ')}`);
  process.exit(1);
}

const CELL = 1;
const EYE = 3.6;
const MIN_EYE = 1.5;
const HEAD = 2.0;
const STEP = 0.75;
const FLAT = 0.5;
const CLUSTER = 0.3;

const WALKABLE = new Set(['Grass', 'Dirt', 'Cliff', 'Carved Stone Walkway', 'Wood Light', 'Wood Light End', 'Wood Medium', 'Wood Dark']);
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

function heightsAt(x, z) {
  const hits = [];
  for (const t of bins[bz(z) * BW + bx(x)]) {
    const b = triBox[t];
    if (x < b[0] || x > b[3] || z < b[2] || z > b[5]) continue;
    const [x0, y0, z0, x1, y1, z1, x2, y2, z2, mat, up, , rock] = tris[t];
    const d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
    if (Math.abs(d) < 1e-9) continue;
    const w0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / d;
    const w1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / d;
    const w2 = 1 - w0 - w1;
    if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
    hits.push([w0 * y0 + w1 * y1 + w2 * y2, mat, up, rock]);
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

const probeArg = process.argv.indexOf('--probe');

function floorsAt(x, z) {
  const hits = heightsAt(x, z).filter((h) => h[2] > FLAT && !h[3]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (let i = 0; i < hits.length;) {
    let j = i;
    while (j + 1 < hits.length && hits[j + 1][0] - hits[j][0] <= CLUSTER) j++;
    out.push({ y: hits[j][0], mat: hits[j][1], up: hits[j][2] });
    i = j + 1;
  }
  return out;
}

const OFFSETS = [[0, 0], [0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35],
  [0.3, 0.3], [0.3, -0.3], [-0.3, 0.3], [-0.3, -0.3]];
const NEED = 5;

function ceilingAt(x, z, y) {
  const rays = OFFSETS.map(([ox, oz]) => raycast(x + ox, y + 0.2, z + oz, 0, 1, 0, 0.001, 40));
  rays.sort((a, b) => a - b);
  const mid = rays[rays.length >> 1];
  return mid === Infinity ? Infinity : mid + 0.2;
}

const reject = { support: 0, head: 0 };

const inBox = (list, x, z, y) => list.some((d) =>
  x >= d[0] && x <= d[3] && z >= d[2] && z <= d[5] && y >= d[1] - 0.1 && y <= d[4] + 0.1);
const onDeck = (x, z, y) => inBox(decks, x, z, y);
const inCave = (x, z, y) => inBox(caves, x, z, y);

function floorsIn(c, r, note) {
  const x = C0 + c + 0.5, z = R0 + r + 0.5;

  const samples = OFFSETS.map(([ox, oz]) => floorsAt(x + ox, z + oz));
  const flat = [];
  samples.forEach((list, s) => list.forEach((f) => flat.push({ ...f, s })));
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

    const good = k.filter((f) => WALKABLE.has(matName(f.mat)));
    const y = good.length ? good[Math.floor(good.length / 2)].y : k[k.length - 1].y;
    const label = matName(k[k.length - 1].mat);
    if (!good.length) { note?.(y, label, 'nothing walkable'); continue; }
    const support = new Set(good.map((f) => f.s)).size;
    const need = onDeck(x, z, y) ? 1 : NEED;
    if (support < need) { reject.support++; note?.(y, label, `only ${support} of ${OFFSETS.length} samples`); continue; }

    const tally = new Map();
    for (const f of good) tally.set(matName(f.mat), (tally.get(matName(f.mat)) || 0) + 1);
    const centre = good.find((f) => f.s === 0);
    const name = centre ? matName(centre.mat) : [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];

    const room = ceilingAt(x, z, y);
    if (room < HEAD) { reject.head++; note?.(y, name, `ceiling only ${room.toFixed(2)} up`); continue; }
    const eye = room === Infinity ? EYE : Math.max(MIN_EYE, Math.min(EYE, room - 1.8));
    note?.(y, name, 'open');
    here.push({ c, r, y, m: name, e: Math.round(eye * 100) / 100, tilt: Math.min(...good.map((f) => f.up)) });
  }
  return here;
}

if (probeArg > 0) {
  const [px, pz] = process.argv[probeArg + 1].split(',').map(Number);
  const c = Math.floor(px) - C0, r = Math.floor(pz) - R0;
  console.log(`cell ${c},${r} -- centred on ${C0 + c + 0.5}, ${R0 + r + 0.5}`);
  console.log('surfaces under the centre:');
  for (const h of heightsAt(px, pz).sort((a, b) => a[0] - b[0]))
    console.log(`  y ${h[0].toFixed(3)}  ${matName(h[1]).padEnd(22)} tilt ${h[2].toFixed(2)}${h[3] ? '  rock' : ''}`);
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

const DOOR_LOW = 0.5;
const DOOR_HIGH = 1.8;

function doorwayClear(a, b) {
  const ax = C0 + a.c + 0.5, az = R0 + a.r + 0.5;
  const cx2 = C0 + b.c + 0.5, cz2 = R0 + b.r + 0.5;
  let dx = cx2 - ax, dz = cz2 - az;
  const span = Math.hypot(dx, dz);
  dx /= span; dz /= span;

  const s0 = 0, s1 = span;
  const yLow = Math.min(a.y, b.y) + DOOR_LOW, yHigh = Math.max(a.y, b.y) + DOOR_HIGH;
  const nx = -dz, nz = dx;
  const nd = nx * ax + nz * az;

  const cx = (ax + cx2) / 2, cz = (az + cz2) / 2;
  const reach = Math.ceil(span / 2) + 1;
  const hits = new Set();
  for (let iz = bz(cz - reach); iz <= bz(cz + reach); iz++)
    for (let ix = bx(cx - reach); ix <= bx(cx + reach); ix++)
      for (const t of bins[iz * BW + ix]) hits.add(t);

  for (const t of hits) {
    if (!tris[t][11]) continue;
    const box = triBox[t];
    if (box[4] < yLow || box[1] > yHigh) continue;
    const p = [[tris[t][0], tris[t][1], tris[t][2]], [tris[t][3], tris[t][4], tris[t][5]], [tris[t][6], tris[t][7], tris[t][8]]];

    const d = p.map((v) => nx * v[0] + nz * v[2] - nd);
    if ((d[0] > 0 && d[1] > 0 && d[2] > 0) || (d[0] < 0 && d[1] < 0 && d[2] < 0)) continue;
    const pts = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      if ((d[i] > 0) === (d[j] > 0) || d[i] === d[j]) continue;
      const f = d[i] / (d[i] - d[j]);
      const x = p[i][0] + (p[j][0] - p[i][0]) * f;
      const y = p[i][1] + (p[j][1] - p[i][1]) * f;
      const z = p[i][2] + (p[j][2] - p[i][2]) * f;
      pts.push([(x - ax) * dx + (z - az) * dz, y]);
    }
    if (pts.length < 2) continue;

    let t0 = 0, t1 = 1;
    const q = [pts[0][0], pts[0][1]], v = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]];
    let out = false;
    for (const [dir, lo, hi] of [[0, s0, s1], [1, yLow, yHigh]]) {
      if (Math.abs(v[dir]) < 1e-9) { if (q[dir] < lo || q[dir] > hi) { out = true; break; } continue; }
      let e0 = (lo - q[dir]) / v[dir], e1 = (hi - q[dir]) / v[dir];
      if (e0 > e1) { const tmp = e0; e0 = e1; e1 = tmp; }
      t0 = Math.max(t0, e0); t1 = Math.min(t1, e1);
      if (t0 > t1) { out = true; break; }
    }
    if (out) continue;
    return false;
  }
  return true;
}

const doorArg = process.argv.indexOf('--door');
if (doorArg > 0) {
  const [a1, a2] = process.argv.slice(doorArg + 1, doorArg + 3).map((s) => s.split(',').map(Number));
  const floors = (cr) => byCell.get((cr[0] - C0) * ROWS + (cr[1] - R0)) || [];

  let a = null, b = null, gap = Infinity;
  for (const x of floors(a1)) for (const y of floors(a2))
    if (Math.abs(x.y - y.y) < gap) { gap = Math.abs(x.y - y.y); a = x; b = y; }
  if (!a || !b) { console.log('no floor in', floors(a1).length ? a2 : a1); process.exit(0); }
  console.log(`${a1} y ${a.y.toFixed(2)} -> ${a2} y ${b.y.toFixed(2)}: ${doorwayClear(a, b) ? 'OPEN' : 'BLOCKED'}`);
  const near = [];
  for (let t = 0; t < tris.length; t++) {
    if (!tris[t][11]) continue;
    const bb = triBox[t];
    if (bb[3] < Math.min(a1[0], a2[0]) - 1 || bb[0] > Math.max(a1[0], a2[0]) + 2) continue;
    if (bb[5] < Math.min(a1[1], a2[1]) - 1 || bb[2] > Math.max(a1[1], a2[1]) + 2) continue;
    near.push([bb[1].toFixed(2), bb[4].toFixed(2)]);
  }
  console.log(`barrier triangles nearby: ${near.length}`, near.slice(0, 6).map((n) => `y ${n[0]}..${n[1]}`).join('  '));
  process.exit(0);
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
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

        if (diag) {
          const s1 = byCell.get((a.c + dc) * ROWS + a.r), s2 = byCell.get(a.c * ROWS + (a.r + dr));
          const near = (l) => l && l.some((n) => Math.abs(n.y - a.y) <= STEP && Math.abs(n.y - b.y) <= STEP);
          if (!near(s1) || !near(s2)) continue;
        }
        if (!doorwayClear(a, b)) continue;
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
nodes.forEach((n, i) => {
  if (real[comp[i]]) return;
  const x = C0 + n.c + 0.5, z = R0 + n.r + 0.5;
  if (inCave(x, z, n.y) || raycast(x, n.y + 0.2, z, 0, 1, 0, 0.001, 60) === Infinity) real[comp[i]] = true;
});
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

if (process.argv.includes('--slopes')) {
  const by = new Map();
  for (const n of outNodes) {
    const deg = Math.round(Math.acos(Math.min(1, n.tilt)) * 180 / Math.PI / 5) * 5;
    const k = `${n.m} ${String(deg).padStart(2)}deg`;
    by.set(k, (by.get(k) || 0) + 1);
  }
  console.log([...by.entries()].sort().map((e) => `${e[0]}: ${e[1]}`).join('\n'));
  process.exit(0);
}

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
