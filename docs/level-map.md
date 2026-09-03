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
- `corners` is `wide` (2x2 rounded outer corners, the demo's usual choice) or
  `sharp` (1x1 outer corners).

```
node tools/scene/levels-to-cells.mjs map.json --out map.cells.json
node tools/check/verify-scene.mjs map.cells.json --png map.png
node tools/check/test-levels.mjs            # every map in models/levels/
```

The compiler prints a picture of what each cell became before writing
anything: `.` grass, `<` `>` `^` `v` a cliff facing that way, `c` a cell of a
rounded outer corner, `C` a sharp outer corner, `i` a cell of an inner
(concave) curve, `o` the low cell that curve rounds off.

## What it builds

Only grass and cliffs, and only drops of 4 or more. Everything else is
refused with the cell named:

- A cell that drops less than 4 to a neighbour (a hill or a retaining wall
  would go there; neither is compiled yet).
- A cell low on two opposite sides, or on three or four: the kit has no
  one-cell-wide ridge or spire. A plateau must be two cells wide everywhere.
- A corner whose two cliff sides fall to different ground levels.
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

Not compiled yet, in the order they would pay off: hills (drop 1 over 2 or 4
cells, `Grass_Hill_Sharp_*` / `Gentle_*`), retaining walls (drops 1 to 3),
water, sand, paths, and the `Under` layers for cliffs seen from below.
