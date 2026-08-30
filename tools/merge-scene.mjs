// Collapse a scene GLB into one mesh per visible material and generate a
// navigation graph for viewer.html.
//
//   node tools/merge-scene.mjs scenes/Large_Island_v2_No_Ocean_No_Props.glb
//
// Writes <scene>_merged.glb (Hidden* faces dropped, transforms baked, flat
// normals, de-indexed) and <scene>_nav.json (camera nodes with edges and
// per-angle orbit radii, precomputed so the viewer needs no collision code).

import { readGlb, writeGlb } from './glb.mjs';
import { existsSync } from 'node:fs';

const input = process.argv[2];
if (!input) {
  console.error('usage: node tools/merge-scene.mjs <scene.glb>');
  process.exit(1);
}
const outGlb = input.replace(/\.glb$/, '_merged.glb');
// A nav graph that already exists has probably been curated by hand in the
// viewer's editor, so it is never overwritten without --force: the fresh one
// is written alongside it instead.
const force = process.argv.includes('--force');
const navPath = input.replace(/\.glb$/, '_nav.json');
const outNav = !force && existsSync(navPath) ? input.replace(/\.glb$/, '_nav.generated.json') : navPath;

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

// Camera nodes sit on a triangular lattice: every interior node has exactly
// six neighbours, all the same distance away, so the graph is uniform and
// stays predictable as nodes are pruned by hand in the viewer's editor.
const LATTICE = Number(process.argv[3]) || 1.5; // spacing in grid cells
const S = LATTICE * cell;                       // XZ distance between neighbours
const ROW = (S * Math.sqrt(3)) / 2;             // row pitch of the lattice
const EYE = 1.2 * cell;                         // camera target height above ground

// Cliff is included because cave floors and rock ledges carry it; only
// up-facing faces ever qualify, so cliff walls are still excluded.
const WALKABLE = new Set([
  'Carved Stone Walkway', 'Wood Dark', 'Wood Medium', 'Wood Light', 'Dirt', 'Grass', 'Cliff',
]);
const PATHY = new Set(['Carved Stone Walkway', 'Wood Dark', 'Wood Medium', 'Wood Light']);
const walkableHit = ([, mat, ny]) => WALKABLE.has(matName(mat)) && ny > 0.7;

// Enough ground around the point to stand on, without demanding a full
// neighbourhood: narrow walkways and ledges keep their nodes.
function hasSupport(x, z, y) {
  const d = 0.35 * cell;
  let ok = 0;
  for (const [ox, oz] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
    if (heightsAt(x + ox, z + oz).some((h) => walkableHit(h) && Math.abs(h[0] - y) <= 0.7 * cell)) ok++;
  }
  return ok >= 2;
}

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

// One node per walkable level at each lattice point, so bridges, cave floors
// and the ground beneath them each get their own.
const nodes = [];
const grid = new Map();
const cols = Math.ceil((maxX - minX) / S) + 1;
const rows = Math.ceil((maxZ - minZ) / ROW) + 1;
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const x = minX + c * S + (r % 2) * (S / 2);
    const z = minZ + r * ROW;
    if (x > maxX || z > maxZ) continue;
    const hits = heightsAt(x, z);
    const levels = hits.filter(walkableHit).sort((p, q) => p[0] - q[0]);
    const here = [];
    let last = -Infinity;
    for (const [y, mat] of levels) {
      if (y - last < 0.5 * cell) continue;
      last = y;
      const blocked = hits.some((h) => h[0] > y + 0.15 * cell && h[0] <= y + 1.1 * cell);
      if (blocked || !hasSupport(x, z, y)) continue;
      // Under a cave roof the camera target has to duck, or it sits in the
      // ceiling and the collision clamp leaves nothing to look at.
      const ceiling = hits.filter((h) => h[2] < -0.3 && h[0] > y + 1 && h[0] < y + 18)
        .map((h) => h[0]).sort((a, b) => a - b)[0];
      const eyeHere = ceiling === undefined ? EYE
        : Math.max(0.5 * cell, Math.min(EYE, ceiling - y - 0.6 * cell));
      // Surface class only steers routing cost; placement stays uniform.
      let grassAround = 0;
      for (let k = 0; k < 8; k++) {
        const ox = Math.cos((k * Math.PI) / 4) * 2 * cell, oz = Math.sin((k * Math.PI) / 4) * 2 * cell;
        if (heightsAt(x + ox, z + oz).some((h) => walkableHit(h) && matName(h[1]) === 'Grass' && Math.abs(h[0] - y) <= 0.9 * cell)) grassAround++;
      }
      const name = matName(mat);
      const cls = PATHY.has(name) || (name === 'Dirt' && grassAround >= 3) ? 'p' : name === 'Dirt' ? 'd' : 'g';
      here.push(nodes.length);
      const node = { p: [x, y, z], s: cls, n: [] };
      if (eyeHere < EYE - 1e-6) node.e = Math.round(eyeHere * 100) / 100;
      if (ceiling !== undefined) node.cave = true;
      nodes.push(node);
    }
    if (here.length) grid.set(`${r},${c}`, here);
  }
}

