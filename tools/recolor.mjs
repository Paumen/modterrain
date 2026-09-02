/**
 * Puts the pack's surfaces on the shared colormap.
 *
 *     node tools/recolor.mjs [--check]
 *
 * Why: the pack's terrain materials are a texture *tinted* by a colour, and the
 * glTF export kept only the tint. `Cliff Face` therefore arrives as #e0ddd7 and
 * `Grass` as #a7de76 — a cliff the colour of paper and grass the colour of
 * nothing. The textures those materials paint with are in the pack's own zip,
 * so the colour a surface is *meant* to be can be worked out rather than
 * guessed: average the albedo, and multiply by the tint only where the shader
 * actually reads one — which, in this pack, is almost nowhere.
 *
 * Where the colour then comes from is the point of the exercise. It is not
 * written into the material as a number but taken from `textures/colormap.png`,
 * the shared map the Taalei kits use (github.com/Paumen/Taalei). A surface
 * points a UV at a spot on that map and takes the colour there, so a piece of
 * this pack and a piece of any of those kits are coloured by the same image and
 * restyling the lot is one edit to one file.
 *
 * What this does NOT touch:
 *
 *   - the `Hidden` faces. Their colours are not decoration, they are the socket
 *     profiles — same colour means two cross-sections butt together exactly —
 *     and `catalog/viewport.js` reads them by material name. Recolouring them
 *     would throw away what the pack knows about itself.
 *   - the eight tiling materials (four woods, rope, three waters). Their UVs run
 *     well outside 0–1 — `Rope` spans v −19 → 10.5 — so a patch on the shared
 *     map would be sampled across half the atlas. They keep their own texture,
 *     with the grain and ripple that earns them one.
 *   - geometry. Not a vertex moves; only the UVs of the surfaces listed in
 *     PALETTE_SOURCES change — to one point on the map, or, for a cliff face,
 *     to two ends of one cell's band so the face is shaded by height.
 *
 * The scenes are the one place a surface takes the colour as a number rather
 * than from the map: they were exported without any UVs at all. Same colour,
 * same decision, written down instead of pointed at.
 */

import { readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, writeGlb, nodeWorldMatrices, transformPoint } from './glb.mjs';
import { determineLayer } from './taxonomy.mjs';
import { decodePng } from './png.mjs';
import { readZip } from './zip.mjs';
import {
  readAtlas, writeAtlas, atlasPoints, filledCells, fillCell, nearestPoint, toHex, ROWS, COLUMNS,
} from './colormap.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ATLAS = join(ROOT, 'textures', 'colormap.png');
const PACK = join(ROOT, 'modular_terrain_2_0_textures.zip');
const PALETTE = join(ROOT, 'catalog', 'palette.json');

/* The scenes are in because they are built from these same surfaces and would
 * otherwise be the only place in the pack where grass is still the old colour.
 * Only the surfaces below are touched there; the eighty-odd materials the
 * dioramas bring of their own — flowers, mushrooms, autumn leaves, twelve snow
 * variants — are left alone, and several of them want cells this map does not
 * have yet. */
const DIRECTORIES = ['atoms', 'assemblies', 'scenes'];

/**
 * Surface → the pack material it comes from, as a path inside the zip's
 * `textures_unity/`. The path rather than the name because the pack has two
 * materials called `Grass`: the terrain one and a foliage one.
 *
 * `Cliff` is the scenes' name for what the pieces call `Cliff Face`; same
 * material in the pack, so the same colour here.
 */
const PALETTE_SOURCES = {
  'Cliff Face': 'Terrain/Cliff.mat',
  Cliff: 'Terrain/Cliff.mat',
  Dirt: 'Terrain/Dirt.mat',
  Grass: 'Terrain/Grass.mat',
  Ice: 'Terrain/Ice.mat',
  'Stone Walkway': 'Carved Stone/Carved Stone Walkway.mat',
  'Waterfall Crest': 'Water/Waterfall Crest.mat',
};

/**
 * Which texture on a pack material is the one you see. A terrain material
 * paints the sides and the top from different maps; they are the same image in
 * every material here, so the first one found is the colour.
 */
const ALBEDO_KEYS = ['_TopAlbedo', '_TriplanarAlbedo', '_Albedo', '_MainTex'];

