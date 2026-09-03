/**
 * Writes a copy of a scene with named pieces left out.
 *
 *     node tools/scene/prune-scene.mjs <scene.glb> <out.glb> <selector> [selector …]
 *
 * A scene names every mesh `<Piece>__<Material>__<submesh>__<instance>`, so a
 * selector is either a piece — `Mountain_2` — or a piece and one of its
 * materials — `Water_Circle_3_Highpoly__Water Ocean`. The second form matters
 * more than it looks: the same piece is placed three times in the large island,
 * once as the ocean, once as the sand under it and once as a pool on the
 * island, and only the name tells them apart.
 *
 * What comes out is a real .glb, not the same file with things hidden: the
 * meshes go, and so do the accessors, buffer views and materials nothing points
 * at any more, with the binary chunk rebuilt around what is left.
 */

import { readGlb, writeGlb } from '../lib/glb.mjs';

const [scene, out, ...selectors] = process.argv.slice(2);
if (!scene || !out || selectors.length === 0) {
  console.error('usage: node tools/scene/prune-scene.mjs <scene.glb> <out.glb> <selector> [selector …]');
  process.exit(1);
}

const { json, bin } = readGlb(scene);

/* A selector matches on whole fields, so `Mountain_1` never catches
 * `Mountain_12` and `Water_Circle_3_Highpoly__Dirt` never catches the pool. */
const matches = (name) => {
  const [piece, material] = name.split('__');
  return selectors.some((s) => s === piece || s === `${piece}__${material}`);
};

const dropped = new Map();
const keptNodes = [];
const nodeIndex = new Map();
for (const [index, node] of (json.nodes ?? []).entries()) {
  const name = node.mesh === undefined ? null : json.meshes[node.mesh].name;
  if (name && matches(name)) {
    const [piece, material, , instance] = name.split('__');
    const key = `${piece}#${instance}`;
    if (!dropped.has(piece)) dropped.set(piece, { placements: new Set(), materials: new Set() });
    dropped.get(piece).placements.add(key);
    dropped.get(piece).materials.add(material);
    continue;
  }
  if (node.children) throw new Error(`node ${index} has children; this tool assumes a flat scene`);
  nodeIndex.set(index, keptNodes.length);
  keptNodes.push(node);
}

if (dropped.size === 0) throw new Error(`nothing in ${scene} matched: ${selectors.join(', ')}`);

/* meshes, then everything only they were holding on to */
const meshIndex = new Map();
const meshes = [];
for (const node of keptNodes) {
  if (node.mesh === undefined) continue;
  if (!meshIndex.has(node.mesh)) {
    meshIndex.set(node.mesh, meshes.length);
    meshes.push(json.meshes[node.mesh]);
  }
  node.mesh = meshIndex.get(node.mesh);
}

const materialIndex = new Map();
const materials = [];
const accessorIndex = new Map();
const accessors = [];
const keepAccessor = (index) => {
  if (index === undefined) return undefined;
  if (!accessorIndex.has(index)) {
    accessorIndex.set(index, accessors.length);
    accessors.push(json.accessors[index]);
  }
  return accessorIndex.get(index);
};

for (const mesh of meshes) {
  for (const primitive of mesh.primitives) {
    if (primitive.material !== undefined) {
      if (!materialIndex.has(primitive.material)) {
        materialIndex.set(primitive.material, materials.length);
        materials.push(json.materials[primitive.material]);
      }
      primitive.material = materialIndex.get(primitive.material);
    }
    for (const [attribute, index] of Object.entries(primitive.attributes)) {
      primitive.attributes[attribute] = keepAccessor(index);
    }
    if (primitive.indices !== undefined) primitive.indices = keepAccessor(primitive.indices);
  }
}

/* The binary chunk is rebuilt from the views that survived, in the order they
 * are first used, so the file shrinks by what was removed rather than keeping
 * the holes. */
const viewIndex = new Map();
const views = [];
const parts = [];
let offset = 0;
const keepView = (index) => {
  if (index === undefined) return undefined;
  if (!viewIndex.has(index)) {
    const view = json.bufferViews[index];
    const start = view.byteOffset ?? 0;
    const slice = bin.subarray(start, start + view.byteLength);
    viewIndex.set(index, views.length);
    views.push({ ...view, byteOffset: offset });
    parts.push(slice);
    offset += slice.length;
    const padding = (4 - (offset % 4)) % 4;
    if (padding) {
      parts.push(Buffer.alloc(padding));
      offset += padding;
    }
  }
  return viewIndex.get(index);
};

for (const accessor of accessors) accessor.bufferView = keepView(accessor.bufferView);
for (const image of json.images ?? []) {
  if (image.bufferView !== undefined) image.bufferView = keepView(image.bufferView);
}

json.nodes = keptNodes;
json.meshes = meshes;
json.materials = materials;
json.accessors = accessors;
json.bufferViews = views;
json.scenes = [{ nodes: keptNodes.map((_, i) => i) }];
json.scene = 0;
json.buffers = [{ byteLength: offset }];

writeGlb(out, json, Buffer.concat(parts));

const placements = [...dropped.values()].reduce((n, d) => n + d.placements.size, 0);
console.log(`${scene} → ${out}`);
console.log(`  dropped ${placements} placements across ${dropped.size} pieces:`);
for (const [piece, d] of [...dropped].sort((a, b) => b[1].placements.size - a[1].placements.size)) {
  console.log(`    ${String(d.placements.size).padStart(3)}  ${piece}  [${[...d.materials].join(', ')}]`);
}
console.log(`  ${keptNodes.length} nodes, ${meshes.length} meshes, ${materials.length} materials left`);
