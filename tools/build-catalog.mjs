import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readGlb, measureScene, trianglesPerUnit, BUDGET_PER_UNIT, UNITS_PER_CELL } from './glb.mjs';
import {
  FAMILIES, SHAPES, LAYERS, SIZE_GROUPS, ASSEMBLY_GROUPS, SCENE_GROUPS, TABS,
  determineFamily, determineShape, determineLayer, determineSize, determineSizeGroup,
  determineAssemblyGroup, determineSceneGroup, determineTraits, determineVariant, readableName,
} from './taxonomy.mjs';
import { TEXTURE_BY_MATERIAL } from './textures.mjs';
import { averageColor } from './png.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = join(ROOT, 'models');
const CATALOG_DIR = join(ROOT, 'catalog');
const TEXTURES_DIR = join(ROOT, 'textures');
const ASSEMBLIES_DIR = join(ROOT, 'assemblies');
const SCENES_DIR = join(ROOT, 'scenes');

const MATERIAL_NAMES = {
  'Cliff Face': 'Cliff Face',
  Grass: 'Grass',
  Dirt: 'Dirt',
  'Rock Lightest': 'Rock Lightest',
  'Rock Light': 'Rock Light',
  'Rock Medium': 'Rock Medium',
  'Stone Walkway': 'Stone Walkway',
  'Wood Light': 'Wood Light',
  'Wood Light End': 'Wood Light End',
  'Wood Medium': 'Wood Medium',
  'Wood Dark': 'Wood Dark',
  Rope: 'Rope',
  Iron: 'Iron',
  Ice: 'Ice',
  'Water River': 'Water River',
  'Water Lake': 'Water Lake',
  Waterfall: 'Waterfall',
  'Waterfall Crest': 'Waterfall Crest',
  'Sign 4x1': 'Sign 4:1',
  'Sign 4x3': 'Sign 4:3',
  'Sign 8x3': 'Sign 8:3',
  'Sign 16x9': 'Sign 16:9',
};

const HIDDEN = /^Hidden/;

const PALETTES = [
  {
    id: 'material',
    name: 'Material',
    style: 'chip',
  },
  {
    id: 'hidden',
    name: 'Hidden Faces',
    style: 'swatch',
  },
];

/* baseColorFactor is linear; this gamma-encodes it per the glTF spec. Do not
 * invert the conversion — the source Unity materials confirm the stored values
 * really are linear. */
function toHex([r, g, b] = [1, 1, 1]) {
  const channel = (v) => {
    const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, s)) * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

const averageColorCache = new Map();
function swatchColor(source, baseColorFactor) {
  const textureFile = TEXTURE_BY_MATERIAL[source];
  if (!textureFile) return toHex(baseColorFactor);
  if (!averageColorCache.has(textureFile)) {
    averageColorCache.set(textureFile, averageColor(join(TEXTURES_DIR, textureFile)));
  }
  return averageColorCache.get(textureFile);
}

const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function writeVersion() {
  const content = ['catalog.json', 'catalog.css', 'catalog.js']
    .map((name) => readFileSync(join(CATALOG_DIR, name)))
    .join('');
  const version = createHash('sha256').update(content).digest('hex').slice(0, 10);

  const path = join(ROOT, 'index.html');
  const html = readFileSync(path, 'utf8')
    .replace(/href="catalog\/catalog\.css(?:\?v=[a-f0-9]+)?"/, `href="catalog/catalog.css?v=${version}"`)
    .replace(/src="catalog\/catalog\.js(?:\?v=[a-f0-9]+)?"/, `src="catalog/catalog.js?v=${version}"`)
    .replace(/<meta name="catalog-version" content="[^"]*">/, `<meta name="catalog-version" content="${version}">`);

  writeFileSync(path, html);
  console.log(`version ${version} → index.html`);
}

const files = readdirSync(MODELS_DIR).filter((name) => name.endsWith('.glb')).sort();
if (files.length === 0) throw new Error('no .glb files in models/');

const nodeNames = new Map();

const materials = new Map();
const unknownMaterials = new Set();

