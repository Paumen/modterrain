/* What a piece is for.
 *
 * The kit's meaning lives in the piece name, not the material. "Wood Light" is
 * a bridge deck and a fence rail; "Carved Stone 1" is a walkway and a retaining
 * wall. Deciding walkability from the material therefore turns every fence into
 * a floor — measured, 91% of fence cells were walkable — so the roles below key
 * off the name the scene gives each mesh.
 */

export const Role = {
  // Ground you walk on.
  FLOOR: 'floor',
  // Ground you walk on that also spans something: bridges, decking, stairs.
  // Marked apart because water must not be blocked where one of these crosses.
  SPAN: 'span',
  // Meant to stop you: fences, railings, walls.
  BLOCKER: 'blocker',
  // Meant to stop you, and to be crossed only on a SPAN.
  WATER: 'water',
  // Rope, props: neither floor nor barrier.
  DECOR: 'decor',
};

const RULES = [
  [/^Terrain_Water_River|^Water_Waterfall|^Water_Circle/, Role.WATER],
  [/^Prop_Bridge|^Path_Bridge|^Docks_Decking|^Docks_Ladder|_Steps_/, Role.SPAN],
  [/^Path_Fence|^Docks_Railing|^Wall_|^Tiered_Retaining_Wall|^Docks_Bumper/, Role.BLOCKER],
  [/^Prop_Stalagmite|^Prop_Stalactite|^Prop_Column|^Prop_Protrusion/, Role.DECOR],
];

export function roleOf(piece) {
  for (const [pattern, role] of RULES) if (pattern.test(piece)) return role;
  return Role.FLOOR;
}

/* Materials that are never a surface underfoot whatever piece they belong to. */
const NEVER_FLOOR = new Set(['Rope', 'Water River', 'Waterfall', 'Waterfall Crest', 'Cave Pool']);

export function isFloorMaterial(material) {
  return !NEVER_FLOOR.has(material);
}