/**
 * Unity's guid for its built-in shaders. A material on one of those may carry a
 * live `_Color`; a material on one of the pack's own may not.
 *
 * Not one of the thirteen shaders in `textures_unity/Shaders/` declares a
 * `_Color` property — `SRP Triplanar.shader`, which every terrain material
 * uses, samples `_TopAlbedo` and `_TriplanarAlbedo` and nothing else. The
 * `_Color` still sitting in those .mat files is left over from the Standard
 * shader they were built on, and it shows: one cream #F5ECD2 is shared by
 * `Dirt`, `Ice`, `Snow Dirt` and four `Snow Carved Stone` materials, which
 * cannot be the colour of all seven. Multiplying it in turned ice from #addcfe
 * to #a7ccd2 and put it on a lavender.
 *
 * The pack's own scene export agrees: it recorded `Cliff`, `Dirt`, `Grass` and
 * `Ice` as their bare albedo averages, to the byte, and `Waterfall Crest` — the
 * one material here on a built-in shader — as its tint.
 */
const UNITY_BUILT_IN_SHADER = '0000000000000000f000000000000000';

/** Surfaces that keep their own texture. See the note at the top. */
const KEEPS_TEXTURE = new Set([
  'Wood Dark', 'Wood Light', 'Wood Light End', 'Wood Medium',
  'Rope', 'Water River', 'Water Lake', 'Waterfall',
]);

/**
 * The two colours the shared map did not have, both of them blue.
 *
 * `Waterfall Crest` is the lip at the top of a fall and the pack paints it a
 * pure cyan, #00edf9; the nearest thing on the map was the water blue #29abe2,
 * 150 away — not a shade off, a different colour. Flat rather than a band,
 * because the pack shows one colour and no gradient. Row 2 is where the blues
 * live, so both of these go there.
 *
 * Everything else in the pack reuses a colour that is already on the map, which
 * is what a shared map is for.
 */
const ADDED_CELLS = [
  { cell: [6, 2], name: 'crest cyan', top: [0, 237, 249], bottom: [0, 237, 249] },
  /* Ice, #addcfe. The map has a bright blue, a water blue, a lavender and a
   * white, and the nearest of those is the lavender — a hue away, on a surface
   * that is nothing but that colour across a whole iceberg. The band runs
   * between the light and dark ends of `ice.png` itself, which is a narrow run
   * because the texture is nearly one colour. It sits at [7, 2] beside the
   * other blues and the crest. */
  { cell: [7, 2], name: 'ice blue', top: [186, 229, 255], bottom: [162, 209, 253] },
];

/**
 * The band as shading, which is what the kits use it for.
 *
 * A cell is not one colour but a run from light at the top to dark at the
 * bottom, and Kenney's own models sample it by height: light where a surface
 * faces the sky, dark where it meets the ground, the rasteriser filling in
 * between. It is not a free ramp either. Across 89,226 vertices of the kits
 * Taalei ships unaltered — pirate, platformer, fantasy-town, mini-forest,
 * mini-dungeon — the rows cluster on five steps, and on stacking pieces the
 * darker of two UVs sits on the lower vertex every single time.
 * `fantasy-town-kit/wall-wood-block` is the whole idea in one model: row 38 on
 * its top vertices, row 90 on its bottom ones, nothing in between.
 */
const LADDER = [13, 38, 64, 90, 115];

/**
 * Cliff faces, and only cliff faces.
 *
 * They are the surfaces that stack into something tall enough for shading to
 * read as form. Grass caps a piece and is horizontal, dirt is a band a few
 * centimetres deep, and ice is a slab — a ramp across any of those is a
 * gradient with nothing to describe.
 *
 * `Cliff` is the scenes' cliff face. It cannot be shaded — the scenes have no
 * UVs — but naming it here gets it the colour a shaded cliff averages to,
 * rather than the light end of the band, so a diorama sits at the same tone as
 * the pieces.
 */
const SHADED = new Set(['Cliff Face', 'Cliff']);