// Edges to the three "forward" lattice neighbours (the other three come from
// the neighbours' own passes), so every interior node ends up with six.
// The only test is whether the straight line between the two camera targets
// is actually clear: no rules about how steep a link may be or what the
// ground does under it. Everything geometry allows is offered, and unwanted
// links are pruned by hand in the viewer.
function link(i, j) {
  const a = nodes[i].p, b = nodes[j].p;
  if (nodes[i].n.includes(j)) return;
  if (raycast(a[0], a[1] + EYE, a[2], b[0] - a[0], b[1] - a[1], b[2] - a[2], 0.02, 0.98) !== Infinity) return;
  nodes[i].n.push(j);
  nodes[j].n.push(i);
}
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const here = grid.get(`${r},${c}`);
    if (!here) continue;
    const odd = r % 2;
    for (const [nr, nc] of [[r, c + 1], [r + 1, c + (odd ? 0 : -1)], [r + 1, c + (odd ? 1 : 0)]]) {
      const there = grid.get(`${nr},${nc}`);
      if (!there) continue;
      // Every level pair is offered; the sightline decides.
      for (const i of here) for (const j of there) link(i, j);
    }
  }
}

// Drop strays: a handful of disconnected nodes can never be travelled to.
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
const remap = new Map();
const kept = [];
for (let i = 0; i < nodes.length; i++) if (sizes[comp[i]] >= 3) { remap.set(i, kept.length); kept.push(nodes[i]); }
for (const node of kept) node.n = node.n.map((i) => remap.get(i)).filter((i) => i !== undefined);

// Tie stranded pockets to the nearest node they can actually see: a group
// nothing reaches is a group you can only be stuck in.
{
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const components = () => {
    const comp = new Array(kept.length).fill(-1);
    let c = 0;
    for (let i = 0; i < kept.length; i++) {
      if (comp[i] !== -1) continue;
      const q = [i]; comp[i] = c;
      while (q.length) for (const nb of kept[q.pop()].n) if (comp[nb] === -1) { comp[nb] = c; q.push(nb); }
      c++;
    }
    return comp;
  };
  let bridged = 0;
  for (let round = 0; round < 8; round++) {
    const comp = components();
    const sizes = {};
    comp.forEach((c) => { sizes[c] = (sizes[c] || 0) + 1; });
    const main = Object.entries(sizes).sort((a, b) => b[1] - a[1])[0][0] | 0;
    const stranded = kept.map((_, i) => i).filter((i) => comp[i] !== main);
    if (!stranded.length) break;
    let did = false;
    for (const i of stranded) {
      let best = -1, bestD = Infinity;
      for (let j = 0; j < kept.length; j++) {
        if (comp[j] !== main) continue;
        const d = near(kept[i].p, kept[j].p);
        if (d > 4 * S || d >= bestD) continue;
        const a = kept[i].p, b = kept[j].p;
        const ea = kept[i].e ?? EYE, eb = kept[j].e ?? EYE;
        if (raycast(a[0], a[1] + ea, a[2], b[0] - a[0], (b[1] + eb) - (a[1] + ea), b[2] - a[2], 0.02, 0.98) !== Infinity) continue;
        bestD = d; best = j;
      }
      if (best >= 0) { kept[i].n.push(best); kept[best].n.push(i); bridged++; did = true; }
    }
    if (!did) break;
  }
  if (bridged) console.log(`bridged ${bridged} stranded node(s) into the main graph`);
}

// Round node positions for a compact file.
for (const node of kept) node.p = node.p.map((v) => Math.round(v * 1000) / 1000);