function describe(dir, prefix, file, classify) {
  const id = file.replace(/\.glb$/, '');
  const glb = readGlb(join(dir, file));
  const measured = measureScene(glb);
  nodeNames.set(id, new Set((glb.json.nodes ?? []).map((node) => node.name).filter(Boolean)));

  const used = [];
  for (const index of measured.materialIndices) {
    const source = glb.json.materials?.[index]?.name ?? `material ${index}`;
    if (!(source in MATERIAL_NAMES) && !HIDDEN.test(source)) unknownMaterials.add(source);

    const palette = HIDDEN.test(source) ? 'hidden' : 'material';
    const key = `${palette}|${slugify(source)}`;
    if (!materials.has(key)) {
      materials.set(key, {
        key,
        palette,
        name: MATERIAL_NAMES[source] ?? source,
        source,
        hex: swatchColor(source, glb.json.materials?.[index]?.pbrMetallicRoughness?.baseColorFactor),
        count: 0,
      });
    }
    if (!used.includes(key)) used.push(key);
  }
  for (const key of used) materials.get(key).count++;

  const missingTextures = (glb.json.images ?? [])
    .map((image) => image.uri)
    .filter((uri) => uri && !uri.startsWith('data:'))
    .map((uri) => decodeURIComponent(uri).split(/[\\/]/).pop());

  return {
    id,
    name: readableName(id),
    file: `${prefix}/${file}`,
    ...classify(id),
    dwh: measured.dwh,
    min: measured.min,
    max: measured.max,
    triangles: measured.triangles,
    trianglesPerUnit: trianglesPerUnit(measured.triangles, measured.dwh),
    calls: measured.calls,
    bytes: glb.bytes,
    materials: used.sort(),
    missingTextures: [...new Set(missingTextures)],
  };
}

const models = files.map((file) => describe(MODELS_DIR, 'models', file, (id) => {
  const size = determineSize(id);
  return {
    family: determineFamily(id).id,
    shape: determineShape(id).id,
    layer: determineLayer(id).id,
    size: size?.label ?? null,
    sizeGroup: determineSizeGroup(size).id,
    traits: determineTraits(id),
    variant: determineVariant(id),
  };
}));

const modelIds = new Set(models.map((model) => model.id));

// Unity particle effects, never shipped as models.
const EFFECTS = new Set(['Mist', 'Ripple']);

const PLACEMENTS = join(ASSEMBLIES_DIR, 'placements.json');
const placements = existsSync(PLACEMENTS) ? JSON.parse(readFileSync(PLACEMENTS, 'utf8')).assemblies : {};

const assemblyFiles = existsSync(ASSEMBLIES_DIR)
  ? readdirSync(ASSEMBLIES_DIR).filter((name) => name.endsWith('.glb')).sort()
  : [];

