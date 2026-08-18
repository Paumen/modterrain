# Where the models come from

## What arrived

One zip, `glb_394_from_fbx.zip`, containing 394 `.glb` files in a folder
`glb_from_fbx/`. No license file, no readme, no pack page, no author name.
The files sit in `models/` unchanged, with one deliberate exception: see §2.

The zip's name says it's a conversion from FBX, and the files confirm that:
every `.glb` names `Open Asset Import Library (assimp v5.3.0)` as its
generator.

## What the files themselves say about their origin

Several materials reference textures in a folder
`Workspace/Modular Terrain 2.0/Textures/` on the author's machine. **Modular
Terrain 2.0** is the source pack's name — confirmed, not guessed: the pack's
own Unity material definitions and texture set line up with these files
exactly. The `_Color` values Unity stores for materials like
`Terrain/Cliff.mat` and `Terrain/Grass.mat` match the `baseColorFactor`
values baked into these `.glb` files to four decimal places.

That correspondence is also how the color-space mistake below (§1) was
found and fixed, and it's what the missing textures (§2) turned out to be:
real files that exist, just not in this delivery.

## License: unknown

**The license has not been established.** None came with the pack and none
can be recovered from the files. Whoever recognizes the pack or tracks down
the source can extend this file with the author and the terms.

Until then: don't assume these models are free to use. This repo is a
catalog of the files, not a claim about what you're allowed to do with them.

## What went wrong in the conversion

Two things went sideways during the FBX → glTF conversion — a third thing
that looked wrong turned out not to be.

### 1. Not a bug: the material colors are correct as delivered

An earlier version of this file claimed the FBX export had written sRGB
color bytes into `baseColorFactor`, a field the glTF spec calls linear, and
that a spec-conforming viewer would therefore render everything too pale —
the cliff beige `#bfb9ae` showing up as a washed-out `#e0ddd7`. The catalog
"corrected" for that by pre-distorting every color before handing it to the
viewer.

That was wrong. The pack's own Unity material definitions settle it: `Cliff`
stores the *exact* linear value baked into `Basic_*`'s `baseColorFactor`
(`0.749, 0.7255, 0.6824`, to four decimal places), and Unity's own
gamma-decode of that number is `#E0DCD6` — the "washed-out" color, not the
saturated one. `Grass` matches the same way: linear `0.3882, 0.7294, 0.1804`
decodes to `#A6DD75`, a pale green, matching plain unmodified glTF rendering.

The correction has been removed. `baseColorFactor` is exactly what the glTF
spec says it is, decoded exactly as the spec says to decode it, matching
what the source Unity project itself considers correct. The lesson: a color
that looks "off" from a design-sensibility guess isn't evidence of a
color-space bug — checking against the actual source data is.

### 2. Some models referenced textures that didn't exist — now fixed

The wood and rope pieces, and the water and waterfall surfaces, carried a
reference to a `.png` that should have sat next to the `.glb` but didn't.
The FBX export left an absolute path from the author's machine in there, so
those files couldn't be found anywhere — they weren't in the zip either.

The actual texture files turned up separately, matched by filename against
the pack's own Unity project (same correspondence as §1). They're checked in
at `textures/`, and `node tools/embed-textures.mjs` has already patched the
47 affected `.glb` files: the real PNG is embedded in place of the broken
reference, and — because the pack's own Unity materials show these textures
as untinted (`_Color = 1,1,1,1`) — the flat `baseColorFactor` each model
carried instead is reset to white rather than left multiplying the now-real
texture. That flat color had been a stand-in for the missing texture the
whole time; keeping it as a tint on top of the real thing would have been
keeping the bug's artifact, not fixing it. This is the one place `models/`
deliberately diverges from the delivered zip, and it's rerunnable: dropping
a fresh copy of a texture into `textures/` and running the tool again picks
it up.

Thirteen models still show a *Missing texture* line in the catalog, and
that's expected, not leftover: `Rope`'s normal map (`Rope NM.png`) adds bump
detail this catalog has no way to render anyway, and `Waterfall Crest`
points at `uvmap image 32x16.png` — a UV-checker placeholder, not a real
texture, so there's nothing correct to embed there even with the source
Unity project in hand.

### 3. The origin doesn't sit inside the model

Every piece sits where it belongs on the grid, not at the origin. That's not
a bug — it's exactly what a modular kit should do. A cliff corner that
starts at x = -0.5 lines up there with the neighboring tile; "fixing" that
would break the kit's modularity.

The catalog therefore shows a *Position relative to origin* line for every
model, with the bounding box in grid cells.

## The assembly placements

`assemblies/placements.json` did not come from the zip. It was read out of
the source pack's own prefabs — the same **Modular Terrain 2.0** project
that settles the material colors in §1 — as one flat list per prefab: piece
name, position, rotation quaternion, scale. No geometry of their own, just
arrangements of the pieces in `models/`.

It is a subset, not the whole set: the source has 212 prefabs, and the cave,
retaining-wall, stone-stairs and fence ones were dropped here, along with
the paths except for the three bridges, leaving 123. That's a choice about
this repo's scope, not something missing from the pack — the same as the
models removed from `models/`. The full list is recoverable from the source
project.

Two things about that data are Unity's rather than glTF's, and
`tools/assemble.mjs` converts both: the coordinate system is left-handed
(mirrored on X relative to the converted `.glb` files), and a position of
`1.0` means one tile, not one unit — see *Scale* below.

Fifteen of the 123 name pieces this repo doesn't carry. Fourteen are
waterfalls asking for `Mist` and `Ripple`, which are particle effects rather
than models, so no delivery of this pack could have contained them; the
fifteenth is `Crack_Large`, asking for the floor tile that went with the
Cave family. That last one is this repo's scope, not a gap in the pack.

A name with no `.glb` behind it isn't always a missing model, either: a
prefab lists its own child objects the same way it lists whole models, so
`Water_Waterfall_Top_Center_1x3_Crest` reads like a piece when it is one of
the three nodes inside `Water_Waterfall_Top_Center_1x3.glb`. Both tools
check the nodes inside the models they loaded before calling anything
missing.

## Scale

One grid cell is **100 units** in the source files. That's measured, not
assumed: every piece named `1x1` measures 100 wide or deep, `12x12` measures
1200, `7x7` measures 700, and the height follows the same grid — a
single-layer base block is 100 tall, a two-layer wall piece 200.

`node tools/build-catalog.mjs` checks that assumption against the size in
each filename on every run.

Every dimension in the catalog is in grid cells, i.e. divided by 100. Anyone
loading the `.glb` files straight into an engine gets the units from the
files and has to scale accordingly.
