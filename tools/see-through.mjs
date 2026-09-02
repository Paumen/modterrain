export const SEE_THROUGH = ' (see through)';
export const markSeeThrough = (name) => name + SEE_THROUGH;
export const isSeeThrough = (name) => name.endsWith(SEE_THROUGH);
export const TERRAIN = new Set([
  'Grass', 'Grass Autumn', 'Snow Grass',
  'Dirt', 'Snow Dirt',
  'Cliff', 'Cliff Face',
  'Carved Stone Walkway',
  'Water River', 'Winter Water River', 'Water Ocean', 'Water Lake',
  'Waterfall', 'Waterfall Crest', 'Cave Waterfall', 'Cave Pool',
]);
