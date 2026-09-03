# Level maps

`modterrain-levels-1` is terrain written as a grid of whole levels. An LLM (or
a person) writes the grid; `tools/scene/levels-to-cells.mjs` chooses the
pieces and writes `modterrain-cells-1`, which the checkers and the renderer
read. Every placement rule the compiler applies was measured from the kit and
the demo dumps and is listed below, so a wrong picture is a compiler bug, not
a placement mistake.

```json
{
 "format": "modterrain-levels-1",
 "origin": [0, 0],
 "corners": "wide",
 "rows": [
  "0 0 0 0 0 0 0",
  "0 4 4 4 4 4 0",
  "0 4 4 4 4 4 0",
  "0 4 4 4 4 4 0",
  "0 4 4 4 4 4 0",
  "0 0 0 0 0 0 0"
 ]
}
```

- `rows` are read north to south: the first row is the highest z, the last the
  lowest. Tokens in a row run west to east. `origin` is the world cell of the
  south-west token, `[0, 0]` by default.
- A token is the level of that cell: the y of its grass slab, on the integer
  grid. The walkable surface is 0.25 above it. `.` is void: no terrain, and no
  cliff will be built facing it, so a map ends in open scene edges.
- `corners` is `wide` (2x2 rounded outer cliff corners, the demo's usual
  choice) or `sharp` (1x1 outer cliff corners).
- A drop of 1 between neighbours becomes a hill, a drop of 4 or more a cliff.

```
node tools/scene/levels-to-cells.mjs map.json --out map.cells.json
node tools/check/verify-scene.mjs map.cells.json --png map.png
node tools/check/test-levels.mjs            # every map in models/levels/
```

The compiler prints a picture of what each cell became before writing
anything: `.` grass, `<` `>` `^` `v` a cliff facing that way, `c` a cell of a
rounded outer cliff corner, `C` a sharp outer cliff corner, `i` a cell of an
inner (concave) cliff curve, `o` the low cell that curve rounds off, `/` a
hill ramp cell, `r` a cell of an outer hill curve, `j` a cell of an inner
hill curve.

## What it builds

Grass, cliffs for drops of 4 or more, sharp hills for drops of exactly 1.
Everything else is refused with the cell named:

- A cell that drops 2 or 3 to a neighbour (a retaining wall or a stacked
  hill would go there; neither is compiled yet).
- A cell low on two opposite sides, or on three or four: the kit has no
  one-cell-wide ridge or spire. A plateau must be two cells wide everywhere.
- A hill plateau narrower than four: the two-cell ramps from opposite sides
  would overlap.
- A hill edge and a cliff edge meeting in one cell (see **The junction** below),
  or a corner whose two sides fall to different ground levels.
- An inner corner that collides with another corner (a one-cell notch).

## The rules it applies

Measured from the kit's socket table and `models/scenes/large_island_terrain_v3.json`.

**Levels.** Ground at G, plateau at P, drop d = P − G ≥ 4. Cliff Base at G,
Mids at G + 2 … P − 3 (so d − 4 of them), Top at P − 2. The Top's grass lip is
at P … P + 0.25, level with the plateau slab, and its Orange rear socket is
covered by the slab's Violet. Every layer of one cliff cell shares one `at`
and one `rot`.

**Facing.** A cliff piece at `rot` 0 faces west (its cliff face is on local
−x, its plateau side on +x, its chain sockets on ±z). `rot` 90 faces north,
180 east, 270 south. That is the cell format's convention read off its own
matrix: at 90° local +x goes to world −z and local +z to world +x.

**Straight runs.** A cell whose neighbour on one side is ≥ 4 lower is a lip
cell facing that side. Consecutive lip cells along one line, facing the same
way, become one `Basic_Straight_*` stack stretched along the run
(`stretch [1, n]`, origin at the centre of the run).

**Outer corners.** A cell low on two adjacent sides. With `corners: wide` it
becomes a `Basic_Curve_Outer_2x2_Wide_*` block: the corner cell, the first cell
of each run beside it, and the plateau cell diagonally inward (which the piece
also covers with cliff top). The block's origin cell is that inward cell. When
those three cells are not free plateau at the same level (a plateau arm only
three cells long, or two corners sharing a run cell) the corner falls back to
`Basic_Curve_Outer_1x1_*`. Rotation by low sides: W+N 0, N+E 90, E+S 180,
S+W 270.

**Inner corners.** A plateau cell whose diagonal neighbour is ≥ 4 lower while
both cells between are lip cells facing that low cell becomes a
`Basic_Curve_Inner_2x2_Narrow_*` block with its origin on the plateau cell: it
claims the two lip cells and rounds off the low cell. Rotation by the diagonal:
NW 0, NE 90, SE 180, SW 270.

**Hills.** A drop of exactly 1 is climbed by `Grass_Hill_Sharp_Straight_1x2`,
which rises 0.25 to 1.25 over two cells: low grass at L meets its Violet
front, high grass at L + 1 covers the top band of its Orange back. The ramp
band therefore lies inside the high region, two cells deep. Each front cell
(the high cell touching the low one) is the piece origin; the piece faces
the low side with the same `rot` table as cliffs, and consecutive front
cells along one line become one piece stretched sideways (`stretch [1, n]`,
Pink chains along the sides). A convex corner of the high region is a
`Grass_Hill_Sharp_Curve_Outer_2x2` on the same 2x2 block as a wide cliff
corner. A concave corner is a `Grass_Hill_Sharp_Curve_Inner_2x2` on the 2x2
block of plateau cells diagonally inward from the low corner cell; its Pink
chains meet the two ramp bands, its Orange backs face the high grass, and
the low corner cell stays plain ground. The ground slab at L runs under the
whole band. Measured on the demo's hill banks, for instance the outer curve
at (−5.5, 4, −16.5) with rot-90 straights east of it and rot-0 straights
south of it.

