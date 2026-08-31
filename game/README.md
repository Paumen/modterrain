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

## The navmesh is not one surface

Cliffs and water cut this island into separate stretches of walkable ground,
and there is no path between two of them. That makes *where the character
starts* a real decision rather than a cosmetic one.

Opening on the cell nearest the middle of the map put the character on a high
plateau holding **4% of the island**, with no way down. `main.js` now samples
open ground on a lattice, hands it to `navigation.findOpenSpace()`, and starts
on the biggest connected group — about **90%**. The panel reports the figure,
so a scene that fragments badly says so instead of quietly stranding you.

The navmesh's `cs` matters more than it looks for the same reason. The kit's
paths, stairs and ramps are a single cell wide, and a coarse voxel grid rounds
their connections away:

| `cs` | largest region | pieces |
| --- | --- | --- |
| 0.3 | 79.3% | 15 |
| 0.2 | 89.8% | 14 |

Raising `walkableClimb` to 1.2 units buys the same connectivity for less build
time and is the wrong trade — it reconnects the island by letting the character
walk up sheer 1-unit cliff faces.

## Walkable is a property of the piece, not the material

The kit's meaning lives in the piece name. "Wood Light" is a bridge deck *and*
a fence rail; "Carved Stone 1" is a walkway *and* a retaining wall. Deciding
navigation from the material therefore paved every fence: 91% of fence cells
were walkable. `pieces.js` gives each piece a role instead, and `terrain.js`
buckets geometry by material *and* role so the two can be told apart.

Roles alone are not enough, because Recast judges by shape. A fence is about
0.9 units tall, which is under the 1.7 the character needs but well within what
Recast treats as a low obstacle to step onto — so it paved the fences anyway.
Rivers fail the other way: the water is a flat plane with ordinary ground
modelled beneath it, so the navmesh ran along the riverbed. `barriers.js` gives
Recast what it needs to see: invisible curtains of vertical quads, too tall to
step over and with no horizontal face for a floor to form on.

`tools/audit-navigation.mjs` keeps score. It reads the piece names out of the
GLB, turns them into per-cell expectations, drives the real page and asks the
real navmesh whether it agrees:

```
node tools/audit-navigation.mjs
```

For a barrier it asks whether a route *passes through* it, not whether it
occupies a cell — a fence sits on a cell edge and the ground beside it is meant
to be walkable. That distinction matters: an occupancy test called correct
fences broken.

## Gotchas that cost real time

- **The scene must be right-handed and the winding flipped.** `terrain.js` emits
  each triangle as `0, 2, 1`. Babylon reads these coordinates as right-handed
  but keeps its own front-face convention, so copying the file's winding culls
  exactly the faces meant to be seen and the kit's one-sided shells render
  inside-out — as a pale grey blob.
- **The camera needs keeping out of the scenery.** Every surface is a
  one-sided shell, so a camera inside a hill does not go dark — it sees out
  through the hillside, which reads as the inside of the mountain. `camera.js`
  walks its own sight line against the grid and, where the ground is in the
  way, *lifts* the camera over it. Pulling in alone is not enough: against a
  cliff even the closest the camera may sit is still inside the rock. Over a
  slow orbit at closest zoom, terrain stood between camera and character in
  24 of 24 frames before, and 0 of 24 after.
- **Aim at the chest, not the feet.** The camera follows the character's
  position, which is the point it stands on. At arm's length that is nothing;
  pulled in tight to a 1.7-unit body it frames the feet and puts the head off
  the top of the screen. Measured, the character was off-screen in 42% of
  frames at middle zoom; with the focus lifted, 0%.
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
