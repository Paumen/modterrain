// Builds a walkable grid for a scene GLB.
//
// The scene is laid out on the kit's grid: one cell is exactly one world unit
// (piece nodes translate to cell centres and scale by whole cells), so the grid
// this emits is integer-indexed and every cell is 1x1. A cell can hold more
// than one walkable floor -- a bridge over a river, a cave under a hill -- so
// the output is a flat list of (column, row, height) nodes plus the edges
// between them.
//
//   node tools/build-grid.mjs scenes/Foo.glb [--force]

import { readGlb } from './glb.mjs';
import { writeFileSync, existsSync } from 'node:fs';

const input = process.argv[2];
if (!input) {
  console.error('usage: node tools/build-grid.mjs <scene.glb> [--force]');
  process.exit(1);
}
const force = process.argv.includes('--force');
const outPath = input.replace(/\.glb$/, '_grid.json');
if (existsSync(outPath) && !force && !process.argv.includes('--probe')) {
  console.error(`${outPath} exists; pass --force to overwrite`);
  process.exit(1);
}

const { json, bin } = readGlb(input);

// ---- decode ---------------------------------------------------------------

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

// ---- world-space triangles ------------------------------------------------

const tris = []; // [x0,y0,z0, x1,y1,z1, x2,y2,z2, matIndex, ny]
const cache = new Map();

// Decking you are meant to walk along, by piece family. A rope bridge is loose
// slats with air between them and ropes down each side, so point sampling only
// ever catches part of it; knowing a cell holds a deck is what lets a thinner
// sample still count. Railings, posts, braces and bumpers are structure, not
// deck, and are deliberately not here.
const DECK = /^(Prop_Bridge_|Path_Bridge_|Docks_Decking_|Docks_Ladder_Top)/;
const decks = []; // world-space [minX, minY, minZ, maxX, maxY, maxZ] per piece

// A cliff piece always carries the Cliff material on its face, and a cell with
// a cliff face in it is not somewhere you stand -- not on the ledge above it,
// not in the gap below it. Faces are collected here as XZ footprints while the
// triangles are gathered, and the cells they cover are closed outright.
const faces = []; // [minX, minZ, maxX, maxZ] per near-vertical Cliff triangle
const FACE_TILT = 0.5; // |normal.y| under this is a face, not a floor

function noteDeck(node, world) {
  if (!DECK.test(node.name || '')) return;
  for (const prim of json.meshes[node.mesh].primitives) {
    const acc = json.accessors[prim.attributes.POSITION];
    if (!acc?.min || !acc?.max) continue;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let corner = 0; corner < 8; corner++) {
      const p = xformPoint(world,
        (corner & 1 ? acc.max : acc.min)[0], (corner & 2 ? acc.max : acc.min)[1], (corner & 4 ? acc.max : acc.min)[2]);
      for (let a = 0; a < 3; a++) { if (p[a] < lo[a]) lo[a] = p[a]; if (p[a] > hi[a]) hi[a] = p[a]; }
    }
    decks.push([...lo, ...hi]);
    return;
  }
}

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
    noteDeck(node, world);
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
        // Winding is unreliable across mirrored instances, so "up-facing" is
        // measured without a sign; the grid only ever needs the plane's tilt.
        const tilt = Math.abs(ny) / (Math.hypot(nx, ny, nz) || 1);
        if (tilt < FACE_TILT && matName(prim.material) === 'Cliff') {
          faces.push([Math.min(p0[0], p1[0], p2[0]), Math.min(p0[2], p1[2], p2[2]),
            Math.max(p0[0], p1[0], p2[0]), Math.max(p0[2], p1[2], p2[2])]);
        }
        tris.push([...p0, ...p1, ...p2, prim.material, tilt]);
      }
    }
  }
  for (const child of node.children || []) emitNode(child, world);
}

for (const root of json.scenes[json.scene ?? 0].nodes) emitNode(root, IDENTITY);

// ---- grid geometry --------------------------------------------------------

const CELL = 1;          // one grid cell, one world unit
const EYE = 3.6;         // camera target height above the floor
const MIN_EYE = 1.5;     // lowest the target drops under a low ceiling
const HEAD = 2.0;        // ceiling clearance a floor needs to be usable
const STEP = 0.75;       // biggest height change you can walk between cells
const FLAT = 0.5;        // |ny| below this is a wall, not a floor
const CLUSTER = 0.3;     // surfaces within this height are the same floor
const ROOM = 1.2;        // room at least one orbit heading must have
const EMBEDDED = 0.35;   // closer than this on all sides and the target is in rock
const BETA = 1.5;        // the viewer's shallowest orbit pitch

