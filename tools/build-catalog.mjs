/**
 * Builds catalog/catalog.json from the .glb files in models/.
 *
 * Run from the repo root:  node tools/build-catalog.mjs
 *
 * The catalog is derived entirely from what's actually on disk, so it can
 * never drift from the models. For each model it reads file size, bounding
 * box, triangle count, and materials from the .glb itself; the
 * classification comes from tools/taxonomy.mjs.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readGlb, measureScene, trianglesPerUnit, BUDGET_PER_UNIT, UNITS_PER_CELL } from './glb.mjs';
import {
  FAMILIES, SHAPES, LAYERS, SIZE_GROUPS, TABS,
  determineFamily, determineShape, determineLayer, determineSize, determineSizeGroup,
  determineTraits, determineVariant, readableName,
} from './taxonomy.mjs';
import { TEXTURE_BY_MATERIAL } from './textures.mjs';
import { averageColor } from './png.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = join(ROOT, 'models');
const CATALOG_DIR = join(ROOT, 'catalog');
const TEXTURES_DIR = join(ROOT, 'textures');

/* -- materials ------------------------------------------------------------
 * The pack has no texture atlas: every material is one flat color in
 * `baseColorFactor`. That's plenty to filter by — color is the whole point,
 * grass is green, cliff wall is beige, hidden faces are near-white.
 */

/**
 * Cleaned-up display name per material in the pack, listed explicitly so a
 * material this build has never seen before shows up as a warning instead of
 * passing through silently. Most of the source names are already clean
 * English and map to themselves; the signs get their size turned into an
 * aspect ratio.
 */
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

/**
 * Two groups in the filter bar, because they're two different kinds of
 * color. The visible materials say what a piece is made of; the `Hidden`
 * series marks faces the pack itself flags as hidden — the sides that sit
 * against a neighboring tile. What distinguishes the color variants within
 * that group isn't explained by the pack; they're kept separate here so they
 * don't dilute the material group.
 */
const HIDDEN = /^Hidden/;

const PALETTES = [
  {
    id: 'material',
    name: 'Material',
    // Labeled, because this group has materials that share a color: river,
    // lake, waterfall, and waterfall crest are all the same cyan, and four
    // identical swatches side by side is a puzzle, not a filter.
    style: 'chip',
  },
  {
    id: 'hidden',
    name: 'Hidden Faces',
    // Here the color is the whole meaning — "Hidden Red" is named for being
    // red — so the swatch itself is the label. Saves a row in the bar.
    style: 'swatch',
  },
];

/**
 * The material color as it actually renders: `baseColorFactor` converted from
 * linear to sRGB, exactly as the glTF spec says and exactly as a
 * spec-conforming viewer draws it.
 *
 * This was briefly "corrected" the other way — on the theory that the FBX
 * export had written sRGB bytes into that linear field — but the source
 * Unity project's own material files (`materials.json`, PROVENANCE.md)
 * disprove that: `Grass` = 0.3882 / 0.7294 / 0.1804 is the exact linear value
 * Unity stores for `Terrain/Grass.mat`, and Unity's own gamma-decode of that
 * number is #A6DD75 — a pale green, matching what plain, unmodified gamma
 * decoding produces here too. The saturated #63ba2e some earlier build
 * showed was the bug, not the fix.
 */
function toHex([r, g, b] = [1, 1, 1]) {
  const channel = (v) => {
    const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, s)) * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * The swatch color for a material `tools/embed-textures.mjs` has given a
 * real texture: `baseColorFactor` is white on those (see textures.mjs), so
 * `toHex` would just draw a blank square. The texture's own average color —
 * computed fresh from the file on disk, not cached from the embed step —
 * says something a flat white swatch can't: which material is the dark wood
 * and which is the light one.
 */
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

/* -- version ---------------------------------------------------------------
 * GitHub Pages serves with `cache-control: max-age=600`. Without a version in
 * the URL you'd look at stale CSS or JS for up to ten minutes after a
 * deploy, or worse: new HTML with old JS. The hash is derived from content,
 * so it changes exactly when something changes.
 */
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

/* -- reading the models ----------------------------------------------------- */

const files = readdirSync(MODELS_DIR).filter((name) => name.endsWith('.glb')).sort();
if (files.length === 0) throw new Error('no .glb files in models/');

/** material key → { key, palette, name, source, hex, count } */
const materials = new Map();
const unknownMaterials = new Set();