/**
 * Which rows of the ladder each layer gets.
 *
 * Kenney ramps every module over the same rows, so a stack of them repeats the
 * gradient at every seam — fine for a wall two blocks high, less so for a cliff
 * that runs Under, Base, Mid, Top. This pack names the layer in every file, so
 * the four of them can share the ladder instead: a piece ramps inside its own
 * quarter, and a full stack reads as one gradient from the crest to the foot.
 *
 * `Mid` is the exception, and it is flat. It is the one piece meant to repeat —
 * a cliff is however many Mids tall — and a ramp that repeats sawtooths: each
 * Mid would run light to dark, so every seam in the run would jump back to
 * light. One tone at the middle of its quarter instead, so any number of them
 * read as one wall and the gradient comes from the Top above and the Base and
 * Under below. That tone sits between two rungs of the ladder rather than on
 * one, which is right: Mid is a repeat, not a step.
 *
 * A piece with no layer spans the lot. There are five of those with a cliff
 * face — the two paths, the bridge and the two cracks — and each of them runs
 * down the whole height of a cliff rather than sitting at one level of it.
 */
const MID_TONE = (LADDER[1] + LADDER[2]) / 2;

const LAYER_ROWS = {
  'layer-top': [LADDER[0], LADDER[1]],
  'layer-mid': [MID_TONE, MID_TONE],
  'layer-base': [LADDER[2], LADDER[3]],
  'layer-under': [LADDER[3], LADDER[4]],
  'layer-none': [LADDER[0], LADDER[4]],
};

/**
 * How far a surface may sit from the nearest colour on the map before it earns
 * a cell of its own, on the redmean scale `colormap.mjs` measures with.
 *
 * 60 is the figure the Taalei import of this pack settled on, and the gap here
 * is just as clean: `Ice` sits at 44 and the crest at 150, with nothing in
 * between. Under it a surface reuses a colour that is already shared; over it,
 * forcing the match would be recolouring the pack rather than mapping it.
 */
const NEW_CELL_ABOVE = 60;

/**
 * Surfaces that reuse a colour further away than that, and why.
 *
 * `Grass` is the one. The v2 texture in this pack averages #509346, a muted
 * green, and the map's grass green #228b22 is 92 away — over the line. But that
 * cell is on the map *because of this pack*: Taalei's import of its previous
 * version read a flat `Grass` material of exactly #228b22 and added the cell
 * for it, over the same objection, since every other green on the map yellowed
 * the grass. Adding a second green a shade off the first would be two greens
 * for one thing, on a map whose whole point is that a colour means one thing
 * everywhere.
 */
const REUSED_BEYOND_THRESHOLD = {
  Grass: "the map's grass green was added for this pack's own earlier version",
};

const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/* Averaging happens in linear light: the average of a texture is how much light
 * it sends back, and that is not the average of its sRGB bytes. Transparent
 * pixels carry no colour, so they carry no weight either. */
function averageAlbedo(png) {
  const sum = [0, 0, 0];
  let weight = 0;
  for (let i = 0; i < png.pixels.length; i += 4) {
    const alpha = png.pixels[i + 3] / 255;
    for (let k = 0; k < 3; k++) sum[k] += toLinear(png.pixels[i + k] / 255) * alpha;
    weight += alpha;
  }
  return sum.map((v) => v / (weight || 1));
}

function packColors() {
  const zip = readZip(PACK);

  /* The .mat files name a texture without saying which folder it is in, and the
   * zip carries two: the Unity project's and the one shipped beside the FBXs.
   * They hold the same images; the Unity folder is the fuller of the two. */
  const byName = new Map();
  for (const name of zip.keys()) {
    const base = name.split('/').pop().toLowerCase();
    if (!byName.has(base) || name.startsWith('textures_unity/')) byName.set(base, name);
  }

  const materials = new Map();
  for (const entry of JSON.parse(zip.get('textures_unity/materials.json')().toString('utf8'))) {
    materials.set(entry.file, entry);
  }

  const colors = new Map();
  for (const [surface, file] of Object.entries(PALETTE_SOURCES)) {
    const material = materials.get(file);
    if (!material) throw new Error(`${surface}: ${file} is not in ${relative(ROOT, PACK)}`);

    // The tint counts only where the shader reads it — see UNITY_BUILT_IN_SHADER.
    const shader = zip.get(`textures_unity/${file}`)().toString('utf8')
      .match(/m_Shader:.*guid: ([0-9a-f]+)/)?.[1];
    const live = shader === UNITY_BUILT_IN_SHADER;
    const tint = live ? material.colors?._Color?.linear ?? [1, 1, 1, 1] : [1, 1, 1, 1];

    const albedo = ALBEDO_KEYS.map((key) => material.textures?.[key])
      .find((name) => name && name !== '?');

    let linear = [1, 1, 1];
    if (albedo) {
      const path = byName.get(albedo.toLowerCase());
      if (!path) throw new Error(`${surface}: ${albedo} is not in ${relative(ROOT, PACK)}`);
      linear = averageAlbedo(decodePng(zip.get(path)(), path));
    }

    colors.set(surface, {
      rgb: linear.map((v, k) => Math.round(toSrgb(v * tint[k]) * 255)),
      albedo: albedo ?? null,
      material: file,
      tint: live ? material.colors?._Color?.hex_srgb ?? null : null,
    });
  }
  return colors;
}

