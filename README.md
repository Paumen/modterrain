# Modular Terrain — 3D Catalog

A browsable catalog of 287 models from a modular terrain pack: cliffs,
walls, cracked cliffs, terrain paths, grass, sand, water, a cave, and
standalone props. Everything runs in the browser, no build step and no
server — opening `index.html` is enough.

The pack arrived with zero metadata, so the entire classification is derived
from filenames.

## Using the catalog

**Five tabs.** The first four look at the same 287 pieces differently; the
fifth shows what those pieces build:

| Tab | Groups by | For |
| --- | --- | --- |
| Parts | family | "show me all the cracked cliffs" |
| Shapes | inner curve, outer curve, s-curve, straight, incline… | "which pieces complete this curve?" |
| Layers | under, base, mid, top | "what stacks onto this row?" |
| Sizes | grid footprint from the name | "what fits this 3 × 3 gap?" |
| Assemblies | what the arrangement builds | "what does a finished bridge look like?" |

Beyond that:

- **Filter by material** with the chips under the header. Left: what a piece
  is made of. Right: the faces the pack marks as hidden — the sides that sit
  against a neighboring tile.
- **Click a tile** to open the model full-size, rotatable, with its
  dimensions, triangle count, materials, and the *Copy path* /
  *Download .glb* buttons.
- **Select multiple pieces** with the checkbox in a tile's top-left corner;
  shift-click extends the selection across whatever's currently visible. The
  bar at the bottom copies every selected path to the clipboard at once.
  Selection is keyed by file, not by tile: checking the same model in two
  tabs still yields one path.
- **Deep links** work: `#shapes` opens a tab, `#parts-cracked` jumps to a
  section.

## What's in the repo

```
index.html                  the page itself
catalog/catalog.css         styling
catalog/catalog.js          the catalog in the browser
catalog/catalog.json        generated; everything the page knows
models/*.glb                 the 287 models, as delivered except for §2 in PROVENANCE.md
textures/*.png               source textures for the models that were missing theirs
vendor/model-viewer.min.js   Google's <model-viewer> (BSD-3-Clause)
assemblies/placements.json  the pack's own prefabs as piece + transform lists
assemblies/*.glb             assemblies built from those lists
tools/build-catalog.mjs     builds catalog.json from models/
tools/assemble.mjs          builds an assembly GLB out of pieces in models/
tools/taxonomy.mjs          the classification: families, shapes, layers, sizes, assemblies
tools/glb.mjs                reading, writing, and measuring GLB files
tools/embed-textures.mjs    patches the models in textures/ back into models/
tools/png.mjs                just enough PNG decoding to average a texture's color
tools/textures.mjs          which material gets which texture file
PROVENANCE.md                where the pack comes from and what's wrong with it
```

## Assemblies

The pack doesn't only ship pieces; it ships arrangements of them — a cliff
run, a rope bridge over a river, a crack in a grass field. Those live in
`assemblies/placements.json` as a piece name and a transform per part, 123
of them, and `tools/assemble.mjs` turns one back into a single `.glb`:

```sh
node tools/assemble.mjs Path_Bridge_River_Wide Crack_Large
node tools/assemble.mjs --all --only-complete --out assemblies
```

Geometry is merged once per distinct piece and instanced from there, so the
nine wall segments of a cliff cost one copy of the wall and nine nodes.

Whatever ends up in `assemblies/` shows up in the catalog's **Assemblies**
tab on the next `node tools/build-catalog.mjs`, with the piece list it was
built from in the detail panel. All 123 are built and checked in, 4.1 MB
together, in five sections: 30 cliff runs, 51 waterfalls and cave entrances,
37 rivers, 3 bridges, 2 cracks.

Piece count says little about whether an assembly is worth building. The
river tiles place three pieces — a terrain block, a water surface, a bank —
and each is a finished tile; some of the waterfall components place two and
amount to a block with a separate sheet of water floating above it. Nineteen
place exactly one: prefabs that wrap a single model so other prefabs can
reuse it, kept here because they're part of what the pack ships.

109 of the 123 build with every piece present. The remaining 14 are the
waterfalls, which all reach for `Mist` and `Ripple` — particle effects that
were never models — or for a crest and river surface this repo doesn't
carry. They're built without those rather than skipped, and the detail panel
names what's missing.

**Coordinates.** The placements are Unity's: left-handed, one tile = 1.0.
The `.glb` files went through an FBX conversion that mirrored X and scaled a
tile to 100 units, so each placement is mirrored to match — position flips
its x, rotation flips its y and z. `--no-mirror` skips that step, which is
worth doing once on any assembly to see what it buys: the same pieces, laid
out inside out, overlapping by whole tiles.

## Rebuilding the catalog

```sh
node tools/build-catalog.mjs
```

Reads every `.glb` in `models/` and in `assemblies/`, measures it, derives
its place in the classification from its filename, and writes
`catalog/catalog.json` plus a fresh version hash into `index.html`. No
dependencies; Node 18 or newer.

The build doubles as its own check. It warns about models that land in no
tab, materials without a cleaned-up name, models that fall far outside their
named grid size, missing textures, and models above the triangle budget.

### Adjusting the classification

Everything the catalog "knows" about the kit lives in `tools/taxonomy.mjs`:
the families with their color, the shapes with their pattern, the layers,
the size groups, the assembly groups, the traits, and the tabs. One table
per facet, rules top to bottom, first match wins. A mis-classified model is
a one-line fix there; then run `node tools/build-catalog.mjs` again.

## What to watch out for

The pack arrived **with no license**, and the author is unknown. Don't
assume these models are free to use — see [PROVENANCE.md](PROVENANCE.md).

That file also covers what went sideways during the FBX conversion: 47
models referenced textures that weren't in the delivery, since fixed by
embedding the real ones (`tools/embed-textures.mjs`); a handful still don't
have one to embed, and PROVENANCE.md explains why that's expected rather
than left broken.

One grid cell is **100 units** in the source files; every dimension in the
catalog is expressed in grid cells.

## Publishing

`.github/workflows/static.yml` deploys the repo to GitHub Pages on every
push. Set **Settings → Pages → Source** to *GitHub Actions* first.
