/**
 * The pack's classification, derived from filenames.
 *
 * The pack ships without folders and without metadata — just 394 .glb files
 * named things like `Tiered_Retaining_Wall_45_Degrees_Curve_Outer_3x4_Top`.
 * That name is consistently built, though, and it's the only thing to go on:
 *
 *     Family _ [kind] _ [variant] _ Shape _ [size] _ Grid _ [Layer]
 *
 * Below is one table of rules per facet. Everything the catalog shows —
 * tabs, sections, filters, card labels — comes from these, so a
 * mis-classified model is a one-line fix.
 *
 * Rules are ordered: the first match wins. That matters because the facets
 * overlap. `Terrain_Sand_Incline_Curve_Inner_4x4` is both a slope and an
 * inner curve; it lands with the inner curves, because the curve is what
 * determines where it fits in a layout and the slope is only how it looks.
 * What falls out of that shows back up as a trait (see TRAITS).
 */

/* -- families ---------------------------------------------------------
 * One section per family in the Parts tab. Order here is page order: from
 * the bare building blocks to the dressing.
 */
export const FAMILIES = [
  { id: 'basic', name: 'Cliffs', color: '#9a8f80', test: (n) => n.startsWith('Basic_') },
  { id: 'wall', name: 'Walls', color: '#6f7b8c', test: (n) => n.startsWith('Wall_') },
  { id: 'cracked', name: 'Cracked Cliffs', color: '#a8705a', test: (n) => n.startsWith('Cracked_') },
  { id: 'grass-tier', name: 'Grass Steps', color: '#5f9e4a', test: (n) => n.startsWith('Tiered_Grass_') },
  // `Tiered_Walkway_` used to be its own family, but removing the actual
  // stairs (see the repo history) left a single orphan behind: a dirt/grass
  // path-transition piece with no steps of its own. It reads better folded
  // in with the paths it transitions into than standing alone as a family
  // of one.
  { id: 'path-terrain', name: 'Terrain Paths', color: '#d98f4f', test: (n) => n.startsWith('Path_Terrain_') || n.startsWith('Tiered_Walkway_') },
  // `Prop_Bridge_*` is folded in here too, for the same reason: the rest of
  // Props was removed, leaving six bridge pieces that belong with the
  // Path_Bridge_/Path_End_ pieces they're built to match, not alone under a
  // "Props" heading that otherwise has nothing left in it.
  { id: 'path-bridge', name: 'Bridges & Ends', color: '#8a5a2f', test: (n) => n.startsWith('Path_Bridge_') || n.startsWith('Path_End_') || n.startsWith('Prop_Bridge_') },
  { id: 'grass-carpet', name: 'Grass Carpet', color: '#79c04a', test: (n) => n.startsWith('Grass_Carpet_') || n.startsWith('Grass_Flat_') },
  { id: 'grass-hill', name: 'Grass Hills', color: '#3f8f5f', test: (n) => n.startsWith('Grass_Hill_') },
  { id: 'sand', name: 'Sand', color: '#e0c27a', test: (n) => n.startsWith('Terrain_Sand_') },
  { id: 'river', name: 'River', color: '#3aa7d6', test: (n) => n.startsWith('Terrain_Water_') },
  { id: 'water', name: 'Water & Waterfalls', color: '#2fc7e8', test: (n) => n.startsWith('Water_') || n.startsWith('Waterfall_') },
  { id: 'iceberg', name: 'Icebergs', color: '#8fc7ff', test: (n) => n.startsWith('Iceberg_') },
  { id: 'docks', name: 'Docks', color: '#c08447', test: (n) => n.startsWith('Docks_') },
  // What's left of the Cave family after its walls, floors and ceilings were
  // removed: the five pieces that finish the mouth of a cave where it meets
  // a cliff face, which the Cliff_Cave_Entrance_* assemblies are built from.
  { id: 'cave', name: 'Cave Edges', color: '#7a6a86', test: (n) => n.startsWith('Cave_') },
  // Kept as the structural fallback for anything that matches no other rule
  // above (see determineFamily) even though nothing currently lands here:
  // the only Prop_* pieces left are the bridge props, claimed by
  // `path-bridge` earlier in this list. Path Fences, Edging Stones,
  // Retaining Walls and most of the Cave family — its walls, floors and
  // ceilings — were removed outright rather than folded in: every one of
  // those models was deleted, so there was nothing left to move.
  { id: 'props', name: 'Props', color: '#b76fa8', test: (n) => n.startsWith('Prop_') },
];

/* -- shapes -------------------------------------------------------------
 * How a piece fits into a layout. Deliberately not how it looks: a stepped
 * straight wall sits in the same grid slot as a smooth straight wall, and
 * that's what you're searching by while building.
 */