import('node:fs').then(({ writeFileSync, readFileSync }) => {
  let out = kept;
  // --caves keeps the existing hand-curated graph and only adds the nodes it
  // is missing inside caves and under overhangs, linked by sightline.
  if (process.argv.includes('--caves') && existsSync(navPath)) {
    const prev = JSON.parse(readFileSync(navPath, 'utf8'));
    const merged = prev.nodes.map((n) => ({ ...n, n: n.n.slice() }));
    const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    const added = [];
    for (const cand of kept) {
      if (!cand.cave) continue;
      if (merged.some((m) => near(m.p, cand.p) < 0.8 * S)) continue;
      const node = { p: cand.p, s: cand.s, n: [] };
      if (cand.e !== undefined) node.e = cand.e;
      merged.push(node);
      added.push(merged.length - 1);
    }
    for (const i of added) {
      for (let j = 0; j < merged.length; j++) {
        if (j === i || merged[i].n.includes(j)) continue;
        const a = merged[i].p, b = merged[j].p;
        if (near(a, b) > 1.35 * S) continue;
        const eyeA = merged[i].e ?? EYE, eyeB = merged[j].e ?? EYE;
        const dx = b[0] - a[0], dy = (b[1] + eyeB) - (a[1] + eyeA), dz = b[2] - a[2];
        if (raycast(a[0], a[1] + eyeA, a[2], dx, dy, dz, 0.02, 0.98) !== Infinity) continue;
        merged[i].n.push(j);
        merged[j].n.push(i);
      }
    }
    // A cave pocket is useless if nothing outside reaches it, so each group
    // that ended up on its own is tied to the nearest node it can actually
    // see, widening the search until something connects.
    const link = (i, j) => { merged[i].n.push(j); merged[j].n.push(i); };
    const components = () => {
      const comp = new Array(merged.length).fill(-1);
      let c = 0;
      for (let i = 0; i < merged.length; i++) {
        if (comp[i] !== -1) continue;
        const q = [i]; comp[i] = c;
        while (q.length) for (const nb of merged[q.pop()].n) if (comp[nb] === -1) { comp[nb] = c; q.push(nb); }
        c++;
      }
      return comp;
    };
    let bridged = 0;
    for (let round = 0; round < 6; round++) {
      const comp = components();
      const sizes = {};
      comp.forEach((c) => { sizes[c] = (sizes[c] || 0) + 1; });
      const mainComp = Object.entries(sizes).sort((a, b) => b[1] - a[1])[0][0] | 0;
      const stranded = added.filter((i) => comp[i] !== mainComp);
      if (!stranded.length) break;
      let did = false;
      for (const i of stranded) {
        let best = -1, bestD = Infinity;
        for (let j = 0; j < merged.length; j++) {
          if (comp[j] !== mainComp) continue;
          const a = merged[i].p, b = merged[j].p;
          const d = near(a, b);
          if (d > 3.5 * S || d >= bestD) continue;
          const eyeA = merged[i].e ?? EYE, eyeB = merged[j].e ?? EYE;
          if (raycast(a[0], a[1] + eyeA, a[2], b[0] - a[0], (b[1] + eyeB) - (a[1] + eyeA), b[2] - a[2], 0.02, 0.98) !== Infinity) continue;
          bestD = d; best = j;
        }
        if (best >= 0) { link(i, best); bridged++; did = true; }
      }
      if (!did) break;
    }
    console.log(`--caves: added ${added.length} cave nodes to the ${prev.nodes.length} already there, ${bridged} tied into the main graph`);
    writeFileSync(navPath, JSON.stringify({ meta: { cell, eye: EYE }, nodes: merged }));
    console.log(`${navPath}: ${merged.length} nodes`);
    return;
  }
  for (const n of out) delete n.cave;
  writeFileSync(outNav, JSON.stringify({ meta: { cell, eye: EYE }, nodes: out }));
  const degs = kept.map((n) => n.n.length);
  const six = degs.filter((d) => d === 6).length;
  if (outNav !== navPath) console.log(`note: ${navPath} exists and was kept; pass --force to replace it`);
  console.log(`${outNav}: ${kept.length} nodes, spacing ${S.toFixed(1)} (${LATTICE} cells), ` +
    `avg degree ${(degs.reduce((a, b) => a + b, 0) / kept.length).toFixed(2)}, ${six} with the full six`);
});
