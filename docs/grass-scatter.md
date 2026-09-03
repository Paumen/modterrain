# Scattering grass over the terrain

An experiment: cover every `Grass` surface of a scene with tufts from the
KayKit forest pack, and split the scene into three bands so the two tuft
families can be compared side by side on the same terrain.

## The pieces

`models/props/` holds eight tufts, all authored at scale 0.3 with the KayKit
`colormap` atlas (copied to `models/props/Textures/colormap.png`):

| family | pieces | height (units) | shape |
| --- | --- | --- | --- |
| type 1 | `grass-1-a` … `grass-1-d` | 0.16 … 0.17 | short, broad blades |
| type 2 | `grass-2-a` … `grass-2-d` | 0.16 … 0.27 | tall, thin blades |

Within a family `a` is a single tuft and `d` the widest clump, so picking
uniformly from the four already varies how dense a spot reads.

## Building a scatter

```
node tools/build/build-grass-scatter.mjs models/scenes/<scene>_merged.glb \
  [--density 4] [--seed N] [--material Grass] [--min-up 0.55]
```

It reads every triangle carrying the `Grass` material, drops the ones whose
normal tilts more than `--min-up` off vertical (grass does not grow on a wall),
and area-weighted-samples `--density` tufts per square cell. The result goes to
`models/scenes/<scene>_grass.json`; the `_merged` suffix is dropped so the
viewer finds it under the scene name.

Per tuft the sampler rolls:

- **piece** — which of the four in the band's family,
- **yaw** — full 360°,
- **scale** — 0.55 … 1.9, biased small (`rnd() * rnd()`), so big clumps are rare,
- **height** — 0.75 … 1.35 of that scale, squashing or stretching the blades,
- **lean** — the surface normal plus up to ~9° in a random direction, so a tuft
  follows the hill it sits on without standing perfectly straight.

## The three bands

The scene is cut into three strips along whichever of x or z is longer, at the
33rd and 66th percentile of the samples, so each band holds a third of the
tufts:

| band | pieces used |
| --- | --- |
| 0 | type 1 only |
| 1 | type 2 only |
| 2 | both, 50/50 |

`meta.axis`, `meta.cuts` and `meta.counts` record the split.

## Looking at it

`viewer.html` loads `<scene>_grass.json` if it exists, imports the eight GLBs
once each and draws them as thin instances — one draw call per piece for the
whole island. The 🌿 button (or **G**) toggles the grass, and the HUD names the
band you are standing in.

Instance matrices are composed by `instanceMatrix()` in `tools/lib/scatter.mjs`,
which both the builder and the viewer share, so the stored nine numbers per
tuft (`piece, x, y, z, yaw, scale, height, nx, nz`) mean the same thing on both
sides.