/* -- the map ------------------------------------------------------------- */

const atlas = readAtlas(ATLAS);
const before = new Set(filledCells(atlas).map((cell) => cell.join(',')));

for (const { cell, name, top, bottom } of ADDED_CELLS) {
  fillCell(atlas, cell, top, bottom);
  const band = top.every((v, i) => v === bottom[i]) ? toHex(top) : `${toHex(top)} → ${toHex(bottom)}`;
  console.log(`${before.has(cell.join(',')) ? 'repainted' : 'added'} cell [${cell}] ${band}  ${name}`);
}

const points = atlasPoints(atlas);
const CELL_ROWS = atlas.height / ROWS;

/* A UV that lands on `row` of a cell's band. Half a pixel in, so it sits on the
 * row rather than on the seam between two. */
const rowUv = (cellRow, row) => (cellRow * CELL_ROWS + row + 0.5) / atlas.height;

const colorAtRow = ([column, row], step) => {
  const x = Math.floor((column + 0.5) * (atlas.width / COLUMNS));
  const y = Math.floor(row * CELL_ROWS) + step;
  const i = (y * atlas.width + x) * 4;
  return [atlas.pixels[i], atlas.pixels[i + 1], atlas.pixels[i + 2]];
};
const colors = packColors();

/* -- where each surface lands --------------------------------------------- */

const placement = new Map();
for (const [surface, source] of colors) {
  const point = nearestPoint(points, source.rgb);
  if (!point) {
    throw new Error(
      `${surface}: the map holds nothing of ${toHex(source.rgb)}'s hue at all — give it a cell in ADDED_CELLS`,
    );
  }
  // What the surface is where it cannot be shaded: a cliff runs down its band,
  // so the one colour that stands for it is the middle of the ladder.
  const flat = SHADED.has(surface) ? colorAtRow(point.cell, LADDER[2]) : point.rgb;
  placement.set(surface, { source, point, flat });
}

console.log(`\n${placement.size} surfaces on textures/colormap.png:`);
for (const [surface, { source, point }] of [...placement].sort((a, b) => b[1].point.distance - a[1].point.distance)) {
  console.log(
    `  ${surface.padEnd(16)} ${toHex(source.rgb)} → ${toHex(point.rgb)}  cell [${String(point.cell).padEnd(5)}]` +
    `  distance ${point.distance.toFixed(0).padStart(3)}${point.distance > NEW_CELL_ABOVE ? ' !' : ''}` +
    `  from ${source.albedo ?? 'the tint alone'}`,
  );
}

const tooFar = [...placement].filter(([surface, { point }]) =>
  point.distance > NEW_CELL_ABOVE && !REUSED_BEYOND_THRESHOLD[surface]);
if (tooFar.length) {
  throw new Error(
    `${tooFar.length} surfaces are further than ${NEW_CELL_ABOVE} from any colour on the map ` +
    `(${tooFar.map(([surface]) => surface).join(', ')}) — give them a cell in ADDED_CELLS`,
  );
}

if (process.argv.includes('--check')) {
  console.log('\n--check: nothing written');
  process.exit(0);
}

writeAtlas(ATLAS, atlas);

