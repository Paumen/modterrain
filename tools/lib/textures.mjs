// The surfaces that keep a texture of their own — the ones whose UVs tile far
// outside 0–1, so a patch on the shared colormap would be sampled across half
// the atlas. Everything else takes its colour from `models/textures/colormap.png`;
// `catalog/palette.json` says which colour, and tools/import/recolor.mjs put it there.
export const TEXTURE_BY_MATERIAL = {
  'Wood Dark': 'Wood Dark.png',
  'Wood Light': 'Wood Light.png',
  'Wood Light End': 'Wood Light End.png',
  'Wood Medium': 'Wood Medium.png',
  Rope: 'Rope.png',
  'Water River': 'Water River Texture.png',
  'Water Lake': 'Water Ocean Texture.png',
  Waterfall: 'Waterfall Texture.png',
};
