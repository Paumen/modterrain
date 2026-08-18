export const FAMILIES = [
  { id: 'basic', name: 'Cliffs', color: '#9a8f80', test: (n) => n.startsWith('Basic_') },
  { id: 'wall', name: 'Walls', color: '#6f7b8c', test: (n) => n.startsWith('Wall_') },
  { id: 'cracked', name: 'Cracked Cliffs', color: '#a8705a', test: (n) => n.startsWith('Cracked_') },
  { id: 'grass-tier', name: 'Grass Steps', color: '#5f9e4a', test: (n) => n.startsWith('Tiered_Grass_') },
  { id: 'path-terrain', name: 'Terrain Paths', color: '#d98f4f', test: (n) => n.startsWith('Path_Terrain_') || n.startsWith('Tiered_Walkway_') },
  { id: 'path-bridge', name: 'Bridges & Ends', color: '#8a5a2f', test: (n) => n.startsWith('Path_Bridge_') || n.startsWith('Path_End_') || n.startsWith('Prop_Bridge_') },
  { id: 'grass-carpet', name: 'Grass Carpet', color: '#79c04a', test: (n) => n.startsWith('Grass_Carpet_') || n.startsWith('Grass_Flat_') },
  { id: 'grass-hill', name: 'Grass Hills', color: '#3f8f5f', test: (n) => n.startsWith('Grass_Hill_') },
  { id: 'sand', name: 'Sand', color: '#e0c27a', test: (n) => n.startsWith('Terrain_Sand_') },
  { id: 'river', name: 'River', color: '#3aa7d6', test: (n) => n.startsWith('Terrain_Water_') },
  { id: 'water', name: 'Water & Waterfalls', color: '#2fc7e8', test: (n) => n.startsWith('Water_') || n.startsWith('Waterfall_') },
  { id: 'iceberg', name: 'Icebergs', color: '#8fc7ff', test: (n) => n.startsWith('Iceberg_') },
  { id: 'docks', name: 'Docks', color: '#c08447', test: (n) => n.startsWith('Docks_') },
  { id: 'cave', name: 'Cave Edges', color: '#7a6a86', test: (n) => n.startsWith('Cave_') },
  { id: 'props', name: 'Props', color: '#b76fa8', test: (n) => n.startsWith('Prop_') },
];

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

export const LAYERS = [
  { id: 'layer-under', name: 'Underside', color: '#6b6076', token: 'Under' },
  { id: 'layer-base', name: 'Base', color: '#8a6f5a', token: 'Base' },
  { id: 'layer-mid', name: 'Mid', color: '#b08968', token: 'Mid' },
  { id: 'layer-top', name: 'Top', color: '#d9b382', token: 'Top' },
  { id: 'layer-none', name: 'No Layer', color: '#9a9a9a', token: null },
];

export const SIZE_GROUPS = [
  { id: 'size-1x1', name: '1 × 1', color: '#4f9ed4', test: (w, d) => w === 1 && d === 1 },
  { id: 'size-narrow', name: 'Narrow (1 × n)', color: '#5aa9c6', test: (w, d) => Math.min(w, d) === 1 },
  { id: 'size-2', name: '2 × 2 and 2 × n', color: '#6aa84f', test: (w, d) => Math.min(w, d) === 2 },
  { id: 'size-3', name: '3 × 3 and 3 × n', color: '#c9a227', test: (w, d) => Math.min(w, d) === 3 },
  { id: 'size-4', name: '4 × 4 and 4 × n', color: '#e08b3e', test: (w, d) => Math.min(w, d) === 4 },
  { id: 'size-large', name: '5 × 5 and larger', color: '#d4694f', test: (w, d) => Math.min(w, d) >= 5 },
  { id: 'size-none', name: 'No Grid Size', color: '#9a9a9a', test: () => true },
];

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

// No Water_/Terrain_Water_ clause below: every assembly that matched one was a
// single-piece rebuild of a models/ file, not a real multi-piece prefab, and got
// dropped from assemblies/. Don't re-add the clause without re-adding assemblies
// that need it.
export const ASSEMBLY_GROUPS = [
  { id: 'assembly-cliff', name: 'Cliff Runs', color: '#9a8f80', test: (n) => n.startsWith('Cliff_Assembly_') },
  { id: 'assembly-water', name: 'Waterfalls & Cave Entrances', color: '#2fc7e8', test: (n) => n.startsWith('Cliff_') },
  { id: 'assembly-crack', name: 'Cracks', color: '#a8705a', test: (n) => n.startsWith('Crack_') },
  { id: 'assembly-bridge', name: 'Bridges', color: '#8a5a2f', test: (n) => n.startsWith('Path_Bridge_') },
  { id: 'assembly-river', name: 'Rivers', color: '#3aa7d6', test: (n) => n.startsWith('River_') },
  { id: 'assembly-structure', name: 'Other', color: '#b98c5a', test: () => true },
];

export const SCENE_GROUPS = [
  { id: 'scene-diorama', name: 'Scenes', color: '#4f8f6f', test: () => true },
];

export const TABS = [
  { id: 'parts', label: 'Parts', facet: 'family' },
  { id: 'shapes', label: 'Shapes', facet: 'shape' },
  { id: 'layers', label: 'Layers', facet: 'layer' },
  { id: 'sizes', label: 'Sizes', facet: 'size' },
  { id: 'assemblies', label: 'Assemblies', facet: 'assembly', source: 'assemblies' },
  { id: 'scenes', label: 'Scenes', facet: 'scene', source: 'scenes' },
];

const first = (list, test) => list.find(test);

export function determineFamily(name) {
  return first(FAMILIES, (f) => f.test(name)) ?? FAMILIES.at(-1);
}

export function determineShape(name) {
  return first(SHAPES, (s) => s.pattern.test(name));
}

// Layer token can appear anywhere in the name, not just at the end (`Basic_Esse_Base_2x2`).
export function determineLayer(name) {
  const tokens = new Set(name.split('_'));
  return first(LAYERS, (l) => l.token && tokens.has(l.token)) ?? LAYERS.at(-1);
}

// Last `nxn` wins: earlier ones can be aspect ratios (`Prop_Sign_16x9_1_1x1`).
export function determineSize(name) {
  const matches = [...name.matchAll(/(\d+)x(\d+)/g)];
  if (matches.length === 0) return null;
  const [, w, d] = matches.at(-1);
  return { label: `${w} × ${d}`, width: Number(w), depth: Number(d) };
}

export function determineAssemblyGroup(name) {
  return first(ASSEMBLY_GROUPS, (g) => g.test(name)) ?? ASSEMBLY_GROUPS.at(-1);
}

export function determineSceneGroup(name) {
  return first(SCENE_GROUPS, (g) => g.test(name)) ?? SCENE_GROUPS.at(-1);
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

// Sizes are stripped first so the variant match never picks up digits from `nxn`.
export function determineVariant(name) {
  const withoutSize = name.replace(/\d+x\d+/g, '');
  const match = withoutSize.match(/_(\d+)(?=_|$)/);
  return match ? Number(match[1]) : null;
}

export const readableName = (name) => name.replace(/_/g, ' ');
