# Island

The Large Island scene running as the foundation of a 3D game: Babylon.js on
WebGPU, a 1×1 world grid, a Recast navmesh, and a camera meant for one thumb.

Open `/game/` — it needs no build step. `tools/bundle-babylon.mjs` rebuilds
`vendor/babylon/` when the pinned engine versions change.

## What the scene actually is

Worth knowing before changing anything here, because most of the design follows
from it.

`scenes/Large_Island_v2_No_Ocean_No_Props.glb` is 6.09 MB on disk but **580 KB
gzipped** — 5.3 MB of it is JSON describing 12,430 nodes, and that repetitive
text compresses about 10:1. Only 797 KB is geometry, because the scene is
instanced: 241 distinct kit pieces placed 3,827 times over 304 shared position
accessors. It carries positions and nothing else — no normals, no UVs, no
textures — and 25 materials with flat colours. It came out of trimesh, so it is
a rawer export than the recoloured pieces in `atoms/`, which do have normals,
UVs and the shared colormap.

**One world unit is one grid cell.** The atoms store 100 units to a cell and
this scene's node matrices scale by 100, so world space comes out in cells
already. The island spans 157 × 134 cells and about 19 units of height. Piece
origins land on cell centres — roughly 90% of node translations have a
fractional part of exactly 0.5 — and stretched pieces are scaled by whole
multiples of a cell. The grid is read off the terrain, not imposed on it.

**It is not a heightfield.** 2,161 of the 12,354 walkable cells — 17.5% — carry
more than one walkable surface, up to six: caves, bridges, tiered terrain, beach
running under a cliff. Surfaces also sit at quarter-unit heights rather than
whole ones, because grass and sand tiles are 0.25 thick.

## The modules

| file | what it does |
| --- | --- |
| `terrain.js` | Reads the GLB and merges it into one mesh per material |
| `grid.js` | The 1×1 world grid: ground height, surface type, multi-level cells |
| `navigation.js` | Recast navmesh, pathfinding, and the crowd agent |
| `camera.js` | ArcRotateCamera rig where elevation is a function of zoom |
| `input.js` | Tap / horizontal swipe / vertical swipe, told apart |
| `character.js` | The placeholder body and the destination marker |
| `main.js` | Bootstrap, wiring, and the heads-up display |

## Two places this leaves the Babylon path, and why

Everything else — camera, picking, materials, navmesh, crowd steering — is
Babylon's own.

**Reading the GLB directly instead of `SceneLoader`.** Measured on this scene:

| | loader + `MergeMeshes` | `terrain.js` |
| --- | --- | --- |
| load | 1519 ms | ~220 ms |
| merge | 499 ms | included |
| draw calls | 12,430 | 17 |
| vertices | 1,047,092 | 188,839 |
| frame | 43 ms | 0.35 ms |

The loader faithfully builds 12,430 `Mesh` objects — every one a draw call — and
merging afterwards keeps every vertex, including the ones no index references.
Going straight from the buffer to merged meshes skips both costs. It is only
affordable because the file is so plain; `terrain.js` throws rather than guess
if it ever meets textures, skins, animations or extensions.

**Damping the camera towards a target instead of using `inertialAlphaOffset`.**
Those offsets are a velocity Babylon re-applies every frame until it decays, so
a drag lands about `1/(1 - inertia)` times further than the finger travelled — a
measured 14 radians of orbit for a 220 px swipe. A touch camera has to track the
finger, so the finger sets a target and the damping only smooths the approach.

## Gotchas that cost real time

- **The scene must be right-handed and the winding flipped.** `terrain.js` emits
  each triangle as `0, 2, 1`. Babylon reads these coordinates as right-handed
  but keeps its own front-face convention, so copying the file's winding culls
  exactly the faces meant to be seen and the kit's one-sided shells render
  inside-out — as a pale grey blob.
- **The `Hidden*` socket materials are dropped.** They are 56,635 of the
  scene's 190,412 triangles and, once winding is right, contribute nothing:
  rendering with and without them gives the same picture.
- **All 25 materials are marked `doubleSided`,** which is an artefact of the
  trimesh export. `CLAUDE.md` is explicit that every surface is single-sided, so
  culling is forced on — which also halves the fragment work.
- **`recast.js` is wrapped at build time.** The Emscripten bundle finds its
  `.wasm` through `document.currentScript`, which is `null` for an ES module,
  and ends with `this["Recast"] = Module`, which throws in a module's strict
  `this`. The wrapper supplies `locateFile` and calls it with an explicit
  `globalThis`.

## What is not done yet

- Performance has only been measured under software rendering (no GPU in the
  build container), so the frame numbers above are CPU-side. WebGPU falls back
  to WebGL2 cleanly, but the WebGPU path itself is unverified on real hardware.
- Nothing casts shadows, and the cliff faces are one flat colour — this scene
  carries none of the height shading the recoloured `atoms/` have.
- The character is a capsule, and there is one of it. The crowd is sized for a
  single agent.
