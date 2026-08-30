// Collapse a scene GLB into one mesh per visible material and generate a
// navigation graph for viewer.html.
//
//   node tools/merge-scene.mjs scenes/Large_Island_v2_No_Ocean_No_Props.glb
//
// Writes <scene>_merged.glb (Hidden* faces dropped, transforms baked, flat
// normals, de-indexed) and <scene>_nav.json (camera nodes with edges and
// per-angle orbit radii, precomputed so the viewer needs no collision code).

import { readGlb, writeGlb } from './glb.mjs';

const input = process.argv[2];
if (!input) {
  console.error('usage: node tools/merge-scene.mjs <scene.glb>');
  process.exit(1);
}
const outGlb = input.replace(/\.glb$/, '_merged.glb');
const outNav = input.replace(/\.glb$/, '_nav.json');

const { json, bin } = readGlb(input);

// ---- decode ---------------------------------------------------------------

const CTOR = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function accessorData(i) {
  const a = json.accessors[i];
  const bv = json.bufferViews[a.bufferView];
  const offset = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const Ctor = CTOR[a.componentType];
  return new Ctor(bin.buffer, bin.byteOffset + offset, a.count * NCOMP[a.type]);
}

// ---- matrix helpers (column-major, as glTF stores them) -------------------

function xformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function det3(m) {
  return (
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[4] * (m[1] * m[10] - m[2] * m[9]) +
    m[8] * (m[1] * m[6] - m[2] * m[5])
  );
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
  // The scenes this tool targets store matrices, but handle TRS for safety.
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

// ---- gather world-space triangles per material ----------------------------

const matName = (i) => json.materials?.[i]?.name ?? '(none)';
const isHidden = (i) => /^Hidden/.test(matName(i));

const buckets = new Map(); // material index -> { pos: number[], nrm: number[] }
const tris = []; // every visible triangle, for the nav pass: [x0,y0,z0,...,z2, matIndex, ny]
const cache = new Map();

function meshGeometry(prim) {
  const key = `${prim.attributes.POSITION}/${prim.indices ?? -1}`;
  let g = cache.get(key);
  if (!g) {
    const pos = accessorData(prim.attributes.POSITION);
    const idx = prim.indices != null ? accessorData(prim.indices) : null;
    g = { pos, idx };
    cache.set(key, g);
  }
  return g;
}

function emitNode(nodeIndex, parent) {
  const node = json.nodes[nodeIndex];
  const world = parent === IDENTITY && node.matrix ? node.matrix : mul4(parent, localMatrix(node));
  if (node.mesh != null) {
    const flip = det3(world) < 0;
    for (const prim of json.meshes[node.mesh].primitives) {
      if ((prim.mode ?? 4) !== 4 || isHidden(prim.material)) continue;
      let bucket = buckets.get(prim.material);
      if (!bucket) buckets.set(prim.material, (bucket = { pos: [], nrm: [] }));
      const { pos, idx } = meshGeometry(prim);
      const count = idx ? idx.length : pos.length / 3;
      for (let t = 0; t < count; t += 3) {
        const i0 = idx ? idx[t] : t;
        let i1 = idx ? idx[t + 1] : t + 1;
        let i2 = idx ? idx[t + 2] : t + 2;
        if (flip) [i1, i2] = [i2, i1];
        const p0 = xformPoint(world, pos[i0 * 3], pos[i0 * 3 + 1], pos[i0 * 3 + 2]);
        const p1 = xformPoint(world, pos[i1 * 3], pos[i1 * 3 + 1], pos[i1 * 3 + 2]);
        const p2 = xformPoint(world, pos[i2 * 3], pos[i2 * 3 + 1], pos[i2 * 3 + 2]);
        const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
        const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        bucket.pos.push(...p0, ...p1, ...p2);
        bucket.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
        tris.push([...p0, ...p1, ...p2, prim.material, ny]);
      }
    }
  }
  for (const child of node.children || []) emitNode(child, world);
}

for (const root of json.scenes[json.scene ?? 0].nodes) emitNode(root, IDENTITY);

// ---- write the merged GLB -------------------------------------------------

const out = {
  asset: { version: '2.0', generator: 'modterrain merge-scene' },
  scene: 0,
  scenes: [{ nodes: [] }],
  nodes: [],
  meshes: [],
  materials: [],
  accessors: [],
  bufferViews: [],
  buffers: [],
};

const chunks = [];
let byteOffset = 0;

function addAccessor(data, type, minMax) {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  out.bufferViews.push({ buffer: 0, byteOffset, byteLength: buf.length });
  byteOffset += buf.length;
  chunks.push(buf);
  const acc = { bufferView: out.bufferViews.length - 1, componentType: 5126, count: data.length / NCOMP[type], type };
  if (minMax) {
    const n = NCOMP[type];
    acc.min = new Array(n).fill(Infinity);
    acc.max = new Array(n).fill(-Infinity);
    for (let i = 0; i < data.length; i++) {
      const c = i % n;
      if (data[i] < acc.min[c]) acc.min[c] = data[i];
      if (data[i] > acc.max[c]) acc.max[c] = data[i];
    }
  }
  out.accessors.push(acc);
  return out.accessors.length - 1;
}

const ordered = [...buckets.entries()].sort((a, b) => b[1].pos.length - a[1].pos.length);
for (const [mat, bucket] of ordered) {
  const posAcc = addAccessor(new Float32Array(bucket.pos), 'VEC3', true);
  const nrmAcc = addAccessor(new Float32Array(bucket.nrm), 'VEC3', false);
  out.materials.push(structuredClone(json.materials[mat]));
  out.meshes.push({
    name: matName(mat),
    primitives: [{ attributes: { POSITION: posAcc, NORMAL: nrmAcc }, material: out.materials.length - 1 }],
  });
  out.nodes.push({ name: matName(mat), mesh: out.meshes.length - 1 });
  out.scenes[0].nodes.push(out.nodes.length - 1);
}
out.buffers.push({ byteLength: byteOffset });

writeGlb(outGlb, out, Buffer.concat(chunks));
console.log(`${outGlb}: ${out.meshes.length} meshes, ${tris.length} triangles`);

// ---- navigation graph -----------------------------------------------------

// One grid cell in world units, taken from the world-space footprint of any
// 1x1 piece (piece names carry their grid size).
let cell = 1;
for (let i = 0; i < json.nodes.length; i++) {
  const node = json.nodes[i];
  if (!/_1x1_/.test(node.name || '') || node.mesh == null) continue;
  const prim = json.meshes[node.mesh].primitives[0];
  const { pos } = meshGeometry(prim);
  let minPX = Infinity, maxPX = -Infinity;
  for (let v = 0; v < pos.length; v += 3) {
    const p = xformPoint(node.matrix || localMatrix(node), pos[v], pos[v + 1], pos[v + 2]);
    if (p[0] < minPX) minPX = p[0];
    if (p[0] > maxPX) maxPX = p[0];
  }
  cell = maxPX - minPX;
  break;
}

// Camera nodes prefer built paths over open ground: walkways and wood decking
// first, then dirt, then grass. Sampling is dense and thinned by spacing so
// nodes follow the paths instead of landing on an arbitrary grid.
const PRIORITY = new Map([
  ['Carved Stone Walkway', 0], ['Wood Dark', 0], ['Wood Medium', 0], ['Wood Light', 0],
  ['Dirt', 1],
  ['Grass', 2],
]);
const SAMPLE = 1.5 * cell;      // candidate sampling step
const SPACING = [2.2, 3.0, 4.2]; // min node distance per priority class, in cells
const EDGE_MAX = 5.2 * cell;    // maximum edge length
const EYE = 1.2 * cell;         // camera target height above ground

// ---- spatial index: triangles binned by XZ cell ---------------------------

let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const [x0, , z0, x1, , z1, x2, , z2] of tris) {
  minX = Math.min(minX, x0, x1, x2); maxX = Math.max(maxX, x0, x1, x2);
  minZ = Math.min(minZ, z0, z1, z2); maxZ = Math.max(maxZ, z0, z1, z2);
}
const BIN = cell;
const BW = Math.ceil((maxX - minX) / BIN) + 1, BH = Math.ceil((maxZ - minZ) / BIN) + 1;
const bx = (x) => Math.max(0, Math.min(BW - 1, Math.floor((x - minX) / BIN)));
const bz = (z) => Math.max(0, Math.min(BH - 1, Math.floor((z - minZ) / BIN)));
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

