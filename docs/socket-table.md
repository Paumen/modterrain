# The socket table

`catalog/sockets.json` holds every coloured socket of every terrain piece as
data: which plane it lies in, which cell edge it belongs to, how tall it is,
and its exact outline. It is generated from the GLBs by
`node tools/build/build-sockets.mjs` and is checked by `tools/check/check-sockets.mjs`,
which validates a placement set from the table alone — no meshes, no rays.

The point is that piece choice becomes a lookup instead of a geometry problem.
"What can sit east of this hill at y = 0" is a query against the table.

## What is in it

293 pieces (props and docks excluded), 794 coloured sockets. Each entry:

```
"Grass_Hill_Sharp_Straight_1x2": {
  "min": [-0.5, 0, -0.5], "max": [1.5, 1.25, 0.5],
  "cells": [[0, 0], [1, 0]],
  "sockets": [
    { "socket": "Orange", "side": "+x", "cell": 1, "coord": 1.5,
      "span": [-0.5, 0.5], "y": [0, 1.25], "area": 1.25,
      "spansCells": true, "tris": [...] },
    ...
  ]
}
```

- Coordinates are the piece's own frame. Cell `(0, 0)` is the origin cell and
  spans `-0.5 .. 0.5`; `cells` lists the cell offsets the piece covers.
- `side` is the face of that cell the socket sits on; `cell` is the cell index
  along the socket's own axis, or `null` for the three sockets in the kit that
  do not sit on a cell edge (retaining walls straddle one).
- `y` is the socket's height band, `span` its extent along the wall.
- `tris` is the exact outline in the socket plane, so coverage is measured by
  polygon overlap rather than by bounding box. Socket profiles are genuinely
  polygonal: of 2208 vertical coloured triangles, 1271 have a slanted edge.
- `skewed` records, per material, the area of coloured faces that are not
  axis-aligned. 43 pieces have some — the 45° lips on outer curves and the
  curved walkway steps. **The table does not hold those faces**; a placement
  whose validity rests on one still needs `tools/check/lint-sockets.mjs`.

## Measured facts behind it

Read off the kit and the three Unity demo dumps (4229 placements):

- Every coloured vertical socket lies in an axis-aligned plane on a cell
  boundary, bar three. 512 of 704 span whole cell edges exactly; the other 192
  are inset by a chamfer, 58 of them under 0.06 cell and the rest the jagged
  edges of cracked cliffs and cave mouths.
- The placement space is discrete. Across 3084 placements in the demo:
  0 tilted pieces, rotations only 0/90/180/270, 422 mirrored, 752 stretched by
  whole-number factors, 24 distinct Y values on the 0.25 grid, exactly one
  piece off the cell centre. Every placement fits
  `{piece, cell, y, rot, mirror, stretch}`.
- 228 distinct prefabs appear across the three scenes. The 50 most used cover
  79% of placements, the top 80 cover 88%.

## Checking a placement set

```
node tools/check/check-sockets.mjs models/scenes/large_island_terrain_v3.json
node tools/check/check-sockets.mjs models/scenes/autumn_terrain.json --open --limit 40
node tools/check/check-sockets.mjs models/assemblies/placements.json --assembly River_Straight_Wide
```

Each socket comes out `paired`, `wrong` or `open`. The pairing rules are the
ones in `docs/placement-rules.md`. Cover split across several allowed colours
counts too: a plateau slab's Violet edge met half by a curve's Orange and half
by the next slab's Violet is paired, reported as `Orange+Violet`. On the demo
that moves 255 sockets from open to paired (6258 to 6513 of 8041), almost all
Violet; the comparison with the geometry linter below predates it. `--open` lists unpaired sockets with the
cell edge, the height band and what covers them, which is what a generator
needs to pick the next piece. `--json` writes per-socket verdicts.

`open` merges the geometry linter's `buried` and `exposed`: deciding which of
those an unpaired socket is needs rays, so `tools/check/lint-sockets.mjs` stays the
authority on whether a scene is actually watertight.

## How well the table matches the geometry

On the demo scene, table verdicts against `lint-sockets.mjs` verdicts,
socket by socket: 7945 sockets in both, 6815 agree (85.8%). The linter also
holds 401 sockets the table does not — they are horizontal (`+y`/`-y`) sockets
and faces the table drops as skewed. The table holds none the linter lacks.

The 1130 disagreements are not noise; two causes account for almost all of
them, and in both the table is the more accurate of the two.

**558 Orange sockets the table pairs and the linter does not.** A hill's high
end is 1.25 tall and only its top 0.25 is covered, by grass Violet one level
up. The linter applies that band rule by keeping whole triangles that fall
inside the band, so it only fires when the mesh happens to carry a separate
triangle strip there; the table clips to the band and it always fires.

**397 Violet sockets the linter pairs and the table does not.** The linter
measures coverage as bounding-box overlap per triangle pair and sums it, so a
socket tessellated into two triangles scores roughly twice its real coverage
and passes the 90% bar at about 45% real cover. Reproduced minimally: a
two-cell grass strip whose Violet edge is met by a one-cell tile is 50%
covered, and

```
node tools/check/lint-sockets.mjs  models/scenes/half_cover_probe.json ->  Violet: 8 sockets, 2 paired
node tools/check/check-sockets.mjs models/scenes/half_cover_probe.json ->  Violet: 8 sockets, 1 paired
                                                         ... +x at x=1 spanning z 0..2  <- Violet 0.50
```

The linter's exposure pass still fails that scene, so no demo baseline in
`docs/placement-rules.md` is wrong. But its `paired` column reads high, and a
half-covered socket is a real placement mistake that its socket verdict misses.
