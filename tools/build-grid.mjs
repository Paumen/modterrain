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
if (existsSync(outPath) && !force) {
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
        tris.push([...p0, ...p1, ...p2, prim.material, Math.abs(ny) / (Math.hypot(nx, ny, nz) || 1)]);
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
// the centre alone matters: bridge decks and dock planks butt to their
// neighbours a couple of hundredths short of the cell line, so a centre-only
// probe misses half of them.
const OFFSETS = [[0, 0], [0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35],
  [0.3, 0.3], [0.3, -0.3], [-0.3, 0.3], [-0.3, -0.3]];
const NEED = 5; // samples that must agree before a floor counts

const reject = { support: 0, head: 0, buried: 0, wet: 0 };
const nodes = [];      // { c, r, y, m, e }
const byCell = new Map();

for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const x = C0 + c + 0.5, z = R0 + r + 0.5;
    const samples = OFFSETS.map(([ox, oz]) => floorsAt(x + ox, z + oz));
    const flat = [];
    samples.forEach((list, s) => list.forEach((f) => flat.push({ ...f, s })));
    if (!flat.length) continue;
    flat.sort((a, b) => a.y - b.y);

    // One cluster per floor. The gap has to stay well under a walkable step,
    // or a bridge deck and the riverbed under it merge into one floor.
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
      if (!good.length) continue;
      const support = new Set(good.map((f) => f.s)).size;
      if (support < NEED) { reject.support++; continue; }
      const y = good[Math.floor(good.length / 2)].y;
      // Water standing on the floor drowns it; water below a bridge deck or a
      // dock does not.
      if (flat.some((f) => WET.has(matName(f.mat)) && f.y > y - 0.05 && f.y < y + WADE)) { reject.wet++; continue; }
      const tally = new Map();
      for (const f of good) tally.set(matName(f.mat), (tally.get(matName(f.mat)) || 0) + 1);
      const centre = good.find((f) => f.s === 0);
      const name = centre ? matName(centre.mat) : [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const ceiling = raycast(x, y + 0.2, z, 0, 1, 0, 0.001, 40);
      const room = ceiling === Infinity ? Infinity : ceiling + 0.2;
      if (room < HEAD) { reject.head++; continue; }
      const eye = room === Infinity ? EYE : Math.max(MIN_EYE, Math.min(EYE, room - 1.8));
      // A target buried in rock makes the camera clip; a short spray of rays
      // from the eye point catches those before they reach the viewer.
      let clear = 0, total = 0;
      for (let a = 0; a < 12; a++) {
        for (const pitch of [-0.3, 0, 0.3]) {
          const th = (a / 12) * Math.PI * 2;
          const dy = Math.sin(pitch), h = Math.cos(pitch);
          total++;
          if (raycast(x, y + eye, z, Math.cos(th) * h, dy, Math.sin(th) * h, 0.001, 2) >= 0.4) clear++;
        }
      }
      if (clear < total * 0.5) { reject.buried++; continue; }
      here.push({ c, r, y, m: name, e: Math.round(eye * 100) / 100 });
    }
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
