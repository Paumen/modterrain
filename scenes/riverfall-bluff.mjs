/* Builds scenes/riverfall-bluff.json — the placement list for a single scene
 * assembled from the pack's pieces and its own prefabs.
 *
 * Everything here is in glTF space (X right, Y up, Z toward the viewer, right
 * handed), so it is assembled with --no-mirror. Prefabs lifted out of
 * assemblies/placements.json are in Unity's left-handed space and go through
 * fromUnity() on the way in.
 *
 * A piece at rotation 0 is a cliff whose face looks down -X and whose land is
 * the +X half of its cell, so the edges of a plateau read:
 *   west -X = 0°, north +Z = 90°, east +X = 180°, south -Z = 270°.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PREFABS = JSON.parse(readFileSync(join(ROOT, 'assemblies', 'placements.json'), 'utf8')).assemblies;

const DEG = Math.PI / 180;
const quatY = (deg) => [0, Math.sin(deg * DEG / 2), 0, Math.cos(deg * DEG / 2)];

const mulQuat = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

function rotatePoint(quat, [x, y, z]) {
  const [qx, qy, qz, qw] = quat;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
  ];
}

const scene = [];

/* One piece. `at` is the cell the origin lands on, `turn` is degrees about Y,
 * `flip` mirrors the piece across its own X axis for the variants the pack
 * does not ship.
 */
function put(piece, at, { turn = 0, flip = false, scale = [1, 1, 1], y = 0 } = {}) {
  const [x, , z] = at.length === 3 ? at : [at[0], 0, at[1]];
  const height = at.length === 3 ? at[1] : y;
  scene.push({
    piece,
    pos: [x, height, z],
    quat: flip ? mulQuat(quatY(turn), [0, 1, 0, 0]) : quatY(turn),
    scale: flip ? [-scale[0], scale[1], scale[2]] : scale,
  });
}

// Unity left-handed → glTF: X flips, so the X translation and the Y/Z parts of
// the quaternion negate. This is the same conjugation tools/assemble.mjs does.
const fromUnity = ({ piece, pos, quat, scale }) => ({
  piece,
  pos: [-pos[0], pos[1], pos[2]],
  quat: [quat[0], -quat[1], -quat[2], quat[3]],
  scale,
});

/* Drops one of the pack's own prefabs into the scene, rotated and offset as a
 * rigid group so its internal joints stay exactly as the pack authored them.
 */
function putPrefab(name, at, { turn = 0, y = 0 } = {}) {
  const placements = PREFABS[name];
  if (!placements) throw new Error(`no prefab named ${name}`);
  const spin = quatY(turn);
  for (const raw of placements) {
    const { piece, pos, quat, scale } = fromUnity(raw);
    const [dx, dy, dz] = rotatePoint(spin, pos);
    scene.push({
      piece,
      pos: [at[0] + dx, y + dy, at[1] + dz],
      quat: mulQuat(spin, quat),
      scale,
    });
  }
}

/* ------------------------------------------------------------------ *
 * The bluff: a rectangular plateau ringed by cliff, Base + Mid + Top.
 * Base spans y -1..2, Mid is a 1 cell extender, Top is the grass crown
 * that adds another 2.25, so the grass lands at y = 5.
 * ------------------------------------------------------------------ */

const WEST = 0;
const EAST = 11;
const SOUTH = 0;
const NORTH = 9;

const LAYERS = [
  { y: 0, straight: 'Basic_Straight_Base_1x2', corner: 'Basic_Curve_Outer_1x1_Base' },
  { y: 2, straight: 'Basic_Straight_Mid_1x1', corner: 'Basic_Curve_Outer_1x1_Mid' },
  { y: 3, straight: 'Basic_Straight_Top_1x1', corner: 'Basic_Curve_Outer_1x1_Top' },
];

const GRASS_Y = 5;

// The stretch of north edge the waterfall takes over, in cells.
const FALL_FROM = 3;
const FALL_TO = 9;

/* The waterfall prefab is a drop in stretch of cliff run. Its Top layer is
 * authored one cell short of its Base and Mid layers along the run, so the
 * lower two shift by a cell to stack — which for a run turned 90° is a shift
 * in world X.
 */
const FALL = { x: 4, z: 8, turn: 90 };

putPrefab('Cliff_Waterfall_Wide_Base', [FALL.x - 1, FALL.z], { turn: FALL.turn, y: 0 });
putPrefab('Cliff_Waterfall_Wide_Mid', [FALL.x - 1, FALL.z], { turn: FALL.turn, y: 2 });
putPrefab('Cliff_Waterfall_Wide_Top', [FALL.x, FALL.z], { turn: FALL.turn, y: 3 });

