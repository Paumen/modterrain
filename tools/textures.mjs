/**
 * Which material gets which real texture, and why these specific eight.
 *
 * These are exactly the materials PROVENANCE.md §2 flags as pointing at a
 * `.png` that doesn't exist in the delivery. The files themselves — matched
 * by filename, not guessed — live in `textures/`. Both
 * `tools/embed-textures.mjs` (writes the texture into the `.glb`) and
 * `tools/build-catalog.mjs` (needs a swatch color once the flat
 * `baseColorFactor` has been reset to white) read this same map, so a
 * material only has to be added here once.
 *
 * `Waterfall Crest` is deliberately absent: the `.glb` points it at
 * `uvmap image 32x16.png`, a UV-checker placeholder rather than a real
 * texture, so there's nothing correct to embed for it.
 */
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
