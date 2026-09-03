# The cell scene format

`modterrain-cells-1` is what a scene looks like when it is written rather than
dumped. `tools/scene-cells.mjs` converts a Unity dump into it and back, and
`lint-sockets.mjs` and `check-sockets.mjs` read it directly.

```json
{
 "format": "modterrain-cells-1",
 "pieces": [
  { "piece": "Grass_Flat_1x1", "at": [-1.5, 0, 2], "rot": 0, "mirror": false, "stretch": [3, 4] },
  { "piece": "Grass_Hill_Sharp_Straight_1x2", "at": [0.5, 0, 0.5], "rot": 0, "mirror": false, "stretch": [1, 1] }
 ]
}
```

- Right-handed, **+x east, +z north, +y up**. What you write is where the piece
  goes. A dump is Unity left-handed and every tool conjugates it by
  `diag(-1, 1, 1)`, which negates a placement's x but not the piece's
  orientation; this format is on the other side of that conversion, so the
  trap is gone.
- `at` is the piece origin in cells: x and z on the half grid, y on the quarter
  grid. Cell `(i, j)` spans `i .. i+1` and its centre is `i+0.5`.
- `rot` is 0, 90, 180 or 270 degrees counter-clockwise about +y, seen from
  above.
- `mirror` reflects the piece across its own x before rotating — the kit ships
  almost no pre-mirrored pieces, so handed pieces are mirrored here.
- `stretch` is `[x, z]` whole-number factors, along the piece's own axes.
- An entry carrying `matrix` instead of `at` is an **escape**: a placement that
  does not fit the grid, kept as a glTF-space matrix. Order is scene order
  either way, so placement indices line up with the dump.

## Converting

```
node tools/scene-cells.mjs scenes/winter_terrain.json --out winter_cells.json --verify
node tools/scene-cells.mjs winter_cells.json --to-dump --out winter_dump.json
node tools/check-sockets.mjs winter_cells.json --open
```

## What fits, measured

Over the five scenes in `scenes/`, 4340 placements:

| scene | as cells | escapes |
| --- | --- | --- |
| `large_island_terrain_v3` | 3081 | 3 |
| `winter_terrain` | 534 | 44 |
| `autumn_terrain` | 552 | 15 |
| `island` | 47 | 0 |
| `docks` | 126 | 0 |

Every escape is decoration, never terrain: the ocean discs
(`Water_Circle_*`, scaled 0.5 and 15.1), the waterfall sheets tilted 19° to
follow a cliff, the autumn `Branch_*` scatter, `Grass_Carpet_Straight_1x1`
nudged 0.04 off its cell, and Winter's icebergs, which float at y = 0.82 and
similar rather than on the quarter grid. Terrain itself is entirely discrete.

Round-tripping a dump through the format and back reproduces every matrix to
within 8e-6, with placements in the same order.

## The format snaps, and that is a change

Reconstructing from a whole rotation and a whole scale gives exactly `±1` and
`0` where a dump carries `0.9999999` and `-4.4e-8`. Two verdicts move because
of it, both in the same direction:

- Winter, under `lint-sockets.mjs`: 146 exposed faces become 130, and hairline
  cracks 232 become 248. Exactly those 16 faces move from one bucket to the
  other — the micro-misalignments that opened them are gone, and the gaps fall
  under the linter's 0.06-cell threshold.
- The demo scene, under `check-sockets.mjs`: one socket crosses the 90%
  coverage bar and reads paired.

This is not numerical noise. Jittering the Winter dump's positions by the same
8e-6 at random moves the count by one, to 147, not to 130. Snapping tightens
the scene; jitter does not.

## Authoring by hand

`scenes/hill_and_plateau.json` is six pieces written directly in this format:
a grass field, a four-row sharp hill, and the plateau it climbs to. It was
written once, without a correction, and

```
node tools/check-sockets.mjs scenes/hill_and_plateau.json --open
```

pairs all four Orange sockets and leaves eight unpaired, every one of them a
`nothing on the other side` at the edge of the patch. The same six pieces
written against the dump convention paired **no** sockets at all: the grass
landed east of the hill instead of west, because `at` was negated and the
piece's orientation was not.