// All surface heights at (x, z): [y, matIndex, ny] per covering triangle.
function heightsAt(x, z) {
  const hits = [];
  for (const t of bins[bz(z) * BW + bx(x)]) {
    const b = triBox[t];
    if (x < b[0] || x > b[3] || z < b[2] || z > b[5]) continue;
    const [x0, y0, z0, x1, y1, z1, x2, y2, z2, mat, ny] = tris[t];
    const d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
    if (Math.abs(d) < 1e-9) continue; // vertical face
    const w0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / d;
    const w1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / d;
    const w2 = 1 - w0 - w1;
    if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
    hits.push([w0 * y0 + w1 * y1 + w2 * y2, mat, ny]);
  }
  return hits;
}

// Nearest ray hit (Moller-Trumbore), walking the XZ bins along the ray.
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
  const nextX = () => dx !== 0 ? ((minX + (ix + (dx > 0 ? 1 : 0)) * BIN) - ox) / dx : Infinity;
  const nextZ = () => dz !== 0 ? ((minZ + (iz + (dz > 0 ? 1 : 0)) * BIN) - oz) / dz : Infinity;
  let tX = nextX(), tZ = nextZ();
  const dX = dx !== 0 ? Math.abs(BIN / dx) : Infinity, dZ = dz !== 0 ? Math.abs(BIN / dz) : Infinity;
  let t = 0;
  for (let i = 0; i < BW + BH && t <= tMax && t < best; i++) {
    // widen by one bin so triangles straddling the ray's corridor are tested
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) testBin(ix + a, iz + b);
    if (tX < tZ) { t = tX; tX += dX; ix += stepX; } else { t = tZ; tZ += dZ; iz += stepZ; }
  }
  return best;
}

