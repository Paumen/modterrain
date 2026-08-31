Do not assume anything. If you doubt, ask for clarification.

## Building or adjusting terrain

Never assume the kit is wrong or has bugs and adjust it. If something seems
wrong, it's your placement and your understanding of how the kit works.

**Sockets are color-coded, and the colors live in the glTF material names.**
Visible surfaces use real names (`Grass`, `Cliff Face`, `Water River`, …);
connecting faces are named `Hidden <Color>`. Same color means the two
cross-sections are geometrically identical and butt together exactly — you
can and must blindly trust this.

Faces named plain `Hidden` usually don't need to connect to anything; they
aren't seen once the pieces are placed as intended. There can still be a
reason to butt something there: another piece facing the other way with a
plain hidden back, or terrain filling the bottom half of the same square.

Practical facts about the kit:

- **Scale:** 1 grid cell = 100 glTF units (`UNITS_PER_CELL` in
  `tools/glb.mjs`). Piece origins are cell centres, and multi-cell pieces
  anchor on one specific cell.
- **Layers:** pieces come in `Under` / `Base` / `Mid` / `Top` variants that
  stack vertically.
- **Index:** `catalog/catalog.json` lists every piece's family, shape, layer,
  grid size, bounds (in cells), and materials/sockets — check it before
  opening GLBs. Browse the pieces visually via `index.html`.
- **Color:** visible surfaces take their color from `textures/colormap.png`,
  the shared map the Taalei kits use, by pointing their UVs at it — so the
  color is one edit to one file, not a number in each material.
  `catalog/palette.json` records which surface sits on which cell, and
  `tools/recolor.mjs` put it there and can do it again. Wood, rope and water
  keep their own textures; the `Hidden` faces keep their own colors, which
  are socket identity rather than decoration.
- **Shading:** cliff faces are shaded by height along their color's band, and
  the four layers share it — `Top` in its lightest quarter, `Under` in its
  darkest, so a stack reads as one gradient. `Mid` is one flat tone, since a
  ramp on the piece meant to repeat would band at every seam.
- **Rendering:** make sure backface culling is enabled, as standard glTF
  behavior requires. Every material is single-sided and most pieces are
  one-sided shells; drawing backfaces hides the shells, a real glTF viewer
  culls them.
- **Mirroring:** the pack ships almost no pre-mirrored pieces. When you need
  a mirrored variant, mirror the piece yourself.

## The game page

`game/` runs `scenes/Large_Island_v2_No_Ocean_No_Props.glb` on Babylon.js as
the foundation of a 3D game. `game/README.md` is the real documentation; the
two facts most likely to catch you out elsewhere:

- **The scene files are in cells, not the pack's units.** The atoms store 100
  units to a cell, but the assembled scenes bake a scale of 100 into their node
  matrices, so their world space comes out at 1 unit per cell. `measureScene`
  in `tools/glb.mjs` divides by `UNITS_PER_CELL` and so reports a scene's size
  100x too small — the large island reads as 1.57 cells across when it is 157.
- **The scene GLBs are a rawer export than `atoms/`.** They carry positions
  only — no normals, no UVs, no colormap — with flat per-material colors, and
  their materials are all marked `doubleSided` by the trimesh export. Cull
  backfaces anyway, per the rendering note above.

## Environment

Installed:

Python (pip)
* mcp ≥1.0, cairosvg, matplotlib, graphviz

npm (global)
* eslint 9, globals 15, prettier 3
* stylelint 16 + configs: standard 36, recess-order 5, declaration-strict-value 1
* alpinejs 3, three 0.185, playwright 1

apt
* imagemagick, graphviz

Browsers
* Playwright Chromium (+ system deps)

Binaries
* GitHub CLI (gh), latest release → /usr/local/bin

Conditional (only if claude CLI present)
* registers claude-design MCP server (user scope, HTTP)
