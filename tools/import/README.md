# One-shot pack import

These ran once, to turn the purchased Unity pack into `models/atoms/`. They are not
part of building or checking terrain; nothing outside this directory imports
them. They are kept because re-importing a new version of the pack needs them.

- `zip.mjs` — reads the pack archive.
- `colormap.mjs` — builds `models/textures/colormap.png`, the shared colour atlas.
- `recolor.mjs` — points every material at that atlas and writes
  `catalog/palette.json`. The comments in `tools/build/build-catalog.mjs` and
  `tools/lib/textures.mjs` refer to what it recorded.
- `to-cell-units.mjs` — rescales GLBs from glTF units to one unit per cell.

After running any of them: `node tools/build/build-catalog.mjs` and
`node tools/build/build-pieces.mjs`.