// Cave floors and rock ledges carry Cliff, so it is walkable where it faces
// up; the vertical cliff faces of the same pieces never produce a floor.
const WALKABLE = new Set(['Grass', 'Dirt', 'Cliff', 'Carved Stone Walkway', 'Wood Light', 'Wood Light End', 'Wood Medium', 'Wood Dark']);
const PATHY = new Set(['Carved Stone Walkway', 'Wood Light', 'Wood Light End', 'Wood Medium', 'Wood Dark']);
// Water drowns whatever is under it: a river laid over grass leaves that grass
// unwalkable, and the surface itself is never walkable either.
const WET = new Set(['Water River', 'Waterfall', 'Waterfall Crest', 'Cave Pool']);
const WADE = 1.0; // water this far above a floor still covers it

let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const [x0, , z0, x1, , z1, x2, , z2] of tris) {
  minX = Math.min(minX, x0, x1, x2); maxX = Math.max(maxX, x0, x1, x2);
  minZ = Math.min(minZ, z0, z1, z2); maxZ = Math.max(maxZ, z0, z1, z2);
}
const C0 = Math.floor(minX), R0 = Math.floor(minZ);
const COLS = Math.ceil(maxX) - C0, ROWS = Math.ceil(maxZ) - R0;

// ---- spatial index --------------------------------------------------------

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