const assemblies = assemblyFiles.map((file) => describe(ASSEMBLIES_DIR, 'assemblies', file, (id) => {
  const placed = placements[id] ?? [];

  const counts = new Map();
  for (const { piece } of placed) counts.set(piece, (counts.get(piece) ?? 0) + 1);
  const pieces = [...counts]
    .map(([piece, count]) => ({ id: piece, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  // A placed name may be a node inside another placed model, not a missing model.
  const within = new Set(pieces.flatMap((piece) => [...nodeNames.get(piece.id) ?? []]));
  const missing = pieces
    .filter((piece) => !modelIds.has(piece.id) && !within.has(piece.id))
    .map((piece) => piece.id);

  return {
    group: determineAssemblyGroup(id).id,
    // Null piece facets keep assemblies out of the Parts, Shapes, Layers and Sizes tabs.
    family: null,
    shape: null,
    layer: null,
    size: null,
    sizeGroup: null,
    traits: [],
    variant: null,
    placed: placed.length,
    missingPieces: missing,
    incomplete: missing.some((piece) => !EFFECTS.has(piece)),
    pieces,
  };
}));

// Scenes are full built dioramas, not reusable kit pieces; a scene's piece
// breakdown comes from a same-named JSON file next to its glb, if one exists
// (scenes/riverfall-bluff.json for scenes/Riverfall_Bluff.glb). Scenes with no
// such file (hand-authored, not built from placements.json) just show no
// piece breakdown, the same as a plain model.
const scenePlacementsCache = new Map();
function scenePlacements(id) {
  const path = join(SCENES_DIR, `${slugify(id)}.json`);
  if (!existsSync(path)) return null;
  if (!scenePlacementsCache.has(path)) {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    scenePlacementsCache.set(path, data.assemblies?.[id] ?? []);
  }
  return scenePlacementsCache.get(path);
}

const sceneFiles = existsSync(SCENES_DIR)
  ? readdirSync(SCENES_DIR).filter((name) => name.endsWith('.glb')).sort()
  : [];

const scenes = sceneFiles.map((file) => describe(SCENES_DIR, 'scenes', file, (id) => {
  const placed = scenePlacements(id);
  if (!placed) {
    return {
      group: determineSceneGroup(id).id,
      family: null, shape: null, layer: null, size: null, sizeGroup: null,
      traits: [], variant: null,
    };
  }

  const counts = new Map();
  for (const { piece } of placed) counts.set(piece, (counts.get(piece) ?? 0) + 1);
  const pieces = [...counts]
    .map(([piece, count]) => ({ id: piece, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  const within = new Set(pieces.flatMap((piece) => [...nodeNames.get(piece.id) ?? []]));
  const missing = pieces
    .filter((piece) => !modelIds.has(piece.id) && !within.has(piece.id))
    .map((piece) => piece.id);

  return {
    group: determineSceneGroup(id).id,
    family: null, shape: null, layer: null, size: null, sizeGroup: null,
    traits: [], variant: null,
    placed: placed.length,
    missingPieces: missing,
    incomplete: missing.some((piece) => !EFFECTS.has(piece)),
    pieces,
  };
}));

/* Wide margin on purpose: thin posts and overhanging pieces are normal; this
 * only catches a scale that does not match. */
const skewed = models
  .map((model) => {
    const matches = [...model.id.matchAll(/(\d+)x(\d+)/g)];
    if (matches.length === 0) return null;
    const [, w, d] = matches.at(-1);
    const cell = Math.max(Number(w), Number(d));
    const measured = Math.max(model.dwh[0], model.dwh[1]);
    const ratio = measured / cell;
    return ratio > 2.5 || ratio < 0.05 ? { model, cell, measured, ratio } : null;
  })
  .filter(Boolean)
  .sort((a, b) => b.ratio - a.ratio);

const entries = [...models, ...assemblies, ...scenes];

const FACETS = {
  family: { list: FAMILIES, field: 'family' },
  shape: { list: SHAPES, field: 'shape' },
  layer: { list: LAYERS, field: 'layer' },
  size: { list: SIZE_GROUPS, field: 'sizeGroup' },
  assembly: { list: ASSEMBLY_GROUPS, field: 'group', source: assemblies, offset: models.length },
  scene: { list: SCENE_GROUPS, field: 'group', source: scenes, offset: models.length + assemblies.length },
};

const allIds = [...FAMILIES, ...SHAPES, ...LAYERS, ...SIZE_GROUPS, ...ASSEMBLY_GROUPS, ...SCENE_GROUPS].map((g) => g.id);
const duplicateIds = allIds.filter((id, i) => allIds.indexOf(id) !== i);
if (duplicateIds.length) throw new Error(`duplicate facet id in tools/taxonomy.mjs: ${[...new Set(duplicateIds)].join(', ')}`);

const views = TABS.map((tab) => {
  const { list, field, source = models, offset = 0 } = FACETS[tab.facet];
  const sections = [];

  for (const group of list) {
    if (tab.families && !tab.families.includes(group.id)) continue;

    const indices = source
      .map((model, index) => [model, index + offset])
      .filter(([model]) => model[field] === group.id && (!tab.filter || tab.filter(model.id)))
      .map(([, index]) => index);

    if (indices.length === 0) continue;

    sections.push({
      id: `${tab.id}-${group.id}`,
      name: group.name,
      color: group.color,
      models: indices,
    });
  }

  return {
    id: tab.id,
    label: tab.label,
    facet: tab.facet,
    count: new Set(sections.flatMap((s) => s.models)).size,
    sections,
  };
}).filter((view) => view.count > 0);

const placed = new Set(views.flatMap((v) => v.sections.flatMap((s) => s.models)));
const orphaned = entries.filter((_, index) => !placed.has(index));

const catalog = {
  generated: 'node tools/build-catalog.mjs',
  total: models.length,
  assemblies: assemblies.length,
  scenes: scenes.length,
  budgetPerUnit: BUDGET_PER_UNIT,
  unitsPerCell: UNITS_PER_CELL,
  facets: Object.fromEntries(
    [...FAMILIES, ...SHAPES, ...LAYERS, ...SIZE_GROUPS, ...ASSEMBLY_GROUPS, ...SCENE_GROUPS].map((g) => [g.id, g.name]),
  ),
  views,
  palettes: PALETTES.map((palette) => ({
    ...palette,
    colors: [...materials.values()]
      .filter((m) => m.palette === palette.id)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .map(({ palette: _, ...rest }) => rest),
  })),
  models: entries,
};

writeFileSync(join(CATALOG_DIR, 'catalog.json'), JSON.stringify(catalog, null, 1) + '\n');
writeVersion();

console.log(`${models.length} models, ${assemblies.length} assemblies, and ${scenes.length} scenes → catalog/catalog.json`);
for (const view of catalog.views) {
  console.log(`\ntab ${view.label} — ${view.count} models in ${view.sections.length} sections:`);
  for (const section of view.sections) {
    console.log(`  ${String(section.models.length).padStart(3)}  ${section.name}`);
  }
}
for (const palette of catalog.palettes) {
  console.log(`\npalette ${palette.id} — ${palette.colors.length} colors:`);
  for (const color of palette.colors) {
    console.log(`  ${String(color.count).padStart(3)}  ${color.hex}  ${color.name}`);
  }
}

if (orphaned.length) {
  console.warn(`\n! ${orphaned.length} models land in no tab: ${orphaned.map((m) => m.id).join(', ')}`);
}
if (unknownMaterials.size) {
  console.warn(`\n! material without a cleaned-up name in tools/build-catalog.mjs: ${[...unknownMaterials].join(', ')}`);
}

const missingTexture = models.filter((m) => m.missingTextures.length > 0);
if (missingTexture.length) {
  const files = [...new Set(missingTexture.flatMap((m) => m.missingTextures))].sort();
  console.warn(
    `\n! ${missingTexture.length} models reference a texture that isn't in the pack;` +
    ` the viewer falls back to the flat material color.\n  looked for: ${files.join(', ')}`,
  );
}
if (skewed.length) {
  console.warn(`\n! ${skewed.length} models deviate sharply from the grid size in their name (1 cell = ${UNITS_PER_CELL} units):`);
  for (const { model, cell, measured, ratio } of skewed) {
    console.warn(`  ${ratio.toFixed(2)}×  ${model.id}  (name ${cell}, measured ${measured})`);
  }
}

const overBudget = models
  .filter((m) => m.trianglesPerUnit !== null && m.trianglesPerUnit > BUDGET_PER_UNIT)
  .sort((a, b) => b.trianglesPerUnit - a.trianglesPerUnit);
const WORST = 15;
if (overBudget.length) {
  console.warn(`\n! ${overBudget.length} models above ${BUDGET_PER_UNIT} triangles per unit, the worst ${Math.min(WORST, overBudget.length)}:`);
  for (const m of overBudget.slice(0, WORST)) {
    console.warn(`  ${String(m.trianglesPerUnit).padStart(6)}  ${m.id}  (${m.triangles} tri, ${m.dwh.join(' × ')})`);
  }
  if (overBudget.length > WORST) {
    console.warn(`  … and ${overBudget.length - WORST} more; the full list is in catalog.json`);
  }
}
const flat = models.filter((m) => m.trianglesPerUnit === null);
if (flat.length) {
  console.warn(`\n! ${flat.length} flat models without volume, so without a density: ${flat.map((m) => m.id).join(', ')}`);
}
