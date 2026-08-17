/**
 * Build one GLB per assembly out of the pieces in models/.
 *
 * The pack ships prefabs — "here is a cliff, made of these 9 pieces at these
 * transforms" — and `assemblies/placements.json` is that placement list,
 * lifted out of the prefabs. This turns a list back into a model:
 *
 *     node tools/assemble.mjs Path_Bridge_River_Wide
 *     node tools/assemble.mjs --all --out assemblies
 *
 * Geometry is merged once per distinct piece and instanced from there, so an
 * assembly that uses the same wall segment nine times carries one copy of it
 * and nine nodes.
 */

import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, writeGlb, measureScene, UNITS_PER_CELL } from './glb.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODELS = join(ROOT, 'models');
const PLACEMENTS = join(ROOT, 'assemblies', 'placements.json');

/* -- coordinate systems --------------------------------------------------
 * The placements come from Unity: left-handed, Y up, one tile = 1.0. The GLBs
 * come from the same source through an FBX → glTF conversion that mirrored X
 * to reach glTF's right-handed space, and that scaled a tile to 100 units
 * (`UNITS_PER_CELL`).
 *
 * So a placement has to be mirrored the same way the geometry was. Mirroring
 * a transform means conjugating it: with F = diag(-1, 1, 1),
 *
 *     F · (T·R·S) · F = T(F·t) · (F·R·F) · S
 *
 * — the translation flips its x, the rotation flips y and z (conjugating a
 * quaternion by F negates the components perpendicular to the mirror axis),
 * and a diagonal scale, mirrored or not, comes through untouched.
 *
 * This is the mapping the pack's own note suggests, and it's the one that
 * holds up: assembled with it, neighbouring tiles meet along their shared
 * edge. Without the mirror the same pieces overlap by whole tiles — curves
 * turn the wrong way and run into their neighbours — which `--no-mirror`
 * exists to show.
 */
const placeNode = (pos, quat, scale, mirror) => ({
  translation: [(mirror ? -pos[0] : pos[0]) * UNITS_PER_CELL, pos[1] * UNITS_PER_CELL, pos[2] * UNITS_PER_CELL],
  rotation: mirror ? [quat[0], -quat[1], -quat[2], quat[3]] : quat,
  scale,
});

/* -- merging -------------------------------------------------------------
 * A merged GLB is the concatenation of its parts with every index rewritten:
 * bufferViews move down the binary chunk, accessors follow their bufferView,
 * meshes follow their accessors and material, and so on up the tree. Each
 * `add*` below appends one array and returns the old index → new index map
 * its dependents need.
 */

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

/** Appends a piece's binary chunk, 4-byte aligned, and returns where it landed. */
function addBin(out, bin) {
  const padding = align4(out.binLength);
  if (padding) out.chunks.push(Buffer.alloc(padding));
  const offset = out.binLength + padding;
  out.chunks.push(bin);
  out.binLength = offset + bin.length;
  return offset;
}

/**
 * Rewrites the texture references inside a material. A glTF textureInfo is
 * any object carrying an `index` into `textures` — `baseColorTexture`,
 * `normalTexture`, and whatever an extension adds — so the walk keys off the
 * shape rather than a list of field names, and leaves every other `index`
 * (KHR_texture_transform's `texCoord`, say) alone.
 */
function remapTextures(value, textureMap) {
  if (Array.isArray(value)) return value.map((item) => remapTextures(item, textureMap));
  if (!value || typeof value !== 'object') return value;

  const out = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remapTextures(child, textureMap)]));
  if (typeof out.index === 'number' && textureMap.has(out.index)) out.index = textureMap.get(out.index);
  return out;
}

/**
 * Merges one piece's geometry, materials and textures into `out`, and returns
 * what an instance of it needs: the piece's own node array (kept as a
 * template — nodes are cloned per instance, since a glTF node has exactly one
 * parent), its scene roots, and the mesh index map.
 */
function addPiece(out, glb) {
  const { json, bin } = glb;
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

  // Materials are shared across the whole pack — "Cliff Face" is one material
  // repeated in 138 files — so identical ones collapse into a single entry.
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

/** Copies one node and everything under it into `out`, returning the new index. */
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

/**
 * Assembles one placement list into a single `{ json, bin }` GLB.
 *
 * Missing pieces are skipped rather than fatal: this repo ships 287 of the
 * pack's models, and an assembly reaching for one of the removed props should
 * still build the other 30. They come back in `missing` for the caller to
 * report.
 */
export function assemble(placements, { mirror = true, models = MODELS } = {}) {
  const out = createMerged();
  const pieces = new Map();
  const missing = [];
  let placed = 0;

  for (const { piece, pos, quat, scale } of placements) {
    if (!pieces.has(piece)) {
      let glb = null;
      try {
        glb = readGlb(join(models, `${piece}.glb`));
      } catch {
        missing.push(piece);
      }
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
  return { json: out.json, bin, placed, missing: [...new Set(missing)] };
}

/* -- cli ---------------------------------------------------------------- */

function main(argv) {
  const flag = (name) => argv.includes(`--${name}`);
  const option = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : argv[at + 1];
  };
  // Everything that isn't a flag or a flag's value is an assembly name.
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
  const available = new Set(readdirSync(MODELS).filter((file) => file.endsWith('.glb')).map((file) => file.slice(0, -4)));

  for (const name of wanted) {
    const placements = assemblies[name];
    if (!placements) {
      console.error(`  ✗ ${name}: no such assembly`);
      process.exitCode = 1;
      continue;
    }
    if (flag('only-complete') && placements.some(({ piece }) => !available.has(piece))) continue;

    const built = assemble(placements, { mirror });
    const path = join(outDir, `${name}.glb`);
    writeGlb(path, built.json, built.bin);

    const measured = measureScene(built);
    const size = measured.dwh.map((value) => Math.round(value * 10) / 10).join(' × ');
    console.log(`  ${name}: ${built.placed}/${placements.length} pieces, ${size} cells, ${measured.triangles} tris, ${(built.bin.length / 1024).toFixed(0)} KB`);
    if (built.missing.length) console.log(`    not in models/: ${built.missing.join(', ')}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
