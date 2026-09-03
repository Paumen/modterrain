# Placement rules

Derived from `models/scenes/large_island_terrain_v3.json` (3084 placements), the
atom and assembly GLBs (geometry and material names) and
`models/assemblies/placements.json`. Nothing here is assumed; every rule was
measured. Check a placement set with `tools/check/lint-sockets.mjs` (below).

## Grid and transforms

- Scene dumps are in cell units, Unity left-handed. The export mirrors X:
  conjugate every matrix by diag(-1, 1, 1) (`tools/build/assemble.mjs`).
- Every piece origin sits on a cell centre (x.5, z.5).
- A stretched piece has its origin at the centre of the stretched span, so
  integer when the stretch factor is even.
- Multi-cell pieces are not centred on their origin. Take the footprint from
  the piece bounds in `catalog/catalog.json` (2x2: x -1.5..0.5, z -0.5..1.5;
  4-long strips: -1.5..2.5).
- Rotation is about Y only, in 90° steps. Nothing is tilted.
- Mirroring is a -1 X scale. Used for handed pieces: Esse, Incline, Grade
  transitions, 45° curves, cave edges, wall esses. No mirrored assets exist.
- Non-uniform scale only on Straight and Flat pieces, and only along the axis
  where the cross-section stays constant. Cliff and wall straights lengthen
  along the wall. Slopes, inclines, steps and sand inclines widen sideways.
  Flat tiles stretch both ways. Curves, Esses and transitions are never
  scaled (the demo has one scaled 2x2 hill curve, nothing else).
- Y is an integer for everything except the sand family (n - 0.5) and a few
  half-step retaining walls.

## Levels and stacking

- `Grass_Flat` at y is a 0.25 slab. Surface at y + 0.25.
- Sand flat is a 0.5 slab placed at n - 0.5, so its surface is exactly n. A
  beach sits 0.25 below the grass beside it. Sand inclines rise 0.5 over 4
  cells.
- River flat at y has its surface at y - 0.25. Water is always 0.5 below the
  ground surface beside it.
- Hill pieces at y rise from 0.25 to 1.25. Sharp climbs one level in 2 cells,
  gentle in 4. Low side grass at y, high side grass at y + 1.
- Cliff Base at y spans y - 1 to y + 2. Mid is 1 tall. Top spans y to
  y + 2.25 with its grass lip at 2 to 2.25.
- Cliff stack: Base y, Mid y + 2, y + 3, …, Top one above the last Mid.
  Without Mids, Top at y + 2. Plateau `Grass_Flat` at Top + 2.
- Ground at a cliff foot sits at the Base's own y (grass) or y + 0.5 (sand).
  The Base flares 0.25 cell outward and 1 down, buried under that ground.
- Walls: Base spans 0 to 2, Top at Base + 2. Cave floor tile at Base y,
  ceiling tile at Base + 5 (underside at Base + 4). `Wall_Incline` Base pairs
  with `Floor_Incline` at the same y, Top with `Ceiling_Incline` at + 4.
- `Cave_Edge_Esse` stacks like cliffs (+2, +3). `Cave_Center_Top` sits at
  Base + 4.
- Retaining walls straddle the cell edge (half-cell offset). Mid at the lower
  terrace y, 1 tall. Top cap at y + 1, the upper terrace level. Mids stack.
  `Tiered_Grass` lips sit at the upper level.
- Walkway steps 1x2 climb one level per 2 cells. Path transition pieces at
  the top level.
- Path pieces share the grass y. Dirt surface 0.08, grass edge 0.25.
  `Path_Terrain_Basic` is a one-cell edge strip; `Path_Terrain_Dirt_Flat`
  fills the centre. Incline gentle 1 in 4, sharp 1 in 2, Edge and Center
  variants side by side.
- Bridges: `Prop_Bridge` at bank level, which equals the water y.
  `Path_Bridge_*_Top` are cliff-Top-layer pieces. Rope end at Top + 2.
- Waterfall: Mid sheets at every cliff Mid layer, Top sheet at the cliff Top
  layer, flanked by `Waterfall_Left_Top_Terrain` (mirrored for the right
  side). Feed river at Top + 2, plunge pool river at Base y.
- River (assemblies): two Sharp hill banks facing inward at y, water tiles at
  y + 1, wide river bed `Grass_Flat` at y. Bends use inner plus outer hill
  curves with a `River_Curve` 3x3 at y + 1.

## Sockets

The demo scene is the legend. Read at socket level (one piece, one colour,
one plane, and what covers it), it says:

- A coloured socket is paired by the same colour covering its full outline.
  Yellow chains cliff tops and cave tiles, Green chains walls, Pink chains
  sharp hills, Blue chains gentle hills, Red chains path edges, sand inclines
  and walkway steps, Violet chains ground lips, Orange chains retaining walls
  and walkway tops. Level offsets are fixed by the pieces (retaining Mid to
  Top +1, Wall_Incline ±2, cave-edge Top +1).
- Orange takes Violet from the level above. A cliff Top's rear lip (0.25
  tall) is covered in full by grass Violet at +2. A hill's high end (1.25
  tall) is covered along its top 0.25 by grass Violet at +1; the rest faces
  the enclosed void under the plateau.
