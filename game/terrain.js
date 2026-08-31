import { Mesh, VertexData, StandardMaterial, Color3 } from '../vendor/babylon/babylon.js';

/* Reading the GLB here rather than through Babylon's glTF loader is a
 * deliberate trade, measured on this scene:
 *
 *                        loader + MergeMeshes   this module
 *   load                       1519 ms             ~200 ms
 *   merge                       499 ms            (included)
 *   meshes / draw calls          12430                  25
 *   vertices                 1,047,092             281,574
 *   frame                        43 ms             0.35 ms
 *
 * The scene is 12,430 flat nodes, one single-primitive mesh each, sharing 304
 * position accessors between them. Babylon's loader faithfully builds 12,430
 * Mesh objects — every one of them a draw call — and merging afterwards keeps
 * every vertex, including the ones no index references. Going straight from
 * the buffer to 25 material-merged meshes skips both costs.
 *
 * The file makes that cheap: positions only, no textures, no animations, no
 * extensions, no skins, no morph targets. If any of that changes, use the
 * loader instead — this is not a general glTF reader and does not pretend to
 * be one. It throws rather than guess when it meets something it cannot read.
 */

const GLTF_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/* Socket faces. The kit colour-codes connecting cross-sections in the material
 * name, and once the pieces are placed as intended those faces are interior —
 * confirmed by rendering with and without them, which are the same picture.
 * They are 56,635 of the scene's 190,412 triangles, so skipping them is a 30%
 * saving for no visible change. */
const HIDDEN = /^Hidden(_|$)/;

// ------------------------------------------------------------------ matrices

function multiply(a, b) {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function localMatrix(node) {
  if (node.matrix) return Float64Array.from(node.matrix);

  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  return new Float64Array([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}

// ------------------------------------------------------------------ container

function splitGlb(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== GLTF_MAGIC) {
    throw new Error('not a GLB file');
  }

  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= buffer.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === CHUNK_JSON) json = new TextDecoder().decode(new Uint8Array(buffer, start, length));
    else if (type === CHUNK_BIN) bin = new Uint8Array(buffer, start, length);
    offset = start + length;
  }

  if (!json) throw new Error('GLB has no JSON chunk');
  return { gltf: JSON.parse(json), bin };
}

function unsupported(gltf) {
  const found = [];
  if (gltf.extensionsRequired?.length) found.push(`extensions ${gltf.extensionsRequired.join(', ')}`);
  if (gltf.skins?.length) found.push('skins');
  if (gltf.animations?.length) found.push('animations');
  if ((gltf.accessors ?? []).some((a) => a.sparse)) found.push('sparse accessors');
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      if (prim.targets) { found.push('morph targets'); break; }
      if ((prim.mode ?? 4) !== 4) { found.push(`primitive mode ${prim.mode}`); break; }
    }
  }
  return found;
}

// ------------------------------------------------------------------ loading

/**
 * Reads the scene into one merged mesh per material.
 *
 * Everything comes back in glTF's own right-handed coordinates, so the scene
 * must have `useRightHandedSystem = true` and the world coordinates here match
 * the file — which is what lets the grid built from this geometry line up with
 * anything measured offline by the repo's own tools.
 */
