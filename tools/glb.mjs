/**
 * Read and measure GLB files.
 *
 * The catalog measures each model exactly as it sits in its scene, since
 * that's what the placement grid cares about. This pack isn't skinned —
 * everything is static geometry under a node tree — so the bounding box
 * follows straight from the POSITION accessors through their node's world
 * matrix.
 */

import { readFileSync, writeFileSync } from 'node:fs';

/* -- container --------------------------------------------------------
 * GLB: a 12-byte header, then chunks of [length, type, data]. The first
 * chunk is the glTF JSON, the second (if present) is the binary buffer.
 */
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

/**
 * Writes `json` + `bin` back out as a GLB. The inverse of `readGlb`: same
 * 12-byte header, same JSON-chunk-then-BIN-chunk layout, each padded to a
 * 4-byte boundary as the spec requires (JSON with ASCII spaces, BIN with
 * zero bytes).
 */
export function writeGlb(path, json, bin) {
  const pad = (n) => (4 - (n % 4)) % 4;

  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(pad(jsonBuf.length), 0x20)]);
  const binChunk = Buffer.concat([bin, Buffer.alloc(pad(bin.length), 0)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // magic: 'glTF'
  header.writeUInt32LE(2, 4); // version
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonChunkHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(binChunk.length, 0);
  binChunkHeader.writeUInt32LE(0x004e4942, 4); // 'BIN\0'

  writeFileSync(path, Buffer.concat([header, jsonChunkHeader, jsonChunk, binChunkHeader, binChunk]));
}

/**
 * Embeds a PNG's bytes into a GLB in place of `images[imageIndex]`'s current
 * (broken) `uri`, appending the pixel data to the binary chunk and pointing
 * the image at a fresh bufferView instead. Returns the updated `{ json, bin }`
 * — `glb` itself is left untouched, matching `readAccessor`'s no-mutation
 * convention.
 *
 * Alignment matters here in a way it doesn't for `readGlb`: a bufferView's
 * `byteOffset` must land on a 4-byte boundary, so the bin buffer is padded
 * before the new bytes are appended, not just at the very end the way
 * `writeGlb` pads the whole chunk.
 */
export function embedImage(glb, imageIndex, pngBytes) {
  const json = structuredClone(glb.json);
  const pad = (4 - (glb.bin.length % 4)) % 4;
  const bin = Buffer.concat([glb.bin, Buffer.alloc(pad), pngBytes]);

  json.bufferViews.push({
    buffer: 0,
    byteOffset: glb.bin.length + pad,
    byteLength: pngBytes.length,
  });
  json.images[imageIndex] = { mimeType: 'image/png', bufferView: json.bufferViews.length - 1 };

  return { json, bin };
}

/* -- matrices -----------------------------------------------------------
 * Column-major, as glTF delivers them.
 */
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

/** Node transform as a matrix; `matrix` wins over separate translation/rotation/scale. */
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

/** Point through a column-major matrix. */
const transformPoint = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

/* -- accessors ------------------------------------------------------------ */

const COMPONENT = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const WIDTHS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/**
 * Reads an accessor out as a flat Float64Array. Sparse accessors don't occur
 * in this pack; if one ever shows up, a hard error beats silently measuring
 * the wrong points.
 */
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

/* -- measuring -------------------------------------------------------- */

/**
 * One grid cell of this pack, in the units the source files use.
 *
 * Measured, not assumed: every piece named `1x1` is 100 wide or deep,
 * `12x12` is 1200, and `7x7` is 700. Height follows the same grid — a
 * single-layer base block is 100 tall, a two-layer wall piece is 200. The
 * catalog reports everything in grid cells for that reason: "0.5 × 1 × 1"
 * reads at a glance as a half-cell-deep, one-layer-tall wall piece,
 * "50 × 100 × 100" doesn't unless you do the division yourself.
 *
 * The build checks this assumption against the size encoded in each
 * filename on every run.
 */
export const UNITS_PER_CELL = 100;

/**
 * Measures a scene: dimensions, corner points, triangles, and draw calls.
 *
 * - `dwh`: width × depth × height (X × Z × Y) in grid cells.
 * - `min`/`max`: the bounding box itself, in the same units as the source
 *   files (before the grid-cell rounding below).
 * - `triangles`: as the scene draws them — a mesh reused by three nodes
 *   counts three times, because that's what the GPU does.
 * - `calls`: each primitive is one draw call.
 */
export function measureScene(glb) {
  const { json } = glb;
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

  // Everything in grid cells, to three decimals. Without rounding, float
  // arithmetic leaves 1.0000000298023224 in the catalog; three decimals is
  // ample for a pack modeled to 1/16 of a cell.
  const round = (v) => Math.round((v / UNITS_PER_CELL) * 1000) / 1000;
  const measure = (axis) => (min[axis] === Infinity ? 0 : round(max[axis] - min[axis]));

  return {
    dwh: [measure(0), measure(2), measure(1)],
    min: min.map((v) => (Number.isFinite(v) ? round(v) : 0)),
    max: max.map((v) => (Number.isFinite(v) ? round(v) : 0)),
    triangles,
    calls,
    materialIndices: [...materials],
  };
}

/**
 * The draw budget, in triangles per 1 × 1 × 1 grid cell. Here and nowhere
 * else: build-catalog.mjs writes it into catalog.json and the browser reads
 * it from there, so one change here propagates everywhere.
 *
 * This pack is unusually lean — half its pieces don't even reach fifty
 * triangles — so the limit sits far lower than a typical prop kit would use.
 * It's set well above the ordinary pieces and below the handful of models
 * that genuinely stand out: the rope bridges and the high-poly water circle.
 */
export const BUDGET_PER_UNIT = 250;

/**
 * Triangles per occupied grid cell, measured against BUDGET_PER_UNIT above.
 *
 * The denominator is the number of cells the model occupies, with one cell
 * as a floor: max(1, w × d) × max(1, h). Without that floor, density grows
 * with 1/size³ and no small object could ever pass — a fence post of
 * 0.1 × 0.1 × 0.4 would need to come in under one triangle. A 2 × 2 floor
 * tile is still billed for four cells, and a post smaller than one cell gets
 * no discount for being small: its budget is exactly that of one cell.
 *
 * A flat model stays `null`: it has no volume, and with a handful of
 * triangles it's already outside any budget discussion.
 *
 * @param {number} triangles  count from measureScene()
 * @param {number[]} dwh      width × depth × height in grid cells
 * @returns {number|null} triangles per occupied cell, rounded; null for a flat model
 */
export function trianglesPerUnit(triangles, dwh) {
  if (dwh.some((size) => size === 0)) return null;
  const cells = Math.max(1, dwh[0] * dwh[1]) * Math.max(1, dwh[2]);
  return Math.round(triangles / cells);
}
