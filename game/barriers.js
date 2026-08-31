import { Mesh, VertexData } from '../vendor/babylon/babylon.js';
import { Role } from './pieces.js';

/* Invisible walls, built so the navmesh stops where the kit means it to.
 *
 * Recast decides what is walkable from shape alone, and the kit's barriers are
 * the wrong shape to read as barriers. A fence is about 0.9 units tall, which
 * is *below* the 1.7 the character needs to stand up in but comfortably within
 * what Recast will treat as a low obstacle to step onto — so it paved the
 * fences and let you stroll along the top of them. Rivers fail the other way:
 * the water is a flat plane with ordinary ground modelled underneath, so the
 * navmesh simply ran along the riverbed.
 *
 * Both are fixed by handing Recast geometry that is unambiguously a wall: a
 * curtain of vertical quads, tall enough that it cannot be stepped over, and
 * with no horizontal face anywhere on it for a floor to form. Nothing here is
 * ever rendered.
 *
 * A curtain is drawn around a whole cell rather than along the fence line
 * itself. The kit is authored on this grid, so a barrier that occupies a cell
 * is meant to own it; following the geometry exactly would cost far more
 * triangles for a distinction under one cell wide.
 */

// Comfortably over the 1.7 units of headroom the character needs.
const WALL_HEIGHT = 2.6;
/* Water walls are kept lower than that. They only have to deny a floor at the
 * riverbed, and a taller one saws through the bridge decks passing overhead. */
const WATER_WALL_HEIGHT = 1.8;
// Dropped below the barrier's own base so it meets the ground it stands on.
const FOOTING = 0.6;
// Half-thickness floor, so a fence one polygon thick still fills a voxel.
const MIN_THICKNESS = 0.12;
/* Barriers are grown a little sideways. A fence is modelled a few centimetres
 * thick, and a wall that thin leaves gaps a path can thread between posts;
 * measured, un-grown barriers left 54% of fence cells crossable. */
const SPREAD = 0.22;

/**
 * Builds one invisible mesh of barrier walls from the terrain's cell census.
 *
 * Water is skipped wherever a bridge, dock or stair crosses the same cell —
 * otherwise the barrier that stops you swimming also stops you using the thing
 * built to carry you over.
 */
export function buildBarriers(cells, scene) {
  const positions = [];
  const indices = [];
  let water = 0;
  let blockers = 0;

  const curtain = (box, base, top) => {
    /* Thin footprints still have to rasterise into Recast's voxels, so a wall
     * is never allowed to be narrower than one of them. */
    const midX = (box.minX + box.maxX) / 2;
    const midZ = (box.minZ + box.maxZ) / 2;
    const halfX = Math.max((box.maxX - box.minX) / 2, MIN_THICKNESS) + SPREAD;
    const halfZ = Math.max((box.maxZ - box.minZ) / 2, MIN_THICKNESS) + SPREAD;

    // Four vertical quads, one per side. No lid: a lid would be a floor.
    const corners = [
      [midX - halfX, midZ - halfZ], [midX + halfX, midZ - halfZ],
      [midX + halfX, midZ + halfZ], [midX - halfX, midZ + halfZ],
    ];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i];
      const [bx, bz] = corners[(i + 1) % 4];
      const at = positions.length / 3;
      positions.push(ax, base, az, bx, base, bz, bx, top, bz, ax, top, az);
      // Both windings, so the wall reads as solid from either side.
      indices.push(at, at + 1, at + 2, at, at + 2, at + 3);
      indices.push(at, at + 2, at + 1, at, at + 3, at + 2);
    }
  };

  /* Where a bridge or a stair crosses water, the barrier that stops you
   * swimming must not also cut the thing built to carry you over — and a deck
   * lands on the bank, so its neighbours have to stay clear too. */
  const spanned = new Set();
  for (const [key, record] of cells) {
    if (!record[Role.SPAN]) continue;
    const [x, z] = key.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) spanned.add(`${x + dx},${z + dz}`);
    }
  }

  for (const [key, record] of cells) {
    /* A railing stands on the dock it guards and a retaining wall borders the
     * walkway on top of it, so a barrier raised inside a span's own cell walls
     * off the very surface it belongs to. Measured, that emptied every dock of
     * its decking; the deck edge does the guarding instead. */
    const barrier = record[Role.BLOCKER];
    if (barrier && !record[Role.SPAN]) {
      blockers++;
      curtain(barrier, barrier.low - FOOTING, Math.max(barrier.high, barrier.low + WALL_HEIGHT));
    }

    const river = record[Role.WATER];
    if (river && !spanned.has(key)) {
      water++;
      curtain(river, river.low - FOOTING, river.high + WATER_WALL_HEIGHT);
    }
  }

  if (!positions.length) return { mesh: null, stats: { water: 0, blockers: 0, triangles: 0 } };

  const data = new VertexData();
  data.positions = new Float32Array(positions);
  data.indices = new Uint32Array(indices);
  data.normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(data.positions, data.indices, data.normals);

  const mesh = new Mesh('barriers', scene);
  data.applyToMesh(mesh, false);
  mesh.isVisible = false;
  mesh.isPickable = false;
  mesh.metadata = { role: Role.BLOCKER };

  return {
    mesh,
    stats: { water, blockers, triangles: indices.length / 3 },
  };
}