// Every surface directly under (x, z): [y, matIndex, flatness].
function heightsAt(x, z) {
  const hits = [];
  for (const t of bins[bz(z) * BW + bx(x)]) {
    const b = triBox[t];
    if (x < b[0] || x > b[3] || z < b[2] || z > b[5]) continue;
    const [x0, y0, z0, x1, y1, z1, x2, y2, z2, mat, up] = tris[t];
    const d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
    if (Math.abs(d) < 1e-9) continue;
    const w0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / d;
    const w1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / d;
    const w2 = 1 - w0 - w1;
    if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
    hits.push([w0 * y0 + w1 * y1 + w2 * y2, mat, up]);
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

// `--probe x,z` reports what the sampler sees under one world point, which is
// the only practical way to ask why a particular cell did or did not open.
const probeArg = process.argv.indexOf('--probe');

// ---- floors ---------------------------------------------------------------

// The floors under one sample point, topmost surface of each stack deciding
// what the floor is made of: a river laid over grass reads as water, so the
// grass beneath it never becomes walkable.
function floorsAt(x, z) {
  const hits = heightsAt(x, z).filter((h) => h[2] > FLAT).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (let i = 0; i < hits.length;) {
    let j = i;
    while (j + 1 < hits.length && hits[j + 1][0] - hits[j][0] <= CLUSTER) j++;
    out.push({ y: hits[j][0], mat: hits[j][1] });
    i = j + 1;
  }
  return out;
}

// Nine samples per cell. Taking floors from the whole footprint rather than
// the centre alone matters twice over: bridge decks and dock planks butt to
// their neighbours a couple of hundredths short of the cell line, and a rope
// bridge is loose slats with air between them, so a single probe drops through
// the gap and reports no bridge at all.
const OFFSETS = [[0, 0], [0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35],
  [0.3, 0.3], [0.3, -0.3], [-0.3, 0.3], [-0.3, -0.3]];
const NEED = 5; // samples that must agree before a floor counts

// Headroom, measured across the cell and taken as the median of the nine rays.
// A single ray up the middle threads the gap between two slats of a rope
// bridge and reports open sky, which then puts the camera target at full
// height -- inside the bridge. Taking the lowest ray instead swings too far
// the other way: any overhang clipping one corner of a cell would close it.
// The median moves only when something really does span the cell.
function ceilingAt(x, z, y) {
  const rays = OFFSETS.map(([ox, oz]) => raycast(x + ox, y + 0.2, z + oz, 0, 1, 0, 0.001, 40));
  rays.sort((a, b) => a - b);
  const mid = rays[rays.length >> 1];
  return mid === Infinity ? Infinity : mid + 0.2;
}

const reject = { support: 0, head: 0, buried: 0, wet: 0, cliff: 0 };

// Cells with a cliff face in them, closed before anything else is asked. A
// face is counted into a cell when it crosses that cell at all, so the cell
// the wall stands in goes, and so does the strip of ledge hanging over it.
const cliffCells = new Set();
for (const [x0, z0, x1, z1] of faces) {
  for (let c = Math.floor(x0) - C0; c <= Math.floor(x1 - 1e-6) - C0; c++)
    for (let r = Math.floor(z0) - R0; r <= Math.floor(z1 - 1e-6) - R0; r++)
      cliffCells.add(c * ROWS + r);
}

// Is this floor part of a deck? Cells a bridge or a dock crosses are walkable
// at the deck's own height, which is the rule the scene is built to; the
// sampler's job there is only to find how high the planks sit.
const onDeck = (x, z, y) => decks.some((d) =>
  x >= d[0] && x <= d[3] && z >= d[2] && z <= d[5] && y >= d[1] - 0.1 && y <= d[4] + 0.1);

// Everything you can stand on in one cell, lowest first. `note` reports why a
// candidate floor was turned down, for --probe.
function floorsIn(c, r, note) {
  const x = C0 + c + 0.5, z = R0 + r + 0.5;
  // A bridge is the one thing that crosses a cliff face, so it is the one
  // exception: the deck stays walkable where it spans the drop.
  if (cliffCells.has(c * ROWS + r) && !decks.some((d) => x >= d[0] && x <= d[3] && z >= d[2] && z <= d[5])) {
    reject.cliff++; note?.(0, 'Cliff', 'cell holds a cliff face');
    return [];
  }
  const samples = OFFSETS.map(([ox, oz]) => floorsAt(x + ox, z + oz));
  const flat = [];
  samples.forEach((list, s) => list.forEach((f) => flat.push({ ...f, s })));
  if (!flat.length) return [];
  flat.sort((a, b) => a.y - b.y);

  // One cluster per floor. The gap has to stay well under a walkable step, or
  // a bridge deck and the riverbed under it merge into one floor.
  const clusters = [];
  for (const f of flat) {
    const last = clusters[clusters.length - 1];
    if (last && f.y - last[last.length - 1].y <= 0.4) last.push(f);
    else clusters.push([f]);
  }

  const here = [];
  for (const k of clusters) {
    // Each member is already the top of its own sample's stack, so a river
    // over grass reads as water there; the cell is walkable when enough
    // samples independently land on walkable ground.
    const good = k.filter((f) => WALKABLE.has(matName(f.mat)));
    const y = good.length ? good[Math.floor(good.length / 2)].y : k[k.length - 1].y;
    const label = matName(k[k.length - 1].mat);
    if (!good.length) { note?.(y, label, 'nothing walkable'); continue; }
    const support = new Set(good.map((f) => f.s)).size;
    const need = onDeck(x, z, y) ? 1 : NEED;
    if (support < need) { reject.support++; note?.(y, label, `only ${support} of ${OFFSETS.length} samples`); continue; }
    // Water standing on the floor drowns it; water below a bridge deck or a
    // dock does not.
    if (flat.some((f) => WET.has(matName(f.mat)) && f.y > y - 0.05 && f.y < y + WADE)) {
      reject.wet++; note?.(y, label, 'under water'); continue;
    }
    const tally = new Map();
    for (const f of good) tally.set(matName(f.mat), (tally.get(matName(f.mat)) || 0) + 1);
    const centre = good.find((f) => f.s === 0);
    const name = centre ? matName(centre.mat) : [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const room = ceilingAt(x, z, y);
    if (room < HEAD) { reject.head++; note?.(y, name, `ceiling only ${room.toFixed(2)} up`); continue; }
    const eye = room === Infinity ? EYE : Math.max(MIN_EYE, Math.min(EYE, room - 1.8));
    // Two different things can go wrong with the camera's look-at point, and
    // they need different tests. It can sit inside rock, which makes the view
    // clip whichever way you turn -- caught by a spray of rays finding
    // something almost touching. Or it can sit somewhere with no room to pull
    // back, which only matters if *every* heading is blocked: a gully floor or
    // a cave has walls close on two sides and is perfectly fine to stand in,
    // and demanding clearance all round deletes exactly those places.
    let closest = Infinity;
    for (let a = 0; a < 12; a++) {
      for (const pitch of [-0.3, 0, 0.3]) {
        const th = (a / 12) * Math.PI * 2;
        const dy = Math.sin(pitch), h = Math.cos(pitch);
        closest = Math.min(closest, raycast(x, y + eye, z, Math.cos(th) * h, dy, Math.sin(th) * h, 0.001, 6));
      }
    }
    if (closest < EMBEDDED) { reject.buried++; note?.(y, name, `target in rock, ${closest.toFixed(2)} clear`); continue; }
    // The six orbit headings the viewer actually uses, at its shallowest
    // pitch. One with room is enough; the viewer turns to find it.
    let roomiest = 0;
    for (let k = 0; k < 6; k++) {
      const alpha = (k / 6) * Math.PI * 2;
      roomiest = Math.max(roomiest, raycast(x, y + eye, z,
        Math.cos(alpha) * Math.sin(BETA), Math.cos(BETA), Math.sin(alpha) * Math.sin(BETA), 0.001, 8));
    }
    if (roomiest < ROOM) { reject.buried++; note?.(y, name, `no heading has room, best ${roomiest.toFixed(2)}`); continue; }
    note?.(y, name, 'open');
    here.push({ c, r, y, m: name, e: Math.round(eye * 100) / 100 });
  }
  return here;
}

if (probeArg > 0) {
  const [px, pz] = process.argv[probeArg + 1].split(',').map(Number);
  const c = Math.floor(px) - C0, r = Math.floor(pz) - R0;
  console.log(`cell ${c},${r} -- centred on ${C0 + c + 0.5}, ${R0 + r + 0.5}`);
  console.log('surfaces under the centre:');
  for (const h of heightsAt(px, pz).sort((a, b) => a[0] - b[0]))
    console.log(`  y ${h[0].toFixed(3)}  ${matName(h[1]).padEnd(22)} tilt ${h[2].toFixed(2)}`);
  console.log('floors:');
  floorsIn(c, r, (y, name, why) => console.log(`  y ${y.toFixed(3)}  ${name.padEnd(22)} ${why}`));
  process.exit(0);
}

const nodes = [];      // { c, r, y, m, e }
const byCell = new Map();

for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const here = floorsIn(c, r);
    if (!here.length) continue;
    byCell.set(c * ROWS + r, here.map((n) => { n.i = nodes.length; nodes.push(n); return n; }));
  }
}

// ---- edges ----------------------------------------------------------------

// Two floors connect when the height change is walkable and a body-height
// corridor between the cell centres is clear, so fences, posts, railings and
// retaining walls block the way even though the ground either side is fine.
function corridorClear(a, b) {
  const ax = C0 + a.c + 0.5, az = R0 + a.r + 0.5;
  const bx2 = C0 + b.c + 0.5, bz2 = R0 + b.r + 0.5;
  for (const h of [0.35, 0.85]) {
    const ox = ax, oy = a.y + h, oz = az;
    const dx = bx2 - ox, dy = (b.y + h) - oy, dz = bz2 - oz;
    const len = Math.hypot(dx, dy, dz);
    if (raycast(ox, oy, oz, dx / len, dy / len, dz / len, 0.05, len - 0.05) < len - 0.05) return false;
  }
  return true;
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
        // No cutting corners: a diagonal needs both orthogonal cells open too.
        if (diag) {
          const s1 = byCell.get((a.c + dc) * ROWS + a.r), s2 = byCell.get(a.c * ROWS + (a.r + dr));
          const near = (l) => l && l.some((n) => Math.abs(n.y - a.y) <= STEP && Math.abs(n.y - b.y) <= STEP);
          if (!near(s1) || !near(s2)) continue;
        }
        if (!corridorClear(a, b)) continue;
        links[a.i].add(b.i); links[b.i].add(a.i);
        edges.push(a.i, b.i);
      }
    }
  }
}

// ---- keep only what you can actually reach --------------------------------

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
const MIN_COMP = 8;
const keep = nodes.map((_, i) => sizes[comp[i]] >= MIN_COMP);

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
  // c, r, y, eye, material index
  nodes: outNodes.map((n) => [n.c, n.r, Math.round(n.y * 1000) / 1000, n.e, matIndex.get(n.m)]),
  edges: outEdges,
};

writeFileSync(outPath, JSON.stringify(doc));
const byMat = new Map();
for (const n of outNodes) byMat.set(n.m, (byMat.get(n.m) || 0) + 1);
console.log(`${outPath}: ${outNodes.length} cells, ${outEdges.length / 2} edges, ${COLS}x${ROWS} grid`);
console.log([...byMat.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', '));
console.log(`rejected: ${JSON.stringify(reject)}; dropped as unreachable: ${nodes.length - outNodes.length}`);