export const SHAPES = [
  { id: 'curve-inner', name: 'Inner Curve', color: '#d4694f', pattern: /Curve_Inner/ },
  { id: 'curve-outer', name: 'Outer Curve', color: '#e08b3e', pattern: /Curve_Outer/ },
  { id: 'curve', name: 'Curve', color: '#c9a227', pattern: /Curve/ },
  { id: 'esse', name: 'S-Curve', color: '#9b6bd6', pattern: /Esse/ },
  { id: 'incline', name: 'Incline', color: '#4f9ed4', pattern: /Incline/ },
  { id: 'overlapping', name: 'Overlapping', color: '#7f8fa6', pattern: /Overlapping/ },
  { id: 'straight', name: 'Straight', color: '#5f9e4a', pattern: /Straight/ },
  { id: 'stairs', name: 'Stairs & Ladder', color: '#b98c5a', pattern: /Steps|Stepped|Ladder/ },
  { id: 'transition', name: 'Transition', color: '#d76fa0', pattern: /Transition/ },
  { id: 'flat', name: 'Flat', color: '#8d8377', pattern: /Flat/ },
  { id: 'end', name: 'End & Corner', color: '#6f7b8c', pattern: /(^|_)(End|Corner)(_|$)/ },
  { id: 'standalone', name: 'Standalone', color: '#9a9a9a', pattern: /./ },
];

/* -- layers -----------------------------------------------------------
 * Where a piece belongs in a stack. `Under` is the underside you see when a
 * cliff overhangs; `Base`, `Mid`, and `Top` stack above it. Pieces without a
 * layer suffix stand alone — a hill or a prop doesn't stack.
 */
export const LAYERS = [
  { id: 'layer-under', name: 'Underside', color: '#6b6076', token: 'Under' },
  { id: 'layer-base', name: 'Base', color: '#8a6f5a', token: 'Base' },
  { id: 'layer-mid', name: 'Mid', color: '#b08968', token: 'Mid' },
  { id: 'layer-top', name: 'Top', color: '#d9b382', token: 'Top' },
  { id: 'layer-none', name: 'No Layer', color: '#9a9a9a', token: null },
];

/* -- sizes --------------------------------------------------------------
 * The grid footprint a piece takes up, as its name says. Not the measured
 * bounding box — that deliberately differs (an overhanging cliff pokes
 * outside its footprint) and lives in the detail panel instead.
 */
export const SIZE_GROUPS = [
  { id: 'size-1x1', name: '1 × 1', color: '#4f9ed4', test: (w, d) => w === 1 && d === 1 },
  { id: 'size-narrow', name: 'Narrow (1 × n)', color: '#5aa9c6', test: (w, d) => Math.min(w, d) === 1 },
  { id: 'size-2', name: '2 × 2 and 2 × n', color: '#6aa84f', test: (w, d) => Math.min(w, d) === 2 },
  { id: 'size-3', name: '3 × 3 and 3 × n', color: '#c9a227', test: (w, d) => Math.min(w, d) === 3 },
  { id: 'size-4', name: '4 × 4 and 4 × n', color: '#e08b3e', test: (w, d) => Math.min(w, d) === 4 },
  { id: 'size-large', name: '5 × 5 and larger', color: '#d4694f', test: (w, d) => Math.min(w, d) >= 5 },
  { id: 'size-none', name: 'No Grid Size', color: '#9a9a9a', test: () => true },
];

/* -- traits -------------------------------------------------------------
 * Whatever's in the name but doesn't fit a facet: how steep, how tight,
 * which variant. They show up in the detail panel and feed the card's title
 * attribute.
 *
 * Order is display order; the first match per trait wins, duplicate hits are
 * deduplicated.
 */
const TRAITS = [
  [/45_Degrees/, '45 degrees'],
  [/Deformed_Straight_Concave|Concave/, 'concave'],
  [/Deformed_Straight_Convex|Convex/, 'convex'],
  [/Deformed/, 'deformed'],
  [/Stepped/, 'stepped'],
  [/Gentle/, 'gentle'],
  [/Sharp/, 'sharp'],
  [/Grade_Transition/, 'grade transition'],
  [/Narrow/, 'narrow radius'],
  [/Wide/, 'wide radius'],
  [/Short/, 'short'],
  [/Tall/, 'tall'],
  [/Inside/, 'inside'],
  [/Outside/, 'outside'],
  [/_Both(_|$)/, 'both sides'],
  [/_CCW(_|$)/, 'counter-clockwise'],
  [/_CW(_|$)/, 'clockwise'],
  [/_Center(_|$)/, 'center'],
  [/_Edge(_|$)/, 'edge'],
  [/_Left(_|$)/, 'left'],
  [/_Right(_|$)/, 'right'],
  [/_Front(_|$)/, 'front'],
  [/_Rear(_|$)/, 'rear'],
  [/Roped|_Rope(_|$)/, 'rope'],
  [/Broken/, 'broken'],
  [/Cracked/, 'cracked'],
  [/Hinged/, 'hinged'],
  [/Plain/, 'no hinge'],
  [/Gate/, 'gate'],
  [/Pillar|Column/, 'pillar'],
  [/Mound/, 'mound'],
  [/Lowpoly/, 'lowpoly'],
  [/Midpoly/, 'midpoly'],
  [/Highpoly/, 'highpoly'],
  [/_Y_/, 'Y-junction'],
  [/Dirt/, 'dirt path'],
  [/Grass/, 'grass'],
  [/Sign/, 'sign'],
];