/* The river that feeds it: a one cell bed between two cell wide sloping banks,
 * cut 1.25 down into the plateau so the banks top out flush with the grass.
 */
const RIVER_HEAD = 4;
const RIVER_MOUTH = 6;
const BED_Y = GRASS_Y - 1;

for (let z = RIVER_HEAD; z <= RIVER_MOUTH; z++) {
  put('Grass_Hill_Sharp_Straight_1x2', [5, BED_Y, z], { turn: 180 });
  put('Grass_Flat_1x1', [6, BED_Y, z]);
  // The falls' right hand terrain is a mirrored instance, so this bank mirrors too.
  put('Grass_Hill_Sharp_Straight_1x2', [7, BED_Y, z], { turn: 0, flip: true });
  put('Terrain_Water_River_Flat_1x1', [6, BED_Y + 1, z]);
}

/* The head of the channel: the same bank slope laid across the bed, so the
 * trench ramps back up to the grass instead of ending in a wall. The banks'
 * outward faces behind it look into the plateau's hollow, never the camera.
 */
put('Grass_Hill_Sharp_Straight_1x2', [6, BED_Y, RIVER_HEAD - 1], { turn: 90 });
put('Grass_Hill_Sharp_Curve_Inner_2x2', [5, BED_Y, RIVER_HEAD - 1], { turn: 180, flip: true });
put('Grass_Hill_Sharp_Curve_Inner_2x2', [7, BED_Y, RIVER_HEAD - 1], { turn: 0 });

/* Cells the waterfall terrain and the river banks already surface, measured off
 * the built scene rather than guessed: the channel column and its banks from
 * the head up to the lip, plus the two shoulders the falls sweep around.
 */
const taken = new Set(['3,8', '9,8']);
for (let x = 4; x <= 8; x++) for (let z = RIVER_HEAD - 2; z <= NORTH - 1; z++) taken.add(`${x},${z}`);

for (const layer of LAYERS) {
  put(layer.corner, [WEST, layer.y, NORTH], { turn: 0 });
  put(layer.corner, [EAST, layer.y, NORTH], { turn: 90 });
  put(layer.corner, [EAST, layer.y, SOUTH], { turn: 180 });
  put(layer.corner, [WEST, layer.y, SOUTH], { turn: 270 });

  for (let z = SOUTH + 1; z <= NORTH - 1; z++) {
    put(layer.straight, [WEST, layer.y, z], { turn: 0 });
    put(layer.straight, [EAST, layer.y, z], { turn: 180 });
  }
  for (let x = WEST + 1; x <= EAST - 1; x++) {
    put(layer.straight, [x, layer.y, SOUTH], { turn: 270 });
    // The waterfall prefab brings its own cliff for the stretch it covers.
    if (x < FALL_FROM || x > FALL_TO) put(layer.straight, [x, layer.y, NORTH], { turn: 90 });
  }
}

/* A dirt trail: west to east along the southern grass, then a corner north to
 * the overlook beside the falls. Path tiles sit at carpet height and simply
 * replace the grass on the cells they run through — red joins path to path,
 * violet joins the grass verge to the field either side.
 */
const trail = new Set();
for (let x = WEST + 1; x <= 8; x++) {
  put('Path_Terrain_Basic_Straight_1x1', [x, GRASS_Y, 1]);
  trail.add(`${x},1`);
}
put('Path_Terrain_Basic_Curve_Inner_1x1', [9, GRASS_Y, 1]);
trail.add('9,1');
for (let z = 2; z <= NORTH - 3; z++) {
  put('Path_Terrain_Basic_Straight_1x1', [9, GRASS_Y, z], { turn: 90 });
  trail.add(`9,${z}`);
}

// Grass field across the top of the plateau.
for (let x = WEST + 1; x <= EAST - 1; x++) {
  for (let z = SOUTH + 1; z <= NORTH - 1; z++) {
    if (taken.has(`${x},${z}`) || trail.has(`${x},${z}`)) continue;
    put('Grass_Carpet_Center_1x1', [x, GRASS_Y, z]);
  }
}

// The lake the bluff stands in, pulled in so it reads as a tarn, not an ocean.
put('Water_Circle_2_Midpoly', [5, -0.15, 4], { scale: [0.55, 1, 0.55] });

mkdirSync(join(ROOT, 'scenes'), { recursive: true });
writeFileSync(
  join(ROOT, 'scenes', 'riverfall-bluff.json'),
  `${JSON.stringify({ units: 'gltf_right_handed_y_up', coords: 'gltf_right_handed_y_up', assemblies: { 'Riverfall_Bluff': scene } }, null, 1)}\n`,
);
console.log(`riverfall-bluff.json: ${scene.length} placements`);