// ---- node candidates ------------------------------------------------------

const walkableHit = ([, mat, ny]) => PRIORITY.has(matName(mat)) && ny > 0.7;

function hasSupport(x, z, y) {
  const d = 0.35 * cell;
  for (const [ox, oz] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
    if (!heightsAt(x + ox, z + oz).some((h) => walkableHit(h) && Math.abs(h[0] - y) <= 0.7 * cell)) return false;
  }
  return true;
}

const candidates = [];
for (let x = minX + SAMPLE / 2; x < maxX; x += SAMPLE) {
  for (let z = minZ + SAMPLE / 2; z < maxZ; z += SAMPLE) {
    const hits = heightsAt(x, z);
    const walk = hits.filter(walkableHit).sort((a, b) => a[0] - b[0]);
    let last = -Infinity;
    for (const [y, mat] of walk) {
      if (y - last < 0.5 * cell) continue;
      last = y;
      const blocked = hits.some((h) => h[0] > y + 0.15 * cell && h[0] <= y + 1.6 * cell);
      if (blocked || !hasSupport(x, z, y)) continue;
      // Narrowness: how many of 8 directions stay walkable nearby. Paths,
      // bridges, stairs, ridge lips and coastlines score low and get dense
      // nodes; open fields and beach interiors score high and stay sparse.
      let open8 = 0, grassAround = 0;
      for (let k = 0; k < 8; k++) {
        const ox = Math.cos((k * Math.PI) / 4) * 2 * cell, oz = Math.sin((k * Math.PI) / 4) * 2 * cell;
        const near = heightsAt(x + ox, z + oz).filter((h) => walkableHit(h) && Math.abs(h[0] - y) <= 0.9 * cell);
        if (near.length) open8++;
        if (near.some((h) => matName(h[1]) === 'Grass')) grassAround++;
      }
      // Surface class steers routing: walkways/wood decking are paths, and so
      // is a dirt ribbon threading through grass (a trail); beach dirt and
      // grass are open ground the router should prefer to avoid.
      const name = matName(mat);
      const isTrail = name === 'Dirt' && grassAround >= 3;
      const cls = PRIORITY.get(name) === 0 || isTrail ? 'p' : name === 'Dirt' ? 'd' : 'g';
      const byShape = open8 <= 5 ? 0 : open8 <= 7 ? 1 : 2;
      candidates.push({ p: [x, y, z], cls, prio: cls === 'p' ? 0 : byShape });
    }
  }
}