/* -- assemblies --------------------------------------------------------
 * Not pieces: whole arrangements of them, the pack's own prefabs rebuilt by
 * tools/assemble.mjs into one .glb each (see assemblies/placements.json).
 * They classify by what they build rather than by how they fit a grid, so
 * they get one table of their own instead of borrowing the four above —
 * `Crack_Large` is a hole in a grass field, not a "Prop" and not a size.
 *
 * Colors match the families the pieces come from, so a cliff assembly reads
 * as the same thing as the cliff pieces it's made of. The table covers the
 * 120 prefabs kept in assemblies/placements.json; the tab shows whichever of
 * those have actually been built into assemblies/.
 */
export const ASSEMBLY_GROUPS = [
  { id: 'assembly-cliff', name: 'Cliff Runs', color: '#9a8f80', test: (n) => n.startsWith('Cliff_Assembly_') },
  { id: 'assembly-water', name: 'Waterfalls & Cave Entrances', color: '#2fc7e8', test: (n) => n.startsWith('Cliff_') || n.startsWith('Water_') },
  { id: 'assembly-crack', name: 'Cracks', color: '#a8705a', test: (n) => n.startsWith('Crack_') },
  // The only `Path_` prefabs kept: the rope bridges over a river, plus the
  // bank they land on. Same color as the `Bridges & Ends` family they're
  // built from.
  { id: 'assembly-bridge', name: 'Bridges', color: '#8a5a2f', test: (n) => n.startsWith('Path_Bridge_') },
  { id: 'assembly-river', name: 'Rivers', color: '#3aa7d6', test: (n) => n.startsWith('River_') || n.startsWith('Terrain_Water_') },
  // The structural fallback for anything the rules above don't claim.
  // Nothing lands here now that the cave, retaining-wall, stairs and fence
  // prefabs are out of the placement list, and the path ones are down to the
  // bridges.
  { id: 'assembly-structure', name: 'Other', color: '#b98c5a', test: () => true },
];

/* -- tabs -----------------------------------------------------------
 * Four facets across the pieces, then the assemblies built from them.
 * `source` says which collection a tab draws from; without it, a tab reads
 * models/.
 */
export const TABS = [
  { id: 'parts', label: 'Parts', facet: 'family' },
  { id: 'shapes', label: 'Shapes', facet: 'shape' },
  { id: 'layers', label: 'Layers', facet: 'layer' },
  { id: 'sizes', label: 'Sizes', facet: 'size' },
  { id: 'assemblies', label: 'Assemblies', facet: 'assembly', source: 'assemblies' },
];

/* -- deriving -------------------------------------------------------------- */

const first = (list, test) => list.find(test);

/** A model's family; falls back to `props` so nothing ever falls through. */
export function determineFamily(name) {
  return first(FAMILIES, (f) => f.test(name)) ?? FAMILIES.at(-1);
}

/** A model's shape; the last rule catches everything. */
export function determineShape(name) {
  return first(SHAPES, (s) => s.pattern.test(name));
}

/**
 * A model's layer. The suffix isn't always at the end —
 * `Basic_Esse_Base_2x2` puts it in the middle — so the token is searched
 * anywhere in the name.
 */
export function determineLayer(name) {
  const tokens = new Set(name.split('_'));
  return first(LAYERS, (l) => l.token && tokens.has(l.token)) ?? LAYERS.at(-1);
}

/**
 * Grid size from the name: the last `nxn` wins. That's needed because signs
 * carry their aspect ratio in the name too — `Prop_Sign_16x9_1_1x1` is a
 * 16:9 sign on one grid cell — and the actual footprint always comes last.
 */
export function determineSize(name) {
  const matches = [...name.matchAll(/(\d+)x(\d+)/g)];
  if (matches.length === 0) return null;
  const [, w, d] = matches.at(-1);
  return { label: `${w} × ${d}`, width: Number(w), depth: Number(d) };
}

/** An assembly's group; the last rule catches everything. */
export function determineAssemblyGroup(name) {
  return first(ASSEMBLY_GROUPS, (g) => g.test(name)) ?? ASSEMBLY_GROUPS.at(-1);
}

export function determineSizeGroup(size) {
  if (!size) return SIZE_GROUPS.at(-1);
  return first(SIZE_GROUPS, (g) => g.test(size.width, size.depth));
}

export function determineTraits(name) {
  const out = [];
  for (const [pattern, label] of TRAITS) {
    if (pattern.test(name) && !out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * Numbered variants: `Cracked_Straight_2x2_3_Top` is the third of three
 * cracked straight pieces at 2 × 2. The number sits alone between
 * underscores and is never the size, since that always contains an `x`.
 */
export function determineVariant(name) {
  const withoutSize = name.replace(/\d+x\d+/g, '');
  const match = withoutSize.match(/_(\d+)(?=_|$)/);
  return match ? Number(match[1]) : null;
}

/** `Tiered_Retaining_Wall_Flat_Curve_1x1_Top` → `Tiered Retaining Wall Flat Curve 1x1 Top`. */
export const readableName = (name) => name.replace(/_/g, ' ');
