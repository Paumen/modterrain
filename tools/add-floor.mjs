// Bakes a real grid-plane mesh under each models/*.glb piece, sized and
// UV-mapped to its own true footprint in cells, and writes the result to
// thumbnails/. This is real scene geometry (not a CSS overlay) so it's
// correctly lit, occluded, and framed by model-viewer's own camera —
// see catalog.js's use of thumbnails/ for the Parts tab.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, writeGlb, measureScene, UNITS_PER_CELL } from './glb.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = join(ROOT, 'models');
const OUT_DIR = join(ROOT, 'thumbnails');
const GRID_PNG = readFileSync(join(ROOT, 'tools', 'assets', 'grid-tile.png'));

// Margin around the model's own footprint, so it doesn't sit flush with the
// floor's edge, snapped outward to whole cells below.
const PAD_UNITS = UNITS_PER_CELL / 2;

const align4 = (n) => (4 - (n % 4)) % 4;

function addBin(chunks, state, bytes) {
  const padding = align4(state.length);
  if (padding) chunks.push(Buffer.alloc(padding));
  const offset = state.length + padding;
  chunks.push(bytes);
  state.length = offset + bytes.length;
  return offset;
}

function addFloor(glb) {
  const measured = measureScene(glb);
  const [minXc, minYc, minZc] = measured.min;
  const [maxXc, , maxZc] = measured.max;
  if (!(maxXc > minXc) || !(maxZc > minZc)) return null; // no footprint to floor

  const minX = minXc * UNITS_PER_CELL;
  const maxX = maxXc * UNITS_PER_CELL;
  const minZ = minZc * UNITS_PER_CELL;
  const maxZ = maxZc * UNITS_PER_CELL;
  const floorY = minYc * UNITS_PER_CELL;

  const snapDown = (v) => Math.floor((v - PAD_UNITS) / UNITS_PER_CELL) * UNITS_PER_CELL;
  const snapUp = (v) => Math.ceil((v + PAD_UNITS) / UNITS_PER_CELL) * UNITS_PER_CELL;
  const fMinX = snapDown(minX);
  const fMaxX = snapUp(maxX);
  const fMinZ = snapDown(minZ);
  const fMaxZ = snapUp(maxZ);

  const json = structuredClone(glb.json);
  const chunks = [...(glb.bin ? [glb.bin] : [])];
  const state = { length: glb.bin ? glb.bin.length : 0 };

  // A: minX,minZ  B: maxX,minZ  C: maxX,maxZ  D: minX,maxZ — wound so the
  // face normal points +Y (see tools/add-floor.mjs test in PR description).
  const positions = new Float32Array([
    fMinX, floorY, fMinZ,
    fMaxX, floorY, fMinZ,
    fMaxX, floorY, fMaxZ,
    fMinX, floorY, fMaxZ,
  ]);
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
  const uvs = new Float32Array([
    fMinX / UNITS_PER_CELL, fMinZ / UNITS_PER_CELL,
    fMaxX / UNITS_PER_CELL, fMinZ / UNITS_PER_CELL,
    fMaxX / UNITS_PER_CELL, fMaxZ / UNITS_PER_CELL,
    fMinX / UNITS_PER_CELL, fMaxZ / UNITS_PER_CELL,
  ]);
  const indices = new Uint16Array([0, 2, 1, 0, 3, 2]);

  json.bufferViews ??= [];
  json.accessors ??= [];
  json.materials ??= [];
  json.textures ??= [];
  json.images ??= [];
  json.samplers ??= [];
  json.meshes ??= [];
  json.nodes ??= [];

  const pushBufferView = (bytes) => {
    const byteOffset = addBin(chunks, state, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    json.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength });
    return json.bufferViews.length - 1;
  };

  const positionAccessor = json.accessors.push({
    bufferView: pushBufferView(positions),
    componentType: 5126,
    count: 4,
    type: 'VEC3',
    min: [fMinX, floorY, fMinZ],
    max: [fMaxX, floorY, fMaxZ],
  }) - 1;
  const normalAccessor = json.accessors.push({
    bufferView: pushBufferView(normals), componentType: 5126, count: 4, type: 'VEC3',
  }) - 1;
  const uvAccessor = json.accessors.push({
    bufferView: pushBufferView(uvs), componentType: 5126, count: 4, type: 'VEC2',
  }) - 1;
  const indexAccessor = json.accessors.push({
    bufferView: pushBufferView(indices), componentType: 5123, count: 6, type: 'SCALAR',
  }) - 1;

  const imageBufferView = pushBufferView(GRID_PNG);
  const imageIndex = json.images.push({ mimeType: 'image/png', bufferView: imageBufferView }) - 1;
  // minFilter LINEAR, no mipmap: thumbnails render this plane small, and mip
  // minification thins the grid lines toward invisible; full-resolution
  // sampling at any distance keeps them present.
  // magFilter NEAREST: the detail panel views this plane large (auto-rotate,
  // camera-controls), where LINEAR magnification blurs a thin line into a
  // soft smear. NEAREST keeps the line edge crisp there.
  const samplerIndex = json.samplers.push({ wrapS: 10497, wrapT: 10497, magFilter: 9728, minFilter: 9729 }) - 1;
  const textureIndex = json.textures.push({ source: imageIndex, sampler: samplerIndex }) - 1;
  const materialIndex = json.materials.push({
    name: 'Floor Grid',
    // MASK, not BLEND: this model-viewer build renders BLEND-mode floors
    // invisible outright (a transparent-pass ordering issue, not a fade
    // problem). A low cutoff keeps the grid surviving mipmap minification
    // at small thumbnail sizes, where the line texture is thinned a lot.
    pbrMetallicRoughness: { baseColorTexture: { index: textureIndex }, metallicFactor: 0, roughnessFactor: 1 },
    alphaMode: 'MASK',
    alphaCutoff: 0.1,
    extensions: { KHR_materials_unlit: {} },
  }) - 1;

  const meshIndex = json.meshes.push({
    name: 'Floor',
    primitives: [{
      attributes: { POSITION: positionAccessor, NORMAL: normalAccessor, TEXCOORD_0: uvAccessor },
      indices: indexAccessor,
      material: materialIndex,
    }],
  }) - 1;

  const nodeIndex = json.nodes.push({ name: 'Floor', mesh: meshIndex }) - 1;

  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), 'KHR_materials_unlit'])];

  const sceneIndex = json.scene ?? 0;
  json.scenes[sceneIndex].nodes.push(nodeIndex);

  const bin = Buffer.concat(chunks);
  json.buffers = [{ byteLength: bin.length }];
  return { json, bin };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const files = readdirSync(MODELS_DIR).filter((name) => name.endsWith('.glb')).sort();

  let written = 0;
  let skipped = 0;
  for (const file of files) {
    const glb = readGlb(join(MODELS_DIR, file));
    const floored = addFloor(glb);
    if (!floored) { skipped++; continue; }
    writeGlb(join(OUT_DIR, file), floored.json, floored.bin);
    written++;
  }
  console.log(`${written} floored, ${skipped} skipped (no footprint) → ${OUT_DIR}`);
}

main();
