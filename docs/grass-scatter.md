# Scattering grass over the terrain

An experiment: clump grass over every `Grass` surface of a scene, and split the
scene into three bands so the two tuft families can be compared side by side on
the same terrain.

## The pieces

`models/props/` holds eight tufts from the KayKit forest pack, authored at
scale 0.3 against the `colormap` atlas:

| family | pieces | shape |
| --- | --- | --- |
| type 1 | `grass-1-a` … `grass-1-d` | short, broad blades |
| type 2 | `grass-2-a` … `grass-2-d` | tall, thin blades |

`a` is a single blade and is never placed — grass reads as clumps, so the
scatter draws from `b` (132 triangles), `c` and `d` (396–528). `PIECE_WEIGHTS`
in `tools/lib/scatter.mjs` sets the mix; because everything is baked into one
buffer, that mix is what the scene costs.

## Building a scatter

```
node tools/build/build-grass-scatter.mjs models/scenes/<scene>_merged.glb \
  [--clusters 0.115] [--per 8] [--candidates 12] [--seed N] [--min-up 0.55]
```

It reads every triangle carrying the `Grass` material, drops the ones whose
normal tilts more than `--min-up` off vertical, and scatters `--candidates`
points per square cell over what is left. Cluster seeds are then drawn at
`--clusters` per square cell, each with its own radius and appetite, and a
candidate survives only if it falls inside one — with probability falling off
towards the edge. Between the clumps the ground stays bare.

Per clump the sampler rolls:

- **piece** — 65% the cluster's dominant piece, so a clump looks of a kind,
- **yaw** — full 360°,
- **scale** — 0.5 … 1.7 across, biased small (`rnd() * rnd()`),
- **height** — 0.8 … 1.2, independent of the width,
- **lean** — the surface normal plus up to ~9° in a random direction.

## One mesh, one draw call

The output is `models/scenes/<scene>_grass.glb`: every clump baked into world
space in a single indexed mesh with a single material — one draw call for the
whole island, no per-frame instance work. The pieces ship every triangle with
its own three vertices, so the builder welds duplicates first, which cuts each
clump to a quarter of the vertices it arrived with.

The material is **unlit** (`KHR_materials_unlit`): what you see is the gradient
baked into the atlas, from dark blade base to lighter tip, not the scene's
lights re-shading it. The atlas is embedded in the GLB and sampled `NEAREST`
with no mips — it is a palette of hard-edged swatches, and mip filtering blends
each swatch with its neighbours and with the black background around them.

The cost is memory: the bake trades a small instance buffer for a large static
one. At the defaults that is about 1.0 M triangles and 29 MB of vertex data.
`--clusters` and `--per` are the dials.

`<scene>_grass.json` carries the meta the viewer reads (bands, cuts, counts,
triangles, ground colour) plus the placement list the bake came from.

## Matching the ground

The tuft UVs sit in one column of the atlas, a yellow-olive gradient running
sRGB 141,170,73 down to 112,144,53. The terrain's own `Grass` material is a
flat forest green (sRGB #228B22) — a different green entirely, which is why
tufts sat on the ground looking pasted on.

So the builder reads the texels the tuft UVs actually hit and writes the
darkest one to `meta.ground`, and the viewer paints the terrain's `Grass`
material with it while the grass is on. Because the tufts are unlit and the
ground is not, the viewer divides by `GROUND_GAIN` — a measured factor, since
Babylon's PBR path is not a plain sum of the two light intensities.

Matching it exactly is a trap: the darkest tuft texel is still inside the range
the blades themselves cover, so the tufts dissolve into the ground and read as
noise. `--ground-shade` (0.5) takes the ground down in value while keeping the
hue, and the tufts carry a baked base-to-tip ramp in `COLOR_0` —
`--base-tint` 0.58 to `--tip-tint` 1.15, jittered ±10% per clump, because the
atlas gradient alone is a 13% change that nothing survives. Measured on the
same view, ground and grass went from 1.46:1 to 1.94:1 in contrast.

Toggling the grass off puts the original green back.

## The three bands

The scene is cut into three strips along whichever of x or z is longer, at the
33rd and 66th percentile of the cluster seeds:

| band | pieces used |
| --- | --- |
| 0 | type 1 only |
| 1 | type 2 only |
| 2 | both, 50/50 per cluster |

`meta.axis`, `meta.cuts` and `meta.counts` record the split. In `viewer.html`
the 🌿 button (or **G**) toggles the grass, and the HUD names the band you are
standing in along with the triangle count.
