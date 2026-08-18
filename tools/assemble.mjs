import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, writeGlb, measureScene, UNITS_PER_CELL } from './glb.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ATOMS = join(ROOT, 'atoms');
const PLACEMENTS = join(ROOT, 'assemblies', 'placements.json');

/* Placements are Unity left-handed; the GLBs were mirrored in X by the FBX →
 * glTF conversion, so each transform must be conjugated by diag(-1, 1, 1):
 * translation x flips, quaternion y and z negate, scale is untouched. Without
 * it pieces overlap by whole tiles.
 */
const placeNode = (pos, quat, scale, mirror) => ({
  translation: [(mirror ? -pos[0] : pos[0]) * UNITS_PER_CELL, pos[1] * UNITS_PER_CELL, pos[2] * UNITS_PER_CELL],
  rotation: mirror ? [quat[0], -quat[1], -quat[2], quat[3]] : quat,
  scale,
});

const align4 = (n) => (4 - (n % 4)) % 4;

function createMerged() {
  return {
    json: {
      asset: { version: '2.0', generator: 'modterrain tools/assemble.mjs' },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
      meshes: [],
      accessors: [],
      bufferViews: [],
      buffers: [{ byteLength: 0 }],
      materials: [],
    },
    materialKeys: new Map(),
    chunks: [],
    binLength: 0,
    extensionsUsed: new Set(),
    extensionsRequired: new Set(),
  };
}

function addBin(out, bin) {
  const padding = align4(out.binLength);
  if (padding) out.chunks.push(Buffer.alloc(padding));
  const offset = out.binLength + padding;
  out.chunks.push(bin);
  out.binLength = offset + bin.length;
  return offset;
}

const TEXTURE_INFO_KEYS = new Set(['index', 'texCoord', 'scale', 'strength', 'extensions', 'extras']);

const isTextureInfo = (value) => typeof value.index === 'number'
  && Object.keys(value).every((key) => TEXTURE_INFO_KEYS.has(key));

function remapTextures(value, textureMap) {
  if (Array.isArray(value)) return value.map((item) => remapTextures(item, textureMap));
  if (!value || typeof value !== 'object') return value;

  const out = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remapTextures(child, textureMap)]));
  if (isTextureInfo(out) && textureMap.has(out.index)) out.index = textureMap.get(out.index);
  return out;
}

function checkSupported(json) {
  const unsupported = [
    [(json.accessors ?? []).some((accessor) => accessor.sparse), 'sparse accessors'],
    [(json.meshes ?? []).some((mesh) => (mesh.primitives ?? []).some((prim) => prim.targets)), 'morph targets'],
    [json.skins?.length, 'skins'],
    [json.animations?.length, 'animations'],
    [json.cameras?.length, 'cameras'],
    [(json.nodes ?? []).some((node) => node.extensions), 'node extensions'],
  ];
  const found = unsupported.filter(([present]) => present).map(([, name]) => name);
  if (found.length) throw new Error(`assemble.mjs merges static geometry only; this piece uses ${found.join(', ')}`);
}

function addPiece(out, glb) {
  const { json, bin } = glb;
  checkSupported(json);
  const binOffset = bin ? addBin(out, bin) : 0;

  for (const name of json.extensionsUsed ?? []) out.extensionsUsed.add(name);
  for (const name of json.extensionsRequired ?? []) out.extensionsRequired.add(name);

  const viewMap = new Map();
  (json.bufferViews ?? []).forEach((view, index) => {
    viewMap.set(index, out.json.bufferViews.length);
    out.json.bufferViews.push({ ...view, buffer: 0, byteOffset: (view.byteOffset ?? 0) + binOffset });
  });

  const accessorMap = new Map();
  (json.accessors ?? []).forEach((accessor, index) => {
    accessorMap.set(index, out.json.accessors.length);
    out.json.accessors.push({ ...accessor, bufferView: viewMap.get(accessor.bufferView) });
  });

  const samplerMap = new Map();
  (json.samplers ?? []).forEach((sampler, index) => {
    out.json.samplers ??= [];
    samplerMap.set(index, out.json.samplers.length);
    out.json.samplers.push({ ...sampler });
  });

  const imageMap = new Map();
  (json.images ?? []).forEach((image, index) => {
    out.json.images ??= [];
    imageMap.set(index, out.json.images.length);
    out.json.images.push(image.bufferView === undefined ? { ...image } : { ...image, bufferView: viewMap.get(image.bufferView) });
  });

  const textureMap = new Map();
  (json.textures ?? []).forEach((texture, index) => {
    out.json.textures ??= [];
    const copy = { ...texture };
    if (copy.source !== undefined) copy.source = imageMap.get(copy.source);
    if (copy.sampler !== undefined) copy.sampler = samplerMap.get(copy.sampler);
    textureMap.set(index, out.json.textures.length);
    out.json.textures.push(copy);
  });

  const materialMap = new Map();
  (json.materials ?? []).forEach((material, index) => {
    const remapped = remapTextures(material, textureMap);
    const key = JSON.stringify(remapped);
    const existing = out.materialKeys.get(key);
    if (existing !== undefined) {
      materialMap.set(index, existing);
      return;
    }
    materialMap.set(index, out.json.materials.length);
    out.materialKeys.set(key, out.json.materials.length);
    out.json.materials.push(remapped);
  });

  const meshMap = new Map();
  (json.meshes ?? []).forEach((mesh, index) => {
    const primitives = (mesh.primitives ?? []).map((prim) => {
      const attributes = Object.fromEntries(
        Object.entries(prim.attributes).map(([name, accessor]) => [name, accessorMap.get(accessor)]),
      );
      const copy = { ...prim, attributes };
      if (prim.indices !== undefined) copy.indices = accessorMap.get(prim.indices);
      if (prim.material !== undefined) copy.material = materialMap.get(prim.material);
      return copy;
    });
    meshMap.set(index, out.json.meshes.length);
    out.json.meshes.push({ ...mesh, primitives });
  });

  const nodes = json.nodes ?? [];
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, index) => index);
  return { nodes, roots, meshMap };
}