// Thin by spacing, paths first, so walkways keep a chain of nodes and open
// grass stays sparse.
candidates.sort((a, b) => a.prio - b.prio || a.p[0] - b.p[0] || a.p[2] - b.p[2]);
const nodes = [];
for (const c of candidates) {
  const spacing = SPACING[c.prio] * cell;
  let ok = true;
  for (const n of nodes) {
    if (Math.hypot(n.p[0] - c.p[0], n.p[1] - c.p[1], n.p[2] - c.p[2]) < spacing) { ok = false; break; }
  }
  if (ok) nodes.push({ p: c.p, s: c.cls, n: [] });
}

// Edges: near neighbours with a clear line of sight at eye height. Gentle
// edges need only the sightline; steeper ones (stairs, ramps, inclines) also
// need the ground to follow the climb, so cliff tops connect through their
// stairways but never straight over a ledge.
function groundFollows(a, b) {
  for (const f of [0.25, 0.5, 0.75]) {
    const x = a[0] + (b[0] - a[0]) * f, z = a[2] + (b[2] - a[2]) * f;
    const y = a[1] + (b[1] - a[1]) * f;
    if (!heightsAt(x, z).some((h) => walkableHit(h) && Math.abs(h[0] - y) <= 1.0 * cell)) return false;
  }
  return true;
}
for (let i = 0; i < nodes.length; i++) {
  for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i].p, b = nodes[j].p;
    const dy = Math.abs(b[1] - a[1]);
    if (Math.hypot(b[0] - a[0], b[2] - a[2]) > EDGE_MAX || dy > 2.6 * cell) continue;
    if (dy > 1.3 * cell && !groundFollows(a, b)) continue;
    if (raycast(a[0], a[1] + EYE, a[2], b[0] - a[0], b[1] - a[1], b[2] - a[2], 0.02, 0.98) !== Infinity) continue;
    nodes[i].n.push(j);
    nodes[j].n.push(i);
  }
}

// Keep the largest connected component.
const comp = new Array(nodes.length).fill(-1);
let compCount = 0;
for (let i = 0; i < nodes.length; i++) {
  if (comp[i] !== -1) continue;
  const queue = [i];
  comp[i] = compCount;
  while (queue.length) for (const nb of nodes[queue.pop()].n) if (comp[nb] === -1) { comp[nb] = compCount; queue.push(nb); }
  compCount++;
}
const sizes = new Array(compCount).fill(0);
for (const c of comp) sizes[c]++;
const keepComp = sizes.indexOf(Math.max(...sizes));
const remap = new Map();
const kept = [];
for (let i = 0; i < nodes.length; i++) if (comp[i] === keepComp) { remap.set(i, kept.length); kept.push(nodes[i]); }
for (const node of kept) node.n = node.n.map((i) => remap.get(i));

// Round node positions for a compact file.
for (const node of kept) node.p = node.p.map((v) => Math.round(v * 1000) / 1000);

import('node:fs').then(({ writeFileSync }) => {
  writeFileSync(outNav, JSON.stringify({ meta: { cell, eye: EYE }, nodes: kept }));
  console.log(`${outNav}: ${kept.length} nodes (${candidates.length} candidates, largest of ${compCount} components), cell=${cell}`);
});
