# Modular Terrain — 3D Catalog

A browsable catalog of 287 models from a modular terrain pack: cliffs,
walls, cracked cliffs, terrain paths, grass, sand, water, a cave, and
standalone props. Everything runs in the browser, no build step and no
server — opening `index.html` is enough.

The pack arrived with zero metadata, so the entire classification is derived
from filenames.

## Using the catalog

**Four tabs** each look at the same 287 models differently:

| Tab | Groups by | For |
| --- | --- | --- |
| Parts | family | "show me all the cracked cliffs" |
| Shapes | inner curve, outer curve, s-curve, straight, incline… | "which pieces complete this curve?" |
| Layers | under, base, mid, top | "what stacks onto this row?" |
| Sizes | grid footprint from the name | "what fits this 3 × 3 gap?" |

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
index.html                 the page itself
catalog/catalog.css        styling
catalog/catalog.js         the catalog in the browser
catalog/catalog.json       generated; everything the page knows
models/*.glb                the 287 models, unchanged as delivered
vendor/model-viewer.min.js  Google's <model-viewer> (BSD-3-Clause)
tools/build-catalog.mjs    builds catalog.json from models/
tools/taxonomy.mjs         the classification: families, shapes, layers, sizes
tools/glb.mjs               reading and measuring GLB files
PROVENANCE.md               where the pack comes from and what's wrong with it
```

## Rebuilding the catalog

```sh
node tools/build-catalog.mjs
```

Reads every `.glb` in `models/`, measures it, derives its place in the
classification from its filename, and writes `catalog/catalog.json` plus a
fresh version hash into `index.html`. No dependencies; Node 18 or newer.

The build doubles as its own check. It warns about models that land in no
tab, materials without a cleaned-up name, models that fall far outside their
named grid size, missing textures, and models above the triangle budget.

### Adjusting the classification

Everything the catalog "knows" about the kit lives in `tools/taxonomy.mjs`:
the families with their color, the shapes with their pattern, the layers,
the size groups, the traits, and the tabs. One table per facet, rules
top to bottom, first match wins. A mis-classified model is a one-line fix
there; then run `node tools/build-catalog.mjs` again.

## What to watch out for

The pack arrived **with no license**, and the author is unknown. Don't
assume these models are free to use — see [PROVENANCE.md](PROVENANCE.md).

That file also covers what went sideways during the FBX conversion: the
material colors are in the wrong color space (the catalog corrects them at
display time; the files stay as delivered), and 67 models reference
textures that aren't in the pack.

One grid cell is **100 units** in the source files; every dimension in the
catalog is expressed in grid cells.

## Publishing

`.github/workflows/static.yml` deploys the repo to GitHub Pages on every
push. Set **Settings → Pages → Source** to *GitHub Actions* first.
