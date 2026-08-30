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
  let minX = Infinity, maxX = -Infinity;
  for (let v = 0; v < pos.length; v += 3) {
    const p = xformPoint(node.matrix || localMatrix(node), pos[v], pos[v + 1], pos[v + 2]);
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
  }
  cell = maxX - minX;
  break;
}

const WALKABLE = new Set(['Grass', 'Dirt', 'Carved Stone Walkway', 'Wood Dark', 'Wood Medium', 'Wood Light']);
const STEP = 3 * cell;          // node spacing
const EYE = 1.2 * cell;         // camera target height above ground
const BETA = 1.05;              // polar angle of the orbit, from +Y
const MIN_R = 2.5 * cell, MAX_R = 10 * cell, MARGIN = 0.6 * cell;

// Per-triangle AABBs for quick rejection.
const triBox = tris.map(([x0, y0, z0, x1, y1, z1, x2, y2, z2]) => [
  Math.min(x0, x1, x2), Math.min(y0, y1, y2), Math.min(z0, z1, z2),
  Math.max(x0, x1, x2), Math.max(y0, y1, y2), Math.max(z0, z1, z2),
]);

// All surface heights at (x, z): [y, matIndex, ny] per covering triangle.
function heightsAt(x, z) {
  const hits = [];
  for (let t = 0; t < tris.length; t++) {
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

const walkableHit = ([, mat, ny]) => WALKABLE.has(matName(mat)) && ny > 0.7;

function hasSupport(x, z, y) {
  const d = 0.35 * cell;
  for (const [ox, oz] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
    if (!heightsAt(x + ox, z + oz).some((h) => walkableHit(h) && Math.abs(h[0] - y) <= 0.7 * cell)) return false;
  }
  return true;
}

// Nearest ray hit against the whole scene (Moller-Trumbore), t in (tMin, tMax).
function raycast(ox, oy, oz, dx, dy, dz, tMin, tMax) {
  let best = Infinity;
  for (let t = 0; t < tris.length; t++) {
    const b = triBox[t];
    // slab test
    let lo = tMin, hi = Math.min(tMax, best);
    let ok = true;
    for (let a = 0; a < 3; a++) {
      const o = a === 0 ? ox : a === 1 ? oy : oz;
      const d = a === 0 ? dx : a === 1 ? dy : dz;
      if (Math.abs(d) < 1e-12) {
        if (o < b[a] || o > b[a + 3]) { ok = false; break; }
      } else {
        let t0 = (b[a] - o) / d, t1 = (b[a + 3] - o) / d;
        if (t0 > t1) [t0, t1] = [t1, t0];
        lo = Math.max(lo, t0); hi = Math.min(hi, t1);
        if (lo > hi) { ok = false; break; }
      }
    }
    if (!ok) continue;
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
  return best;
}

// Sample a grid over the scene for walkable spots (all height levels, so
// bridges and cave floors get their own nodes).
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const b of triBox) {
  if (b[0] < minX) minX = b[0];
  if (b[3] > maxX) maxX = b[3];
  if (b[2] < minZ) minZ = b[2];
  if (b[5] > maxZ) maxZ = b[5];
}

const nodes = [];
for (let x = minX + STEP / 2; x < maxX; x += STEP) {
  for (let z = minZ + STEP / 2; z < maxZ; z += STEP) {
    const hits = heightsAt(x, z);
    const levels = hits.filter(walkableHit).map((h) => h[0]).sort((a, b) => a - b);
    let last = -Infinity;
    for (const y of levels) {
      if (y - last < 0.5 * cell) continue;
      last = y;
      const blocked = hits.some((h) => h[0] > y + 0.15 * cell && h[0] <= y + 1.6 * cell);
      if (blocked || !hasSupport(x, z, y)) continue;
      nodes.push({ p: [x, y, z], n: [] });
    }
  }
}

// Edges: near neighbours with a clear line of sight at eye height.
for (let i = 0; i < nodes.length; i++) {
  for (let j = i + 1; j < nodes.length; j++) {
    const [ax, ay, az] = nodes[i].p, [bx, by, bz] = nodes[j].p;
    if (Math.hypot(bx - ax, bz - az) > 1.7 * STEP || Math.abs(by - ay) > 1.2 * cell) continue;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    if (raycast(ax, ay + EYE, az, dx, dy, dz, 0.02, 0.98) !== Infinity) continue;
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
const keep = sizes.indexOf(Math.max(...sizes));
const remap = new Map();
const kept = [];
for (let i = 0; i < nodes.length; i++) if (comp[i] === keep) { remap.set(i, kept.length); kept.push(nodes[i]); }
for (const node of kept) node.n = node.n.map((i) => remap.get(i));

// Orbit radii: at each of the 8 headings, how far back the camera can pull
// before hitting something. Direction matches an ArcRotateCamera at (alpha,
// BETA): target + r * (cos a sin b, cos b, sin a sin b).
for (const node of kept) {
  const [x, y, z] = node.p;
  node.r = [];
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const dx = Math.cos(a) * Math.sin(BETA), dy = Math.cos(BETA), dz = Math.sin(a) * Math.sin(BETA);
    const hit = raycast(x, y + EYE, z, dx, dy, dz, 0, MAX_R);
    node.r.push(Math.round(Math.min(Math.max(hit - MARGIN, MIN_R), MAX_R) * 100) / 100);
  }
  node.p = node.p.map((v) => Math.round(v * 1000) / 1000);
}

import('node:fs').then(({ writeFileSync }) => {
  writeFileSync(outNav, JSON.stringify({
    meta: { cell, eye: EYE, beta: BETA, minR: MIN_R, maxR: MAX_R },
    nodes: kept,
  }));
  console.log(`${outNav}: ${kept.length} nodes (${nodes.length} sampled, kept largest of ${compCount} components), cell=${cell}`);
});
