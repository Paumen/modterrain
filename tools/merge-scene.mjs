import { readGlb, writeGlb } from './glb.mjs';
import { markSeeThrough, SEE_THROUGH_PIECES, SEE_THROUGH_TILE } from './see-through.mjs';

const input = process.argv[2];
if (!input) {
  console.error('usage: node tools/merge-scene.mjs <scene.glb>');
  process.exit(1);
}
const outGlb = input.replace(/\.glb$/, '_merged.glb');

const { json, bin } = readGlb(input);

const CTOR = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function accessorData(i) {
  const a = json.accessors[i];
  const bv = json.bufferViews[a.bufferView];
  const offset = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const Ctor = CTOR[a.componentType];
  return new Ctor(bin.buffer, bin.byteOffset + offset, a.count * NCOMP[a.type]);
}

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

const buckets = new Map();
const tris = [];
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
    const piece = (node.name || '').split('__')[0];
    const thin = SEE_THROUGH_PIECES.test(piece);
    for (const prim of json.meshes[node.mesh].primitives) {
      if ((prim.mode ?? 4) !== 4 || isHidden(prim.material)) continue;
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
        const tx = Math.floor((p0[0] + p1[0] + p2[0]) / 3 / SEE_THROUGH_TILE);
        const tz = Math.floor((p0[2] + p1[2] + p2[2]) / 3 / SEE_THROUGH_TILE);
        const key = thin ? `see|${tx}|${tz}|${prim.material}` : `${prim.material}`;
        let bucket = buckets.get(key);
        if (!bucket) buckets.set(key, (bucket = { pos: [], nrm: [], mat: prim.material, thin }));
        bucket.pos.push(...p0, ...p1, ...p2);
        bucket.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
        tris.push([...p0, ...p1, ...p2, prim.material, ny]);
      }
    }
  }
  for (const child of node.children || []) emitNode(child, world);
}

for (const root of json.scenes[json.scene ?? 0].nodes) emitNode(root, IDENTITY);

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
for (const [, bucket] of ordered) {
  const posAcc = addAccessor(new Float32Array(bucket.pos), 'VEC3', true);
  const nrmAcc = addAccessor(new Float32Array(bucket.nrm), 'VEC3', false);
  out.materials.push(structuredClone(json.materials[bucket.mat]));
  const name = bucket.thin ? markSeeThrough(matName(bucket.mat)) : matName(bucket.mat);
  out.meshes.push({
    name,
    primitives: [{ attributes: { POSITION: posAcc, NORMAL: nrmAcc }, material: out.materials.length - 1 }],
  });
  out.nodes.push({ name, mesh: out.meshes.length - 1 });
  out.scenes[0].nodes.push(out.nodes.length - 1);
}
out.buffers.push({ byteLength: byteOffset });

writeGlb(outGlb, out, Buffer.concat(chunks));
console.log(`${outGlb}: ${out.meshes.length} meshes, ${tris.length} triangles`);
