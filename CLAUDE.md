Do not assume anything. If you doubt, ask for clarification.

Never add comments to code files.

Build for touch (mobile/tablet) only.

For testing if fos really needed (I can test if you're pretty confident): 480×720 at deviceScaleFactor: 1. 

## Building or adjusting terrain

Never assume the kit is wrong or has bugs and adjust it. If something seems
wrong, it's your placement and your understanding of how the kit works.

**Sockets are color-coded, and the colors live in the glTF material names.**
Visible surfaces use real names (`Grass`, `Cliff Face`, `Water River`, …);
connecting faces are named `Hidden <Color>`. Same color means the two
cross-sections are geometrically identical and butt together.

Faces named plain `Hidden` usually don't need to connect to anything; they
aren't seen once the pieces are placed as intended. There can still be a
reason to butt something there: another piece facing the other way with a
plain hidden back, or terrain filling the bottom half of the same square.

Practical facts about the kit:

- **Scale:** 1 grid cell = 100 glTF units (`UNITS_PER_CELL` in
  `tools/glb.mjs`). Piece origins are cell centres, and multi-cell pieces
  anchor on one specific cell.
- **Layers:** some pieces come in `Under` / `Base` / `Mid` / `Top` variants that
  stack vertically. Pieces edges always connect on levels of 25 units. 
- **Index:** `catalog/catalog.json` lists every piece's family, shape, layer,
  grid size, bounds (in cells), and materials/sockets — check it before
  opening GLBs. Browse the pieces visually via `index.html`.
- **Rendering:** make sure backface culling is enabled, as standard glTF
  behavior requires. Every material is single-sided and most pieces are
  one-sided shells; drawing backfaces hides the shells, a real glTF viewer
  culls them.
- **Mirroring:** the pack ships almost no pre-mirrored pieces. When you need
  a mirrored variant, mirror the piece yourself.
- **Writing a scene:** author in `modterrain-cells-1`, the cell format —
  right-handed, `{piece, at, rot, mirror, stretch}`, no matrices. Both linters
  read it; `tools/scene-cells.mjs` converts to and from a Unity dump. See
  `docs/scene-format.md`.
- **Sockets as data:** `catalog/sockets.json` holds every coloured socket of
  every piece — cell edge, height band and exact outline — so piece choice is
  a lookup, not a geometry problem. See `docs/socket-table.md`.
- **Rules and checking:** `docs/placement-rules.md` lists the measured
  placement rules. Run `node tools/lint-sockets.mjs <scene.json>` on any
  placement set; exposed hidden faces are placement mistakes.
  `node tools/check-sockets.mjs <scene.json> --open` is the fast table-only
  pass: it names each unpaired socket and what covers it.

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