## The junction, and why a walkable route to a clifftop is not compiled

A cell where a hill edge and a cliff edge meet is refused, and that one
refusal is what stops a hill ramp climbing to the top of a cliff. It is worth
recording what was measured, because the obvious fix does not work.

The obvious fix is to truncate the cliff stack under the hill: Base and Mids
up to the hill's ground, then the hill on top, with no cliff Top. The demo
appears to do this (`Grass_Hill_Sharp_Curve_Outer_2x2` at y −3 sits exactly on
a `Basic_Curve_Outer_2x2_Wide_Base` at y −5, whose top is −3). Implemented and
checked on a plateau at 5 with a cliff north and a hill terrace east, it fails:
4 wrong-colour sockets and 8 exposed faces. The truncated run's Orange meets
the neighbouring cliff Top's Yellow, the hill's Pink flank is left open where
the Top used to cap it, and a plateau slab's Violet lands on Yellow. The kit's
own answer is the `Grass_Hill_Grade_Transition_*` family, which is not
compiled yet.

A second wall sits behind the same goal. With only 1-drops and 4-and-more
drops, a boundary can never pass through a height difference of 2 or 3. A
terraced hillside climbing to a plateau whose other side is a cliff to open
ground always produces such a boundary where the terraces run alongside the
cliff's foot: the terrace at 3 stands 3 above the plain, the terrace at 2
stands 2. Both are refused. The kit covers those with
`Tiered_Retaining_Wall_*`, a 1-tall wall straddling a cell edge that stacks,
also not compiled yet.

So a walkable climb to a clifftop needs both families. What does work today is
a cliff standing on level ground with hills rolling against its foot
(`cliff_foot_hills`), and a cliff standing on a terraced apron the hills climb
to (that apron is what makes the cliff's foot one height everywhere).

**A cliff run stands on one ground level.** Measured on the demo: among 3084
placements there is exactly one pair of adjacent cliff Base pieces at
different heights, and that pair is 2 apart at a corner. A cliff foot is never
stepped. So if a hill's high ground touches a cliff, the cliff's foot rises
there and the cliff stands on the hill; to keep a cliff on the low ground, the
hill's raised cells must stay a cell clear of the face.

**Ground under cliffs.** The ground slab at G extends under every cliff
footprint that stands on G. The demo does this everywhere (for example the
`Grass_Flat_1x1` stretched 6×3 at (−5, −1, 11.5) runs under the wide curve at
(−6.5, −1, 10.5) and the straight Base beside it). Cliff pieces are shells;
without the slab the foot of an outer curve is open to the sky. This was the
one mistake in the hand-written probe below.

**Plateau grass.** Every cell no cliff piece claims gets its level's slab.
Slabs are greedy rectangles of `Grass_Flat_1x1` with `stretch [w, h]`.

## Probes

`models/levels/` holds small maps with a known clean verdict;
`tools/check/test-levels.mjs` compiles each, runs both checkers and fails on
any wrong colour or any exposed face that is not a scene edge.
`models/levels/cliff_corner.cells.json` is the same test for a hand-written
cells scene. `--out dir` also writes the compiled cells and a render per map.

| map | shape | pieces | table paired / open | mesh |
| --- | --- | --- | --- | --- |
| `minimal` | 2×2 plateau, all corners | 9 | 8 / 4 | clean |
| `plateau` | 5×5 plateau, wide corners | 27 | 48 / 24 | clean |
| `sharp` | 3×3 plateau at level 5, sharp corners | 29 | 28 / 12 | clean |
| `lshape` | L, one inner curve, one sharp fallback | 28 | 48 / 18 | clean |
| `terrace` | 8×8 plateau with a 4×4 at level 9 on it (one Mid) | 39 | 64 / 24 | clean |
| `cliff_corner` | hand-written: two runs, a wide curve, plateau | 10 | 14 / 12 | clean |
| `cliff8` | 14×14 at level 8, four Mid layers, ground apron | 59 | 48 / 24 | clean |
| `cliff_foot_hills` | a cliff wall on level ground, four hill mounds at its foot | 46 | 107 / 36 | clean |
| `hill` | 6×6 at level 1, ramp band with four outer hill curves | 13 | 31 / 13 | clean |
| `hill_lshape` | L at level 1, one inner hill curve | 16 | 37 / 17 | clean |

Every compiled map was clean on its first run. The open sockets in the table
column are all Violet ground lips buried against plain cliff shells or slab
edges at the scene boundary, which the table cannot see and the mesh linter
confirms are covered.

## How this was arrived at

The hand-written probe came first: ten pieces (two straight runs, an outer
curve, ground and plateau) written from `docs/placement-rules.md` and
`catalog/sockets.json` alone. First try: 0 wrong colours, 3 exposed faces,
all one cause, the ground slab stopping at the cliff foot. One fix made it
clean. That rate, one unwritten rule per ten pieces, each found only by
querying the demo dump, is why the compiler exists: the rule is written once
here and applied by code, and the LLM writes numbers on a grid.

Not compiled yet, in the order they would pay off: retaining walls (a drop
of 2 or 3 as a stacked terrace wall) and the hill-to-cliff grade transitions,
which together unlock a walkable climb to a clifftop; gentle hills (`Grass_Hill_Gentle_*`, four cells
deep), water, sand, paths, the `Under` layers for cliffs seen from below, and
the esses and 3x3 curves the demo uses to soften long runs.

When a scene is written by hand instead, `node tools/check/check-sockets.mjs
scene.json --suggest` lists, for every unpaired socket, the placements
(piece, `at`, `rot`, `mirror`, `stretch`) whose matching socket lands exactly
on it. See `docs/socket-table.md`.