export async function loadTerrain(url, scene, { onProgress } = {}) {
  const started = performance.now();

  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  const buffer = await response.arrayBuffer();
  onProgress?.('parsing', 0.4);

  const { gltf, bin } = splitGlb(buffer);
  const problems = unsupported(gltf);
  if (problems.length) throw new Error(`this reader handles static triangle geometry only; scene uses ${problems.join(', ')}`);

  const parsed = performance.now();

  // Accessors are shared between meshes, so view each one once.
  const views = new Map();
  const accessor = (index) => {
    let view = views.get(index);
    if (view) return view;

    const spec = gltf.accessors[index];
    const bufferView = gltf.bufferViews[spec.bufferView];
    const Kind = COMPONENT[spec.componentType];
    const width = WIDTH[spec.type];
    if (!Kind || !width) throw new Error(`accessor ${index}: unsupported ${spec.componentType}/${spec.type}`);
    if (bufferView.byteStride && bufferView.byteStride !== width * Kind.BYTES_PER_ELEMENT) {
      throw new Error(`accessor ${index}: interleaved data is not supported`);
    }

    const start = (bufferView.byteOffset ?? 0) + (spec.byteOffset ?? 0);
    view = new Kind(bin.buffer, bin.byteOffset + start, spec.count * width);
    views.set(index, view);
    return view;
  };

  // Where each node ends up once its parents have had their say.
  const nodes = gltf.nodes ?? [];
  const world = new Array(nodes.length).fill(null);
  const descend = (index, parent) => {
    if (world[index] || !nodes[index]) return; // also guards cycles
    world[index] = multiply(parent, localMatrix(nodes[index]));
    for (const child of nodes[index].children ?? []) descend(child, world[index]);
  };
  for (const index of gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? []) descend(index, IDENTITY);

  onProgress?.('building', 0.6);

  /* One bucket per material. Vertices are copied per (node, primitive) and only
   * where an index actually references them, which is where the 3.7x drop in
   * vertex count against MergeMeshes comes from. */
  const buckets = new Map(); // keyed by material index, not name: two materials
  const bucketOf = (index, spec) => {   // may share a name and must not merge
    let bucket = buckets.get(index);
    if (!bucket) {
      bucket = { spec, positions: [], indices: [], count: 0 };
      buckets.set(index, bucket);
    }
    return bucket;
  };

  let sourceTriangles = 0;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node.mesh === undefined || !world[index]) continue;

    const matrix = world[index];
    for (const prim of gltf.meshes[node.mesh].primitives ?? []) {
      const spec = gltf.materials?.[prim.material];
      const name = spec?.name ?? `material_${prim.material}`;
      if (HIDDEN.test(name)) continue;

      const positions = accessor(prim.attributes.POSITION);
      const indices = prim.indices !== undefined ? accessor(prim.indices) : null;
      const total = indices ? indices.length : positions.length / 3;

      const bucket = bucketOf(prim.material ?? -1, { ...spec, name });
      const remap = new Map();
      for (let i = 0; i + 2 < total; i += 3) {
        sourceTriangles++;
        /* Wound backwards on purpose. Babylon treats these coordinates as
         * right-handed but keeps its own front-face convention, so copying the
         * file's winding culls exactly the faces meant to be seen — the kit's
         * one-sided shells then render inside-out, as a pale grey blob. */
        for (const step of [0, 2, 1]) {
          const source = indices ? indices[i + step] : i + step;
          let at = remap.get(source);
          if (at === undefined) {
            const x = positions[source * 3];
            const y = positions[source * 3 + 1];
            const z = positions[source * 3 + 2];
            at = bucket.count++;
            remap.set(source, at);
            bucket.positions.push(
              matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
              matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
              matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
            );
          }
          bucket.indices.push(at);
        }
      }
    }
  }

  onProgress?.('meshing', 0.85);

  const meshes = [];
  const bounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  let vertices = 0;
  let triangles = 0;

  for (const bucket of buckets.values()) {
    const spec = bucket.spec;
    const name = spec.name;
    const pbr = spec.pbrMetallicRoughness ?? {};
    const colour = pbr.baseColorFactor ?? [1, 1, 1, 1];
    const blended = (spec.alphaMode ?? 'OPAQUE') === 'BLEND';

    const positions = new Float32Array(bucket.positions);
    const indices = bucket.count > 65535 ? new Uint32Array(bucket.indices) : new Uint16Array(bucket.indices);
    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, indices, normals);

    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.normals = normals;

    const mesh = new Mesh(name, scene);
    data.applyToMesh(mesh, false);

    const material = new StandardMaterial(name, scene);
    material.diffuseColor = new Color3(colour[0], colour[1], colour[2]);
    // The pack has no gloss anywhere; a specular highlight only reads as haze.
    material.specularColor = Color3.Black();
    /* CLAUDE.md is explicit that every surface is single-sided and a real glTF
     * viewer culls backfaces. The scene file marks all 25 materials
     * doubleSided, which is an artefact of its trimesh export — the atoms it
     * was built from are single-sided. Culling halves the fragment work. */
    material.backFaceCulling = true;
    if (blended) {
      material.alpha = colour[3];
      mesh.isPickable = false; // water should never win a tap
    }
    mesh.material = material;
    mesh.freezeWorldMatrix();

    const box = mesh.getBoundingInfo().boundingBox;
    for (const [axis, key] of [[0, 'x'], [1, 'y'], [2, 'z']]) {
      bounds.min[axis] = Math.min(bounds.min[axis], box.minimumWorld[key]);
      bounds.max[axis] = Math.max(bounds.max[axis], box.maximumWorld[key]);
    }

    vertices += bucket.count;
    triangles += indices.length / 3;
    meshes.push(mesh);
  }

  return {
    meshes,
    bounds,
    stats: {
      bytes: buffer.byteLength,
      sourceNodes: nodes.length,
      sourceTriangles,
      meshes: meshes.length,
      vertices,
      triangles,
      parseMs: Math.round(parsed - started),
      totalMs: Math.round(performance.now() - started),
    },
  };
}
