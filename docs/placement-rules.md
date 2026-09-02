# Placement rules

Derived from `scenes/large_island_terrain_v3.json` (3084 placements), the
atom and assembly GLBs (geometry and material names) and
`assemblies/placements.json`. Nothing here is assumed; every rule was
measured. Check a placement set with `tools/lint-sockets.mjs` (below).

## Grid and transforms

- Scene dumps are in cell units, Unity left-handed. The export mirrors X:
  conjugate every matrix by diag(-1, 1, 1) (`tools/assemble.mjs`).
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

Colours name a seam profile, but only within a piece family. Across families
the same profile can carry a different colour, and the demo scene (whose
seams are correct) shows which pairings the kit intends:

- Within a family, same colour meets same colour at the same level: Yellow
  chains cliff tops, Green chains walls, Pink chains sharp hills, Blue chains
  gentle hills, Red chains path edges, sand inclines and walkway steps,
  Violet chains ground lips.
- Orange is the one-level-up face. A hill's high end and a cliff Top's rear
  lip are Orange and meet Violet one level higher (cliff Top meets grass at
  +2). Retaining-wall Mid to Top is Orange to Orange at +1.
- The path family paints its grass side Violet and its dirt side Red whatever
  the profile, so a gentle path incline's Violet meets hill Blue, and a sharp
  one's meets hill Pink, at the same level.
- The walkway family's Pink (path transition curves) meets the path family's
  Red. Walkway step Red meets retaining-wall Orange and cliff-top Yellow.
- Plain Hidden is a real seam partner: cliff Base and Mid end caps, wall
  tops, and every bottom. Foot-level grass butts Base end caps. A
  retaining-wall Mid's Orange top carries the bottoms of whatever sits on the
  terrace above (tiered grass, walkway steps, path, grass).
- Cave floor and ceiling tiles are Yellow and meet wall Green.
- Sand Violet is 0 to 0.5 and meets sand; sand incline Red meets hill Pink
  and Blue half a level down.

`docs/seam-vocabulary.json` is the full list, learned from the demo and the
island scene: colour and family on both sides plus the level offset, with
counts. Seams outside it are reported by the linter.

## Linting a placement set

```
node tools/lint-sockets.mjs scenes/large_island_terrain_v3.json --ocean -5.5 --vocab docs/seam-vocabulary.json
node tools/lint-sockets.mjs assemblies/placements.json --assembly River_Straight_Wide --verbose
node tools/lint-sockets.mjs scenes/island.json --plain --json report.json
node tools/lint-sockets.mjs scenes/new_scene.json --learn docs/seam-vocabulary.json
```

Input is a scene dump (`pieces` with `prefab` and `matrix`) or an assembly
placement list (`pos`, `quat`, `scale`). The tool places every atom, then:

- Seam match: coplanar, opposite-facing socket faces of two pieces that
  overlap. Same colour, or Orange against Violet, counts as matched; any
  other pairing is listed under mismatches. Informational.
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
- Seam vocabulary: with `--vocab`, every coplanar seam (colour, family and
  level offset on both sides) is looked up in the learned list and unknown
  pairings are reported. `--learn` adds a trusted scene's seams to the list.

Exit code is 1 when any face is exposed or any seam is outside the vocabulary. Demo scene: 11 exposed faces, 10 of
them one open retaining-wall corner at (-11, 5, -11) and one sliver where a
grass slab meets a hill at (-44, -5, -26); both verified by rendering from the
escaping ray's direction. `scenes/island.json`: 0. Mutating the demo (five
pieces each: grass tiles removed, cliff tops raised a level, hill esses
rotated, Mid esses un-mirrored with `--plain`) gives 38, 54, 68 and 33
exposed faces, all within four cells of a mutated piece; per site the
detection is 5/5, 5/5, 4/5 and 3/5. The vocabulary check adds 0, 99, 36 and
6 unknown-seam faces for the same mutations, so a raised cliff top or a
flipped Mid esse is caught by its seams even where nothing becomes visible.