const models = files.map((file) => {
  const id = file.replace(/\.glb$/, '');
  const glb = readGlb(join(MODELS_DIR, file));
  const measured = measureScene(glb);

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

  const size = determineSize(id);

  /* tools/embed-textures.mjs already fixed the materials that pointed at a
   * real, recoverable texture. What's left here is genuinely missing: a
   * normal map (Rope NM.png) this catalog has no use for even if it existed,
   * and Waterfall Crest's reference to a UV-checker placeholder rather than
   * a real texture. The viewer falls back to the flat material color, so the
   * model still shows either way — this is surfaced rather than hidden
   * because it's a property of the pack, not a bug in the catalog. */
  const missingTextures = (glb.json.images ?? [])
    .map((image) => image.uri)
    .filter((uri) => uri && !uri.startsWith('data:'))
    .map((uri) => decodeURIComponent(uri).split(/[\\/]/).pop());

  return {
    id,
    name: readableName(id),
    file: `models/${file}`,
    family: determineFamily(id).id,
    shape: determineShape(id).id,
    layer: determineLayer(id).id,
    size: size?.label ?? null,
    sizeGroup: determineSizeGroup(size).id,
    traits: determineTraits(id),
    variant: determineVariant(id),
    dwh: measured.dwh,
    // This pack is deliberately not centered on the origin: each piece's
    // origin IS its grid cell. Where it sits around that — whether it
    // overhangs, whether it dips below zero — is what these two corners are
    // for.
    min: measured.min,
    max: measured.max,
    triangles: measured.triangles,
    trianglesPerUnit: trianglesPerUnit(measured.triangles, measured.dwh),
    calls: measured.calls,
    bytes: glb.bytes,
    materials: used.sort(),
    missingTextures: [...new Set(missingTextures)],
  };
});

/* -- checking the grid size --------------------------------------------
 * The whole catalog measures in grid cells of UNITS_PER_CELL, and that
 * number was derived from the files, not stated by the pack. This check
 * keeps that derivation honest: the longest side measured should be close
 * to the longest side named.
 *
 * The margin is deliberately wide, because plenty is normal within it: a
 * fence post named 1 × 1 is only an eighth of a cell thick, and a
 * waterfall's side pieces hang a cell outside their footprint. What falls
 * outside this margin isn't a skewed tile, it's a scale that doesn't match —
 * a pack in centimeters instead of decimeters would fail immediately.
 */
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

/* -- building the views -----------------------------------------------
 * Each tab is a list of sections, and each section a list of indices into
 * `models`. Indices, not full records, because one model shows up in four
 * tabs at once: written out in full, the catalog would be four times the
 * size.
 */

const FACETS = {
  family: { list: FAMILIES, field: 'family' },
  shape: { list: SHAPES, field: 'shape' },
  layer: { list: LAYERS, field: 'layer' },
  size: { list: SIZE_GROUPS, field: 'sizeGroup' },
};

/* All facet ids together must be unique: catalog.json puts them in one table
 * and the browser looks up a name without knowing which facet an id came
 * from. A collision would silently produce the wrong name — a model in the
 * "Base" layer calling itself something a family already claims. */
const allIds = [...FAMILIES, ...SHAPES, ...LAYERS, ...SIZE_GROUPS].map((g) => g.id);
const duplicateIds = allIds.filter((id, i) => allIds.indexOf(id) !== i);
if (duplicateIds.length) throw new Error(`duplicate facet id in tools/taxonomy.mjs: ${[...new Set(duplicateIds)].join(', ')}`);

const views = TABS.map((tab) => {
  const { list, field } = FACETS[tab.facet];
  const sections = [];

  for (const group of list) {
    if (tab.families && !tab.families.includes(group.id)) continue;

    const indices = models
      .map((model, index) => [model, index])
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
    // What this tab groups by. The browser uses it to know whether the
    // family label on a card would just repeat the section header.
    facet: tab.facet,
    count: new Set(sections.flatMap((s) => s.models)).size,
    sections,
  };
});

/* A model that lands in no tab doesn't exist for the visitor. */
const placed = new Set(views.flatMap((v) => v.sections.flatMap((s) => s.models)));
const orphaned = models.filter((_, index) => !placed.has(index));

const catalog = {
  generated: 'node tools/build-catalog.mjs',
  total: models.length,
  // So the browser doesn't need to know the limit a second time.
  budgetPerUnit: BUDGET_PER_UNIT,
  // Every dimension in this catalog is in grid cells; this is what one cell
  // measures in the source files. Whoever loads the .glb files straight
  // into an engine needs that number.
  unitsPerCell: UNITS_PER_CELL,
  // Every model carries its facets as an id; this is what those ids mean.
  // One table for all facets together — the ids are unique across facets, so
  // the browser doesn't need to know which facet it's looking in.
  facets: Object.fromEntries(
    [...FAMILIES, ...SHAPES, ...LAYERS, ...SIZE_GROUPS].map((g) => [g.id, g.name]),
  ),
  views,
  palettes: PALETTES.map((palette) => ({
    ...palette,
    colors: [...materials.values()]
      .filter((m) => m.palette === palette.id)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .map(({ palette: _, ...rest }) => rest),
  })),
  models,
};

writeFileSync(join(CATALOG_DIR, 'catalog.json'), JSON.stringify(catalog, null, 1) + '\n');
writeVersion();

/* -- report --------------------------------------------------------------- */

console.log(`${models.length} models → catalog/catalog.json`);
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

/* Above budget is not a hard error: the pack is what it is, and a model
 * above the line is a candidate to simplify, not a build stopper. The build
 * names them so the list doesn't grow silently. */
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
