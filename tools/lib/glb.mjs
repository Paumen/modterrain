import { readFileSync, writeFileSync } from 'node:fs';

export function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) {
    throw new Error(`not a valid GLB: ${path}`);
  }
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`first chunk is not JSON: ${path}`);

  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));

  let bin = null;
  let offset = 20 + jsonLength;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    if (type === 0x004e4942) bin = buf.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length;
  }

  return { json, bin, bytes: buf.length };
}

// Each chunk is padded to 4 bytes: JSON with spaces, BIN with zeroes.
export function writeGlb(path, json, bin) {
  const pad = (n) => (4 - (n % 4)) % 4;

  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(pad(jsonBuf.length), 0x20)]);
  const binChunk = Buffer.concat([bin, Buffer.alloc(pad(bin.length), 0)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonChunkHeader.writeUInt32LE(0x4e4f534a, 4);

  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(binChunk.length, 0);
  binChunkHeader.writeUInt32LE(0x004e4942, 4);

  writeFileSync(path, Buffer.concat([header, jsonChunkHeader, jsonChunk, binChunkHeader, binChunk]));
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiplyMatrix(a, b) {
  const r = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      r[col * 4 + row] = sum;
    }
  }
  return r;
}

function nodeMatrix(node) {
  if (node.matrix) return node.matrix;

  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
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

export const transformPoint = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

const COMPONENT = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const WIDTHS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function readAccessor({ json, bin }, index) {
  const accessor = json.accessors[index];
  if (accessor.sparse) throw new Error('sparse accessors are not supported');

  const Kind = COMPONENT[accessor.componentType];
  const width = WIDTHS[accessor.type];
  const bufferView = json.bufferViews[accessor.bufferView];
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = bufferView.byteStride ?? width * Kind.BYTES_PER_ELEMENT;

  const out = new Float64Array(accessor.count * width);
  for (let i = 0; i < accessor.count; i++) {
    const row = new Kind(bin.buffer, bin.byteOffset + start + i * stride, width);
    for (let k = 0; k < width; k++) out[i * width + k] = row[k];
  }
  return { data: out, width, count: accessor.count };
}

export const UNITS_PER_CELL = 1;

/* Where each node ends up once its parents have had their say. Indexed like
 * `json.nodes`; a node the scene never reaches stays null. */
export function nodeWorldMatrices(json) {
  const nodes = json.nodes ?? [];
  const scene = json.scenes?.[json.scene ?? 0];

  const world = new Array(nodes.length).fill(null);
  const setWorld = (index, parent) => {
    if (world[index]) return; // cycle guard
    const node = nodes[index];
    if (!node) return;
    world[index] = multiplyMatrix(parent, nodeMatrix(node));
    for (const child of node.children ?? []) setWorld(child, world[index]);
  };
  for (const index of scene?.nodes ?? []) setWorld(index, IDENTITY_MATRIX);
  return world;
}

export function measureScene(glb) {
  const { json } = glb;
  const nodes = json.nodes ?? [];
  const world = nodeWorldMatrices(json);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const grow = (p) => {
    for (let axis = 0; axis < 3; axis++) {
      if (p[axis] < min[axis]) min[axis] = p[axis];
      if (p[axis] > max[axis]) max[axis] = p[axis];
    }
  };

  let triangles = 0;
  let calls = 0;
  const materials = new Set();

  nodes.forEach((node, index) => {
    if (node.mesh === undefined || !world[index]) return;

    for (const prim of json.meshes[node.mesh].primitives ?? []) {
      calls++;
      if (prim.material !== undefined) materials.add(prim.material);

      const count = prim.indices !== undefined
        ? json.accessors[prim.indices]
        : json.accessors[prim.attributes.POSITION];
      if ((prim.mode ?? 4) === 4) triangles += Math.floor((count?.count ?? 0) / 3);

      const position = readAccessor(glb, prim.attributes.POSITION);
      for (let v = 0; v < position.count; v++) {
        grow(transformPoint(world[index], position.data[v * 3], position.data[v * 3 + 1], position.data[v * 3 + 2]));
      }
    }
  });

  const round = (v) => Math.round((v / UNITS_PER_CELL) * 1000) / 1000;
  const measure = (axis) => (min[axis] === Infinity ? 0 : round(max[axis] - min[axis]));

  return {
    // dwh is width × depth × height, i.e. X, Z, Y.
    dwh: [measure(0), measure(2), measure(1)],
    min: min.map((v) => (Number.isFinite(v) ? round(v) : 0)),
    max: max.map((v) => (Number.isFinite(v) ? round(v) : 0)),
    triangles,
    calls,
    materialIndices: [...materials],
  };
}

export const BUDGET_PER_UNIT = 250;

export function trianglesPerUnit(triangles, dwh) {
  if (dwh.some((size) => size === 0)) return null;
  // The max(1, …) floors are required: without them density scales as 1/size³
  // and no sub-cell piece could pass the budget.
  const cells = Math.max(1, dwh[0] * dwh[1]) * Math.max(1, dwh[2]);
  return Math.round(triangles / cells);
}