writeFileSync(PALETTE, `${JSON.stringify({
  generated: 'node tools/recolor.mjs',
  atlas: 'textures/colormap.png',
  surfaces: Object.fromEntries([...placement].map(([surface, { source, point, flat }]) => [surface, {
    // A shaded surface has no single colour: it runs down its cell's band. The
    // swatch is the middle of the ladder, which is what a cliff averages out to.
    hex: toHex(flat),
    cell: point.cell,
    uv: point.uv,
    ...(SHADED.has(surface) ? { shadedByHeight: LAYER_ROWS } : {}),
    packColor: toHex(source.rgb),
    packMaterial: source.material,
    packAlbedo: source.albedo,
    distance: Math.round(point.distance),
  }])),
  keepsTexture: [...KEEPS_TEXTURE].sort(),
}, null, 1)}\n`);
console.log(`\n${placement.size} surfaces → ${relative(ROOT, PALETTE)}`);

/* -- the models ----------------------------------------------------------- */

/* One shared image, referenced rather than embedded: at 5.5 kB it would more
 * than half again the size of the median piece, and the colormap is meant to be
 * one file you can repaint. The path is relative to the .glb, which is how the
 * kits ship theirs too. */
const IMAGE_URI = '../textures/colormap.png';

/* No mipmaps. A surface points at one spot in the middle of a 32-pixel cell;
 * with mipmaps, a piece seen from far enough away samples a level where that
 * cell has been averaged together with its neighbours and the colour drifts.
 * Clamped for the same reason — nothing here needs to wrap. */
const SAMPLER = { magFilter: 9729, minFilter: 9729, wrapS: 33071, wrapT: 33071 };

function colormapTexture(json) {
  json.images ??= [];
  json.textures ??= [];
  json.samplers ??= [];

  const existing = json.textures.findIndex((texture) => texture.name === 'colormap');
  if (existing >= 0) return existing;

  json.images.push({ uri: IMAGE_URI, name: 'colormap' });
  json.samplers.push({ ...SAMPLER });
  json.textures.push({ source: json.images.length - 1, sampler: json.samplers.length - 1, name: 'colormap' });
  return json.textures.length - 1;
}

/**
 * Where each mesh sits in its piece.
 *
 * Every file in the pack puts its meshes under a node with a transform, so the
 * height in a mesh is not the height in the piece. UVs belong to the mesh, so a
 * mesh placed at two heights could only carry one ramp — two assemblies do that
 * for the sheets of a two-storey waterfall, but a waterfall keeps its own
 * texture and is never shaded. If a shaded mesh is ever placed twice, this says
 * so rather than shading it at the wrong height.
 */
function meshHeights(json, shaded) {
  const world = nodeWorldMatrices(json);
  const byMesh = new Map();
  (json.nodes ?? []).forEach((node, index) => {
    if (node.mesh === undefined || !world[index]) return;
    if (!json.meshes[node.mesh].primitives.some((p) => shaded.includes(p.material))) return;
    const seen = byMesh.get(node.mesh);
    if (seen && seen[13] !== world[index][13]) {
      throw new Error(`mesh ${node.mesh} carries a shaded surface and is placed at two heights`);
    }
    byMesh.set(node.mesh, world[index]);
  });
  return byMesh;
}

function worldY(json, bin, primitive, matrix) {
  const accessor = json.accessors[primitive.attributes.POSITION];
  const view = json.bufferViews[accessor.bufferView];
  const stride = view.byteStride ?? 12;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from({ length: accessor.count }, (_, i) => transformPoint(
    matrix,
    bin.readFloatLE(base + i * stride),
    bin.readFloatLE(base + i * stride + 4),
    bin.readFloatLE(base + i * stride + 8),
  )[1]);
}

/* Light at the piece's top, dark at its foot, over the rows its layer owns.
 * The vertices carry the two ends and the rasteriser draws the gradient
 * between them, which is how the kits do it — no extra geometry, no texture
 * beyond the one cell. */
function rampUvsBy(json, bin, primitive, heights, [lo, hi], [u, cellRow], [light, dark]) {
  const accessor = json.accessors[primitive.attributes.TEXCOORD_0];
  if (accessor.type !== 'VEC2' || accessor.componentType !== 5126) {
    throw new Error('UV accessor is not float VEC2');
  }
  const view = json.bufferViews[accessor.bufferView];
  const stride = view.byteStride ?? 8;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);

  let min = Infinity, max = -Infinity;
  for (let i = 0; i < accessor.count; i++) {
    const t = hi === lo ? 1 : (heights[i] - lo) / (hi - lo);
    const v = rowUv(cellRow, dark + (light - dark) * t);
    bin.writeFloatLE(u, base + i * stride);
    bin.writeFloatLE(v, base + i * stride + 4);
    min = Math.min(min, v); max = Math.max(max, v);
  }
  accessor.min = [u, min];
  accessor.max = [u, max];
}

