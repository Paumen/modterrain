// Builds a walkable grid for a scene GLB.
//
// The scene is laid out on the kit's grid: one cell is exactly one world unit
// (piece nodes translate to cell centres and scale by whole cells), so the grid
// this emits is integer-indexed and every cell is 1x1. A cell can hold more
// than one floor -- a bridge over a river, a cave under a hill -- so the output
// is a flat list of (column, row, height) cells plus the edges between them.
//
//   node tools/build-grid.mjs scenes/Foo.glb [--force]
//
// ONE RULE: whether you can stand somewhere depends on the terrain type at
// that level in that cell. In full, every reason a cell can be closed:
//
//   material   Grass, Dirt and the wood of decking are walkable, as is Cliff
//              where it faces up -- cave floors and rock ledges. Everything
//              else is not: water, rope, stone walls, fence timber.
//   slope      Steeper than FLAT is a hillside, not a floor.
//   water      Water standing on a floor drowns it, up to WADE above.
//              Water under a bridge deck does not.
//   cliff face A cliff face standing in the cell at that height closes it. A
//              face belongs to the cell on its solid side, so a mesa's rim
//              closes and the floor of a cave does not. Bridges are exempt.
//   headroom   Less than HEAD of ceiling and you cannot stand up.
//   coverage   Fewer than NEED of the nine samples agreeing and there is not
//              enough floor there to stand on. Cells a deck crosses need one.
//
// And every reason two open cells can end up unlinked:
//
//   step       A height change over STEP is a climb, not a walk.
//   corridor   Most of the width of the opening, at body height, must be
//              clear: fences, railings, posts and walls block.
//   corner     A diagonal needs both orthogonal cells open.
//   reach      A patch that is neither part of the main island, nor under open
//              sky, nor standing on cave floor is dropped -- terrain pieces are
//              hollow shells, and the inside of a hill would otherwise read as
//              a cave.
//
// Whether the CAMERA has room is not on that list. That is the viewer's
// business, decided per frame against the real triangles.
//
// To see why one cell went the way it did: --probe x,z. To see the walkable
// patches: --components. The cliff-face mask: --faces. Floor slopes: --slopes.

import { readGlb } from './glb.mjs';
import { writeFileSync, existsSync } from 'node:fs';

const input = process.argv[2];
if (!input) {
  console.error('usage: node tools/build-grid.mjs <scene.glb> [--force]');
  process.exit(1);
}
const force = process.argv.includes('--force');
const outPath = input.replace(/\.glb$/, '_grid.json');
if (existsSync(outPath) && !force && !process.argv.includes('--probe') && !process.argv.includes('--faces') && !process.argv.includes('--components') && !process.argv.includes('--slopes')) {
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

// Cave floors, by piece family. Terrain pieces are hollow shells, so the
// inside of a hill offers walkable-looking ground with a ceiling over it that
// is indistinguishable from a cave by geometry alone. The pieces tell them
// apart: a cave has floor built for it, a shell's inside has nothing.
const CAVE = /^(Cave_|Floor_)/;
const caves = [];

// A cliff piece always carries the Cliff material on its face, and a cell with
// a cliff face in it is not somewhere you stand -- not on the ledge above it,
// not in the gap below it. Faces are collected here as XZ footprints while the
// triangles are gathered, and the cells they cover are closed outright.
// Cliff faces, per cell, as the height band each one spans.
const faces = new Map(); // "cx,cz" -> [[minY, maxY], ...]
const FACE_TILT = 0.5;   // |normal.y| under this is a face, not a floor

// A face belongs to the cell of the piece it is the skin of, which is the cell
// on the solid side -- behind the normal. That side is the whole distinction
// between a cliff and a cave: the outward face of a mesa has its rock, and so
// its walkable top, on the far side from you, while the face of a cave wall
// has its rock behind the wall and the cave floor in front. Closing the cell
// the sliver merely touches would close both.
//
// Walking the edges rather than taking a bounding box matters too: a face
// running diagonally, which every curve and esse piece has, boxes into a
// square many times its own footprint.
function markFace(p0, p1, p2, nx, nz) {
  const len = Math.hypot(nx, nz) || 1;
  const bx = -(nx / len) * 0.3, bz = -(nz / len) * 0.3; // a step into the rock
  const minY = Math.min(p0[1], p1[1], p2[1]), maxY = Math.max(p0[1], p1[1], p2[1]);
  for (const [a, b] of [[p0, p1], [p1, p2], [p2, p0]]) {
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) * 8));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const key = `${Math.floor(a[0] + dx * t + bx)},${Math.floor(a[2] + dz * t + bz)}`;
      const band = faces.get(key);
      if (band) band.push([minY, maxY]); else faces.set(key, [[minY, maxY]]);
    }
  }
}

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