- A ground lip may meet the low band of a hill side: Violet against Pink or
  Blue, either way round. Violet also meets Red where a grass lip runs
  against a path edge or a step side, Red meets Green where a path enters a
  cave, and cave floor and ceiling tiles (Yellow) seat under wall ends
  (Green).
- Plain Hidden is the free socket. Cliff Base and Mid pieces chain through
  plain end caps, bottoms are plain, and a retaining-wall Mid's Orange top
  carries plain bottoms of whatever sits on the terrace above. Plain never
  pairs and never counts as misuse.
- Anything else fully covering a coloured socket is misuse. A socket with no
  full-cover partner is buried (informational) unless it is exposed.

The path family paints its grass side Violet and its dirt side Red whatever
the profile; its outer side, which is buried against a hill, is plain.

The Autumn demo (`models/scenes/autumn_terrain.json`) butts cave floor tiles, Yellow
edge on, straight against hill sides (Orange, Pink and Violet) around its
cave mouth, and one grass carpet's Orange against a wall's Green. The pairing
rule above is read from the island demo and does not admit these, so the
linter reports them as wrong colour: 8 sockets, all at that cave.

## Linting a placement set

```
node tools/check/lint-sockets.mjs models/scenes/large_island_terrain_v3.json --ocean -5.5
node tools/check/lint-sockets.mjs models/scenes/winter_terrain.json --ocean 0.75
node tools/check/lint-sockets.mjs models/scenes/autumn_terrain.json --ocean -6
node tools/check/lint-sockets.mjs models/assemblies/placements.json --assembly River_Straight_Wide --verbose
node tools/check/lint-sockets.mjs models/scenes/island.json --plain --json report.json
```

Input is a scene dump (`pieces` with `prefab` and `matrix`) or an assembly
placement list (`pos`, `quat`, `scale`). The tool places every atom, then:

- Socket pairing: coplanar, opposite-facing faces of other pieces are
  summed per colour over each socket. A socket is paired when an allowed
  colour covers at least 90% of it (or, for Orange, 90% of its top 0.25
  band with Violet), wrong when any other colour does, buried otherwise.
- Butt joints: a sample point that lies on an opposite-facing triangle of
  another piece (any material, any orientation, within 0.002) is covered.
  This is the kit's own rule, socket against socket, and it is what keeps
  nested curved stairs and stacked cliffs from being tested by rays at all.
- Exposure: from four points on every hidden face not covered by a butt
  joint, rays go out along the normal and over a hemisphere of 25
  directions. A ray reaching the sky or the horizon marks the face, unless
  the point is under water (`Water*` above it, or below `--ocean`). A face is
  exposed only when a small cone around the escaping ray escapes too;
  otherwise it is a hairline crack, reported separately. `--plain` adds the
  uncoloured `Hidden` faces (bottoms and backs).
- Scene edge: an exposed face whose escaping ray crosses no occupied cell
  column at all is tagged `[scene edge]` and counted separately. A dump cut
  out of a larger Unity scene, with its edging pieces removed, ends like
  that on every side. It still counts as exposed.
- `--ocean y` marks samples below y as under water and stops downward rays
  from counting. Without it a scene with nothing under its lowest ground
  reports every lip that looks down into the void (Winter: 582 instead of
  146).

Exit code is 1 when any face is exposed or any socket is paired with a wrong
colour. Baselines, each exposed face verified by rendering from the escaping
ray's direction:

- Demo (`large_island_terrain_v3.json`, `--ocean -5.5`): 11 exposed, 0 at
  the scene edge, 10 of them one open retaining-wall corner at (-11, 5, -11)
  and one sliver where a grass slab meets a hill at (-44, -5, -26). Wrong
  colour 17, among them the two cliff Tops placed at Base height at glTF
  (23.5, -4, -27.5) and (14.5, 6, -37.5).
- `island.json`: 0 and 0.
- Winter (`winter_terrain.json`, `--ocean 0.75`): 146 exposed, 87 at the
  scene edge. Of the rest, 43 are the rear lips (Orange, Yellow) of the
  cliff Tops at y = 5: the mountain is a hollow ridge with no plateau ground
  at 7, open from above and from behind. The remaining 16 are grass and
  hill lips beside that ridge and at the east cut. Wrong colour 0.
- Autumn (`autumn_terrain.json`, `--ocean -6`): 126 exposed, 41 at the
  scene edge. The cave is a cut-away with no mountain around it, so its
  floor and ceiling tile edges (Yellow), the cave-edge ends at the mouth
  (Green), the grass at y = 4 beside it and the plateau above it are open:
  about 60 faces. The rest are plateau lips at the rear cut and hill ends at
  the west cut. Wrong colour 8, all at the cave floor (see Sockets).
- Mutating the demo (five pieces each: grass tiles removed, cliff tops
  raised a level, hill esses rotated, Mid esses un-mirrored with `--plain`)
  gives 38, 54, 68 and 33 exposed faces, all within four cells of a mutated
  piece; per site the detection is 5/5, 5/5, 4/5 and 3/5.