/* Every vertex of the surface goes to the same spot, so the whole surface is
 * one flat colour and every triangle stays inside one cell. */
function pointUvsAt(json, bin, accessorIndex, [u, v]) {
  const accessor = json.accessors[accessorIndex];
  if (accessor.type !== 'VEC2' || accessor.componentType !== 5126) {
    throw new Error(`accessor ${accessorIndex} is not float VEC2`);
  }
  const view = json.bufferViews[accessor.bufferView];
  const stride = view.byteStride ?? 8;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  for (let i = 0; i < accessor.count; i++) {
    bin.writeFloatLE(u, base + i * stride);
    bin.writeFloatLE(v, base + i * stride + 4);
  }
  accessor.min = [u, v];
  accessor.max = [u, v];
}

/* Every `…Texture` on a material, wherever it sits: glTF puts them straight on
 * the material, on `pbrMetallicRoughness`, and inside extensions, and they all
 * take the same shape — an object with an `index` into `textures`. */
function textureRefs(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  for (const [key, value] of Object.entries(node)) {
    if (key.endsWith('Texture') && value && typeof value.index === 'number') found.push(value);
    else textureRefs(value, found);
  }
  return found;
}

/**
 * Drops what the rewrite orphaned.
 *
 * The waterfall crests pointed at `Textures\uvmap image 32x16.png` — a UV
 * checker that was never shipped with the pack, which is why the catalog has
 * always reported it missing. Now that the crest takes its colour from the map,
 * nothing points at that image at all, and leaving the entry behind would keep
 * a reference to a file that does not exist.
 *
 * Only images that live outside the .glb are dropped. An embedded one owns a
 * slice of the binary chunk, and cutting that out means rebuilding every offset
 * in the file for a few bytes.
 */
function pruneUnused(json) {
  const refs = (json.materials ?? []).flatMap((material) => textureRefs(material));
  const liveTextures = new Set(refs.map((ref) => ref.index));

  const textures = [];
  const textureIndex = new Map();
  for (const [index, texture] of (json.textures ?? []).entries()) {
    if (!liveTextures.has(index)) continue;
    textureIndex.set(index, textures.length);
    textures.push(texture);
  }

  const liveImages = new Set(textures.map((texture) => texture.source));
  const images = [];
  const imageIndex = new Map();
  for (const [index, image] of (json.images ?? []).entries()) {
    if (!liveImages.has(index) && image.bufferView === undefined) continue;
    imageIndex.set(index, images.length);
    images.push(image);
  }

  const liveSamplers = new Set(textures.map((texture) => texture.sampler));
  const samplers = [];
  const samplerIndex = new Map();
  for (const [index, sampler] of (json.samplers ?? []).entries()) {
    if (!liveSamplers.has(index)) continue;
    samplerIndex.set(index, samplers.length);
    samplers.push(sampler);
  }

  for (const ref of refs) ref.index = textureIndex.get(ref.index);
  for (const texture of textures) {
    texture.source = imageIndex.get(texture.source);
    if (texture.sampler !== undefined) texture.sampler = samplerIndex.get(texture.sampler);
  }

  for (const [key, value] of Object.entries({ textures, images, samplers })) {
    if (value.length) json[key] = value;
    else delete json[key];
  }
}

let changed = 0;
const counts = new Map();
const ramped = new Set();

