# Kit assembly rules

Rules of the terrain kit, determined from its own worked examples: the 123
prefabs in `assemblies/placements.json`, the rebuilt `assemblies/*.glb`, and
the `scenes/riverfall-bluff.mjs` scene. Every rule below is something the pack
itself does, measured from those files — not a guess.

## Grid and coordinates

- 1 grid cell = 100 glTF units (`UNITS_PER_CELL` in `tools/glb.mjs`).
  Placement positions are in cells; a piece's origin lands on a cell **centre**
  (its anchor cell). Multi-cell pieces extend from that anchor per the bounds
  in `catalog/catalog.json`.
- Placement files declare their space in a `coords` field and the two shipped
  files differ: `assemblies/placements.json` is `unity_left_handed_y_up` and
  must be mirrored on import (the default in `tools/assemble.mjs`: negate the
  X translation and the quaternion's Y and Z), while
  `scenes/riverfall-bluff.json` is `gltf_right_handed_y_up` and is assembled
  with `--no-mirror`. Always check `coords` before reusing transforms.

  Worked example, straight from `Cliff_Assembly_Curve_Inner_1_Base`:

  | | pos | quat (x y z w) | scale |
  |---|---|---|---|
  | Unity (placements.json) | `[3, 0, -2]` | `[0, 0.707107, 0, 0.707107]` | `[-1, 1, 1]` |
  | glTF (after conjugation) | `[-3, 0, -2]` | `[0, -0.707107, 0, 0.707107]` | `[-1, 1, 1]` |

  X of the position flips, Y and Z of the quaternion negate (the sense of
  the yaw reverses), the scale — including a mirror — passes through
  untouched.
- **Facing convention** (glTF space): a piece at rotation 0 is a cliff whose
  face looks down −X and whose solid land is the +X half of its cell. Ringing
  a plateau: west edge 0°, north +Z 90°, east 180°, south 270°.

## Transforms

Across all 783 prefab placements only these transforms occur:

- **Rotation: yaw only, in 90° steps.** The four Y-axis quaternions are the
  only rotations terrain pieces ever get — nothing is pitched or rolled. The
  single exception is decorative billboards: `Ripple` and `Mist` use a 180°
  turn about the (0, 1, 1) diagonal to lie flat / stand against a fall.
- **Mirroring: scale `[-1, 1, 1]` plus an extra 180° yaw** (quaternion
  multiplied by `[0, 1, 0, 0]`), exactly the `flip` helper in
  `scenes/riverfall-bluff.mjs`. The pack ships almost no pre-mirrored pieces;
  Esse pieces, cave edges, waterfall crown terrains, and the half-track path
  pieces are all placed as flipped instances where the other hand is needed.
  Never mirror in Y or Z.
- **Stretching: only pieces whose cross-section is constant along the stretch
  axis, only by whole cells, never in Y.** The prefabs stretch flat sheets
  (`Grass_Flat_1x1`, `Floor_And_Ceiling_Flat_1x1`) in X and/or Z, and straight
  extrusions (`Basic_Straight`, `Grass_Hill_*_Straight`, `Cave_Center`,
  `Path_End_Center`, `Waterfall_Center_Top_Terrain`) along their run only.
  Curves, esses, corners, and anything sculpted are never stretched. A
  stretched piece covering an even span centres on a cell edge, so its
  position gains a half-cell fraction (e.g. `z = 2.5` for a 1×1 scaled to
  1×2 covering cells 2 and 3).

## Sockets

- Colour = profile identity, carried in the glTF material names
  (`Hidden Yellow`, `Hidden Green`, …). In every joint of every shipped
  assembly, mating faces are the **same colour**, geometrically coincident,
  back to back. Exact triangle matching over all 123 assembly GLBs finds
  same-colour joints essentially exclusively.
- Only the sculpted band of a connecting face is colour-coded — the part
  where profiles must match exactly, e.g. the cliff lip band at local
  y 1.80–2.25 on `Basic_*_Top` pieces. Everything below and behind is plain
  `Hidden`, which simply butts against the neighbour's identical plain hidden
  face. Plain-hidden contact is the normal state of most of a joint.
- In every terrain family the assemblies use, colour-coded sockets are
  **vertical** faces (their normals are horizontal) and layers stack by grid
  position, not by socket. The one exception is the `Wall_*` family — absent
  from every shipped assembly — which colour-codes its stacking interface
  too: a horizontal `Hidden Blue` face on top of a wall Base, on both ends
  of a wall Mid, and under a wall Top.
- Where each colour shows up in the pack's own joints, by terrain context:

  *Cliffs, cracks, caves, walls*
  - **Yellow** — the cliff rim/lip profile: `Basic` tops joining along a
    cliff run, `Cracked` crack walls, grass-carpet lip ends, `Cave_Edge`
    bands, the outer ends of path crowns against the plain cliff run.
  - **Green** — the cave / wall arch interior profile.

  *Grass slabs and hill banks*
  - **Violet** — the flat grass slab edge (0–0.25 cells): flat grass to flat
    grass, path verge to the field beside it.
  - **Orange** — a full-height straight cut through grass slab/bank interior:
    grass-carpet back edges, the cliff top's plateau-facing edge, the high
    end of hill pieces, the bridge path centreline.
  - **Pink** — the sharp hill's sloped side profile.
  - **Blue** — the gentle hill's sloped side.

  *Paths, sand, waterfalls, icebergs*
  - **Red** — the dirt track cross-section: path tile to path tile along the
    run; also sand.
  - **Pink** — also joins the two mirrored halves of path-end crowns and of
    iceberg pieces.
  - **Blue** — also waterfall crown terrain joints; on `Wall_*` pieces it
    marks the horizontal Base/Mid/Top stacking interface (see above).

  As those double entries show, colours repeat across families that never
  touch (pink on hills vs. on icebergs is not the same cross-section). Mate
  a colour with itself in the pairings the pack itself demonstrates; a
  colour match between unrelated families is not evidence the profiles
  agree.
- `node tools/sockets.mjs <file.glb> [--verbose]` measures how much socket
  area is mated vs. open. Two caveats, both visible on the pack's own
  prefabs: its "joined across colors" warning also fires when two unrelated
  same-plane sockets merely sit adjacent, so treat it as a hint, not an
  error; and open sockets at an assembly's perimeter are by design — runs are
  meant to chain end to end. Open area in a *finished scene* is a mistake.

## Layers and vertical stacking

Basic cliff tiers, measured from the pieces and the scene:

- **Base** spans local y −1..2 — a one-cell skirt buried below ground plus
  two visible cells. Base always sits at y = 0; its skirt also flares one
  extra footprint cell at the foot (a Base can be 1×2 where its Mid is 1×1 —
  layer variants share the anchor cell, not the footprint).
- **Mid** is a one-cell extender, local y 0..1. The first Mid goes at
  **y = 2** (on top of Base's cliff), each further Mid one higher.
- **Top** is the grass crown, local y 0..2 plus a 0.25 walkable cap. It goes
  at y = 2 + (number of Mids).
- The plateau **surface level is Top's y + 2** (the cap makes the walk
  surface +2.25). In the shipped scene: Base@0, Mid@2, Top@3, grass at 5.
- The `Cliff_Assembly_*` prefabs come as Base/Mid/Top triplets with an
  **identical XZ plan** — same positions, rotations, and mirrors, only the
  layer suffix of every piece swapped. Stack the whole plan per tier and the
  run lines up vertically.
- **Cracks go down instead of up**: `Crack_Small`/`Crack_Large` put Mid crack
  walls at y = −1, Top walls (with the lip) at 0, and ring the hole with
  grass carpet at 1 — same tier arithmetic, dug into the surface.
- `*_Under` pieces (undersides for floating terrain) exist in the catalog but
  no shipped assembly demonstrates them.

## Surfaces on top

- Every ground surface is a **0.25-cell-thick slab**: `Grass_Flat`,
  `Grass_Carpet_*`, `Path_Terrain_*` tiles. On a plateau they go at the
  surface level (Top's y + 2); the rim cells need no slab — the Top pieces
  carry their own grass cap, and the carpet's orange back edge meets the
  Top's orange plateau edge.
- **Path tiles are half-tracks**: dirt on one side, grass verge with a violet
  cap on the other, the dirt centreline left open. Lay them as mirrored
  pairs meeting down the middle of the track (red joins tile to tile along
  the run) — the way `Cliff_Path_Narrow` does. Where a trail reaches a cliff
  rim, the `Path_End` crown pieces replace the plain Top run for those cells,
  again as a mirrored pair: yellow caps their outer ends against the cliff
  run, pink joins the two halves, red hands the track to the tiles inland.

## Rivers, waterfalls, water

- A river is a **trench cut one tier into the surface**: bed level =
  surface level − 1. Banks are `Grass_Hill` pieces placed *at bed level*
  facing the channel, so their 1.25-high tops come out flush with the
  surrounding grass. Sharp hills rise 1 cell over a 2-cell run; gentle over
  4; "Overlapping" hill variants are the banks that incline river sheets lie
  over; inner/outer hill curves pair up to bend the trench.
- The water sheet `Terrain_Water_River_Flat_1x1` has its surface 0.25 below
  its own origin. Place it at **bed level + 1**, putting the waterline half a
  cell below the bank tops.
- **Run the sheet one full cell into each bank** (and one into the head
  ramp). A sheet only as wide as the bed leaves its edges hanging in the
  air; overlapped, the waterline meets the bank slope exactly on the cell
  edges. `River_Straight_*` and the scene both do this.
- Close a channel's head with the same bank slope laid across the bed
  (straight + two mirrored inner curves), so the trench ramps up to the
  grass instead of ending in a wall.
- A river leaving over a cliff becomes a **waterfall**: `Water_Waterfall`
  Base/Mid/Top pieces stack on exactly the cliff tiers (Base@0, Mid@2,
  Top@3 in the scene), with `Waterfall_*_Top_Terrain` crown terrain at the
  top tier — the right-hand side is a mirrored instance of the left. The
  waterfall's Top layer is authored one cell short of its Base and Mid along
  the run, so the lower tiers shift by one cell along the run to stack (see
  `scenes/riverfall-bluff.mjs`).
- Foot-of-fall dressing: `Ripple` at y = −0.24 and `Mist` at y = −0.4,
  pushed ~1.15 cells out from the fall face — the only pieces placed off the
  grid. Lake discs (`Water_Circle_*`) sit just below ground (−0.15 in the
  scene) and may be scaled freely.

## Reusing the pack's prefabs

- Each entry in `assemblies/placements.json` is a **rigid group**. Reuse it
  whole — rotate and offset every placement together, composing the group
  quaternion onto each piece — so the internal joints stay exactly as
  authored (`putPrefab` in `scenes/riverfall-bluff.mjs`).
- Convert its Unity transforms to glTF space first: negate the X position and
  the quaternion's Y and Z components (`fromUnity`), the same conjugation
  `tools/assemble.mjs` applies.

## Checking your work

1. Rebuild: `node tools/assemble.mjs <name>` (add `--no-mirror` for
   glTF-space placement data).
2. Audit joints: `node tools/sockets.mjs <file.glb> --verbose` — inside a
   scene, aim for no open socket area that isn't a deliberate perimeter.
3. View with backface culling **on**; the pieces are one-sided shells and
   drawing backfaces hides them.
