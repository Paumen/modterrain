Do not assume anything. If you doubt, ask for clarification.

## Building or adjusting terrain

Never assume the kit is wrong or has bugs and adjust it. If something seems
wrong, it's your placement and your understanding of how the kit works.

**Sockets are color-coded, and the colors live in the glTF material names** —
not in vertex colors, and not on the shared colormap the visible surfaces use
(see **Color** below). Visible surfaces use real material names
(`Grass`, `Cliff Face`, `Water River`, …); connecting faces are named
`Hidden <Color>` (`Hidden Yellow`, `Hidden Green`, …). Color = profile
identity: same color means the two cross-sections are geometrically identical
and butt together exactly. You can and must blindly trust this.

Faces named plain `Hidden` (no color) typically don't need to connect to
anything on that side — it's not something a user sees when the pieces are
connected as they're supposed to be. That doesn't mean there's never a good reason to
connect something there: another piece facing the other way with a plain
hidden back, or terrain on the same square filling the bottom half of the
other side.

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
  the shared map the Taalei kits use — a 16 × 4 raster of vertical bands, one
  color per band, each running light at the top to dark at the bottom. A
  surface points its UVs at that map, so the color is not a number in the
  material and repainting the pack is one edit to one file.
  `catalog/palette.json` records which surface sits on which cell, and
  `tools/recolor.mjs` is what put it there and can do it again.
- **Shading:** cliff faces are shaded by height, the way the Kenney kits do
  it — light where they face the sky, dark where they meet the ground, from
  the two ends of one band with the rasterizer filling in between. The four
  layers share the band, so `Top` sits in its lightest quarter and `Under` in
  its darkest and a full stack reads as one gradient. `Mid` is the exception
  and is one flat tone at the middle of its quarter: it is the piece meant to
  repeat, and a ramp that repeats sawtooths — every seam in a run would jump
  back to light. However many Mids you stack, they read as one wall.
  Everything else takes one flat color.
  Wood, rope and water are the exception: their UVs tile far outside 0–1, so
  they keep their own texture (`tools/textures.mjs`). The `Hidden` faces keep
  their own colors too — those are socket identity, not decoration.
- **Rendering:** make sure backface culling is enabled, as standard glTF
  behavior requires. Every material is single-sided and most pieces are
  one-sided shells; drawing backfaces hides the shells, a real glTF viewer
  culls them.
- **Mirroring:** the pack ships almost no pre-mirrored pieces. When you need
  a mirrored variant, mirror the piece yourself.

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