for (const directory of DIRECTORIES) {
  for (const file of readdirSync(join(ROOT, directory)).filter((name) => name.endsWith('.glb')).sort()) {
    const path = join(ROOT, directory, file);
    const id = file.replace(/\.glb$/, '');
    const { json, bin } = readGlb(path);

    const mapped = new Set();
    for (const [index, material] of (json.materials ?? []).entries()) {
      if (!placement.has(material.name)) continue;
      mapped.add(index);
      counts.set(material.name, (counts.get(material.name) ?? 0) + 1);
    }
    if (mapped.size === 0) continue;

    /* The scenes were exported without a single UV — they are flat colour
     * throughout, so there was nothing to unwrap. A surface there cannot point
     * at the map, and giving 5828 primitives a UV attribute each would grow
     * three 14 MB files for a colour that is one number. It takes the colour
     * the map holds instead, which is the same colour by the same decision. */
    const shaded = [...mapped].filter((index) => SHADED.has(json.materials[index].name));
    const rows = LAYER_ROWS[determineLayer(id).id];
    if (shaded.length && !rows) throw new Error(`${file}: no rows for layer ${determineLayer(id).id}`);

    /* The whole piece shares one ramp, not one per primitive: a cliff face
     * split over two draws is still one face, and shading the halves apart
     * would put a step across the middle of it. */
    const matrices = shaded.length ? meshHeights(json, shaded) : null;
    const heights = new Map();
    let lo = Infinity, hi = -Infinity;
    for (const [index, mesh] of (json.meshes ?? []).entries()) {
      for (const primitive of mesh.primitives) {
        if (!shaded.includes(primitive.material) || primitive.attributes.TEXCOORD_0 === undefined) continue;
        const y = worldY(json, bin, primitive, matrices.get(index));
        heights.set(primitive, y);
        lo = Math.min(lo, ...y); hi = Math.max(hi, ...y);
      }
    }

    const uvs = new Map();
    for (const mesh of json.meshes ?? []) {
      for (const primitive of mesh.primitives) {
        if (!mapped.has(primitive.material)) continue;
        const has = primitive.attributes.TEXCOORD_0 !== undefined;
        const seen = uvs.get(primitive.material);
        if (seen !== undefined && seen !== has) {
          throw new Error(`${file}: ${json.materials[primitive.material].name} has UVs on some primitives and not others`);
        }
        uvs.set(primitive.material, has);
        if (!has) continue;

        const { point } = placement.get(json.materials[primitive.material].name);
        if (heights.has(primitive)) {
          rampUvsBy(json, bin, primitive, heights.get(primitive), [lo, hi], [point.uv[0], point.cell[1]], rows);
          ramped.add(json.materials[primitive.material].name);
        } else {
          pointUvsAt(json, bin, primitive.attributes.TEXCOORD_0, point.uv);
        }
      }
    }

    const texture = [...uvs.values()].some(Boolean) ? colormapTexture(json) : null;

    for (const index of mapped) {
      const material = json.materials[index];
      const { baseColorFactor, roughnessFactor } = material.pbrMetallicRoughness ?? {};
      const alpha = baseColorFactor?.[3] ?? 1;
      const rgb = placement.get(material.name).flat.map((v) => toLinear(v / 255));

      material.pbrMetallicRoughness = {
        // Transparent water stays transparent: the alpha is the material's own,
        // and `alphaMode` beside it is left where it is.
        ...(uvs.get(index)
          ? { baseColorTexture: { index: texture }, ...(alpha < 1 ? { baseColorFactor: [1, 1, 1, alpha] } : {}) }
          : { baseColorFactor: [...rgb, alpha] }),
        metallicFactor: 0,
        ...(roughnessFactor === undefined ? {} : { roughnessFactor }),
      };
      // The pack's specular colour was the old tint again; on a surface that
      // now takes its colour from the map it would tint the highlight to a
      // colour nothing else uses. The glTF default — white — is what the kits
      // leave it at.
      delete material.extensions?.KHR_materials_specular;
      if (material.extensions && Object.keys(material.extensions).length === 0) delete material.extensions;
    }

    pruneUnused(json);

    const stillUsed = new Set((json.materials ?? []).flatMap((m) => Object.keys(m.extensions ?? {})));
    if (json.extensionsUsed) {
      json.extensionsUsed = json.extensionsUsed.filter((name) => stillUsed.has(name));
      if (json.extensionsUsed.length === 0) delete json.extensionsUsed;
    }

    writeGlb(path, json, bin);
    changed++;
  }
}

console.log(`\n${changed} models rewritten in ${DIRECTORIES.join(', ')}:`);
for (const [surface, count] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  ${surface}${ramped.has(surface) ? '  (shaded by height)' : ''}`);
}
console.log('\nrun tools/build-catalog.mjs and tools/build-pieces.mjs next');