function emitNode(nodeIndex, parent) {
  const node = json.nodes[nodeIndex];
  const world = parent === IDENTITY && node.matrix ? node.matrix : mul4(parent, localMatrix(node));
  if (node.mesh != null) {
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
        // Signed, not absolute. Every node in these scenes has a positive
        // determinant, so winding is trustworthy and a surface's normal says
        // which way it faces. Taking the absolute value made every ceiling
        // read as a floor, which is what put walkable ground inside mountains.
        const len = Math.hypot(nx, ny, nz) || 1;
        const up = ny / len;
        if (Math.abs(up) < FACE_TILT && matName(prim.material) === 'Cliff') markFace(p0, p1, p2, nx, nz);
        tris.push([...p0, ...p1, ...p2, prim.material, up]);
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
const FLAT = 0.86;      // steeper than about 30 degrees is a hillside, not a floor
const CLUSTER = 0.3;     // surfaces within this height are the same floor

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
    out.push({ y: hits[j][0], mat: hits[j][1], up: hits[j][2] });
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

const reject = { support: 0, head: 0, wet: 0, cliff: 0 };

// Cells with a cliff face in them, closed before anything else is asked. A
// face is counted into a cell when it crosses that cell at all, so the cell
// the wall stands in goes, and so does the strip of ledge hanging over it.
// Does a cliff face stand in this cell at this height? A floor resting on top
// of a face counts as being at its level: the ledge along the brink of a drop
// is the cliff piece's own top, and that is the cell being closed.
function cliffAt(c, r, y) {
  const band = faces.get(`${c + C0},${r + R0}`);
  return !!band && band.some(([lo, hi]) => y > lo + 0.1 && y < hi - 0.1);
}

// Is this floor part of a deck? Cells a bridge or a dock crosses are walkable
// at the deck's own height, which is the rule the scene is built to; the
// sampler's job there is only to find how high the planks sit.
const inBox = (list, x, z, y) => list.some((d) =>
  x >= d[0] && x <= d[3] && z >= d[2] && z <= d[5] && y >= d[1] - 0.1 && y <= d[4] + 0.1);
const onDeck = (x, z, y) => inBox(decks, x, z, y);
const inCave = (x, z, y) => inBox(caves, x, z, y);

// Everything you can stand on in one cell, lowest first. `note` reports why a
// candidate floor was turned down, for --probe.
function floorsIn(c, r, note) {
  const x = C0 + c + 0.5, z = R0 + r + 0.5;

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
    // A bridge is the one thing built to cross a cliff face, so it is the one
    // exception: the deck stays walkable where it spans the drop.
    if (cliffAt(c, r, y) && !onDeck(x, z, y)) { reject.cliff++; note?.(y, name, 'cliff face at this height'); continue; }
    const room = ceilingAt(x, z, y);
    if (room < HEAD) { reject.head++; note?.(y, name, `ceiling only ${room.toFixed(2)} up`); continue; }
    const eye = room === Infinity ? EYE : Math.max(MIN_EYE, Math.min(EYE, room - 1.8));
    note?.(y, name, 'open');
    here.push({ c, r, y, m: name, e: Math.round(eye * 100) / 100, tilt: Math.min(...good.map((f) => f.up)) });
  }
  return here;
}

if (process.argv.includes('--faces')) {
  const rows = [];
  for (let r = 0; r < ROWS; r++) {
    let line = '';
    for (let c = 0; c < COLS; c++) line += cliffCells.has(c * ROWS + r) ? '#' : '.';
    rows.push(line);
  }
  console.log(rows.join('\n'));
  process.exit(0);
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
// Is the way between two cells open? A single line between the two centres is
// not enough to answer that: a fence rarely runs down the middle of the cells
// it divides, so a line probe only catches the few that happen to. The whole
// width of the opening is swept instead, at three heights, and the way counts
// as blocked when most of it is -- which a fence, a railing or a wall is along
// its length, while a lone post leaves the rest of the gap open.
const CORRIDOR = [-0.35, 0, 0.35];   // across the opening
const BODY = [0.3, 0.7, 1.1];        // and up it
function corridorClear(a, b) {
  const ax = C0 + a.c + 0.5, az = R0 + a.r + 0.5;
  const bx = C0 + b.c + 0.5, bz = R0 + b.r + 0.5;
  const dx = bx - ax, dz = bz - az;
  const flat = Math.hypot(dx, dz) || 1;
  const px = -dz / flat, pz = dx / flat;  // across the direction of travel
  let blocked = 0, total = 0;
  for (const off of CORRIDOR) {
    for (const h of BODY) {
      const ox = ax + px * off, oy = a.y + h, oz = az + pz * off;
      const vx = bx + px * off - ox, vy = (b.y + h) - oy, vz = bz + pz * off - oz;
      const len = Math.hypot(vx, vy, vz);
      total++;
      if (raycast(ox, oy, oz, vx / len, vy / len, vz / len, 0.05, len - 0.05) < len - 0.05) blocked++;
    }
  }
  return blocked * 2 < total;
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
// Terrain pieces are hollow shells, so the underside of a hill has floors
// buried in it that look exactly like a cave from close up: walkable ground
// with a ceiling over it. What tells them apart is whether you could ever get
// there. A cave is joined to the island through its mouth; a shell's inside is
// sealed. So a patch survives only if it is part of the main island, or is
// somewhere with open sky above it -- an offshore island, say.
const real = new Array(compCount).fill(false);
nodes.forEach((n, i) => {
  if (real[comp[i]]) return;
  const x = C0 + n.c + 0.5, z = R0 + n.r + 0.5;
  if (inCave(x, z, n.y) || raycast(x, n.y + 0.2, z, 0, 1, 0, 0.001, 60) === Infinity) real[comp[i]] = true;
});
const main = sizes.indexOf(Math.max(...sizes));
const MIN_COMP = 8;
const keep = nodes.map((_, i) => comp[i] === main || (real[comp[i]] && sizes[comp[i]] >= MIN_COMP));
// `--components` lists the separate walkable patches, largest first. A patch
// that is not the main island is either somewhere you reach another way or
// somewhere the grid has cut off by mistake, and this is how you tell.
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
