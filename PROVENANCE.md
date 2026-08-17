# Where the models come from

## What arrived

One zip, `glb_394_from_fbx.zip`, containing 394 `.glb` files in a folder
`glb_from_fbx/`. No license file, no readme, no pack page, no author name.
The files sit unchanged in `models/`.

The zip's name says it's a conversion from FBX, and the files confirm that:
every `.glb` names `Open Asset Import Library (assimp v5.3.0)` as its
generator.

## What the files themselves say about their origin

The sign materials reference textures in a folder
`Workspace/Modular Terrain 2.0/Textures/` on the author's machine. **Modular
Terrain 2.0** is therefore probably the source pack's name. That's a clue,
not proof — it's a path inside a file, not a license notice.

## License: unknown

**The license has not been established.** None came with the pack and none
can be recovered from the files. Whoever recognizes the pack or tracks down
the source can extend this file with the author and the terms.

Until then: don't assume these models are free to use. This repo is a
catalog of the files, not a claim about what you're allowed to do with them.

## What went wrong in the conversion

Three things went sideways during the FBX → glTF conversion. None of the
three has been fixed — the files in `models/` are exactly as delivered — but
the catalog accounts for them and surfaces them.

### 1. The material colors are in the wrong color space

The pack has no texture atlas, just 30 flat material colors, and those were
written into `baseColorFactor` as sRGB values. The glTF spec calls that field
linear, so a spec-conforming viewer applies gamma correction on top: the
cliff beige `#bfb9ae` renders as `#e0ddd7`, the grass green `#63ba2e` as a
pastel `#a7de76`. Since 160 of the 394 pieces are made of that one beige
material, that turns the catalog into a grid of white blocks.

`catalog/catalog.js` corrects the colors at display time (see
`restoreColorSpace`). The `.glb` files themselves, and anything behind the
download button, are untouched. Anyone who wants to see the pack as it sits
on disk can remove those two calls.

A real fix would rewrite `baseColorFactor` in the 394 files themselves.
That's deliberately not done here: it would make the files diverge from what
was delivered, and that's a decision for whoever owns the pack, not for the
catalog.

### 2. Sixty-seven models reference textures that don't exist

The wood, the rope, the water, and the signs carry a reference to a `.png`
that should have sat next to the `.glb` but doesn't. The FBX export left an
absolute path from the author's machine in there, so those files can't be
found anywhere — they weren't in the zip either.

The viewer falls back to the flat material color and shows the model
normally; only the wood grain and the text on the signs are missing.
`node tools/build-catalog.mjs` names the affected models, and the catalog's
detail view adds a *Missing texture* line for each one.

### 3. The origin doesn't sit inside the model

Every piece sits where it belongs on the grid, not at the origin. That's not
a bug — it's exactly what a modular kit should do. A cliff corner that
starts at x = -0.5 lines up there with the neighboring tile; "fixing" that
would break the kit's modularity.

The catalog therefore shows a *Position relative to origin* line for every
model, with the bounding box in grid cells.

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