function cloneNode(out, piece, index) {
  const node = piece.nodes[index];
  const copy = {};
  for (const key of ['name', 'matrix', 'translation', 'rotation', 'scale']) {
    if (node[key] !== undefined) copy[key] = node[key];
  }
  if (node.mesh !== undefined) copy.mesh = piece.meshMap.get(node.mesh);

  const at = out.json.nodes.length;
  out.json.nodes.push(copy);
  if (node.children?.length) copy.children = node.children.map((child) => cloneNode(out, piece, child));
  return at;
}

export function assemble(placements, { mirror = true, models = ATOMS } = {}) {
  const out = createMerged();
  const pieces = new Map();
  const missing = [];
  // Node names inside loaded models: a prefab lists its child objects the same
  // way it lists whole models, so those names are placed geometry, not missing.
  const inside = new Set();
  let placed = 0;

  for (const { piece, pos, quat, scale } of placements) {
    if (!pieces.has(piece)) {
      let glb = null;
      try {
        glb = readGlb(join(models, `${piece}.glb`));
      } catch {
        missing.push(piece);
      }
      if (glb) for (const node of glb.json.nodes ?? []) if (node.name) inside.add(node.name);
      pieces.set(piece, glb && addPiece(out, glb));
    }
    const merged = pieces.get(piece);
    if (!merged) continue;

    const node = { name: piece, ...placeNode(pos, quat, scale, mirror) };
    node.children = merged.roots.map((root) => cloneNode(out, merged, root));
    out.json.nodes.push(node);
    out.json.scenes[0].nodes.push(out.json.nodes.length - 1);
    placed++;
  }

  if (out.extensionsUsed.size) out.json.extensionsUsed = [...out.extensionsUsed];
  if (out.extensionsRequired.size) out.json.extensionsRequired = [...out.extensionsRequired];

  const bin = Buffer.concat(out.chunks);
  out.json.buffers[0].byteLength = bin.length;
  return { json: out.json, bin, placed, missing: [...new Set(missing)].filter((piece) => !inside.has(piece)) };
}

function main(argv) {
  const flag = (name) => argv.includes(`--${name}`);
  const option = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : argv[at + 1];
  };
  const values = new Set(['out', 'data'].map((name) => option(name, null)).filter(Boolean));
  const names = argv.filter((arg) => !arg.startsWith('--') && !values.has(arg));

  const data = JSON.parse(readFileSync(option('data', PLACEMENTS), 'utf8'));
  const assemblies = data.assemblies ?? data;
  const outDir = resolve(ROOT, option('out', 'assemblies'));
  const mirror = !flag('no-mirror');

  const wanted = flag('all') ? Object.keys(assemblies) : names;
  if (!wanted.length) {
    console.error('usage: node tools/assemble.mjs <assembly>... [--all] [--out dir] [--no-mirror]');
    console.error(`${Object.keys(assemblies).length} assemblies in ${basename(option('data', PLACEMENTS))}`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(outDir, { recursive: true });
  const available = new Set(readdirSync(ATOMS).filter((file) => file.endsWith('.glb')).map((file) => file.slice(0, -4)));

  for (const name of wanted) {
    const placements = assemblies[name];
    if (!placements) {
      console.error(`  ✗ ${name}: no such assembly`);
      process.exitCode = 1;
      continue;
    }
    if (flag('only-complete') && placements.some(({ piece }) => !available.has(piece))) continue;

    const built = assemble(placements, { mirror });

    if (built.placed === 0) {
      console.log(`  ${name}: nothing left to build, ${placements.length} pieces all missing`);
      continue;
    }

    const path = join(outDir, `${name}.glb`);
    writeGlb(path, built.json, built.bin);

    const measured = measureScene(built);
    const size = measured.dwh.map((value) => Math.round(value * 10) / 10).join(' × ');
    console.log(`  ${name}: ${built.placed}/${placements.length} pieces, ${size} cells, ${measured.triangles} tris, ${(built.bin.length / 1024).toFixed(0)} KB`);
    if (built.missing.length) console.log(`    not in atoms/: ${built.missing.join(', ')}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
