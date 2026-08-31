import { Mesh, VertexData, StandardMaterial, Color3 } from '../vendor/babylon/babylon.js';

/* The 1x1 world grid.
 *
 * The scene is already drawn on this grid: in this file one world unit is one
 * cell (the atoms store 100 units to a cell and the node matrices scale by
 * 100), piece origins land on cell centres, and stretched pieces are always
 * scaled by whole multiples of a cell. So the grid is not imposed on the
 * terrain, it is read back off it.
 *
 * What it is not is a heightfield. Measured over this scene, 2,161 of the
 * 12,354 walkable cells — 17.5% — carry more than one walkable surface, up to
 * six: caves, bridges, tiered terrain, beach running under a cliff. Each cell
 * therefore holds a *list* of levels rather than one height. Surfaces also sit
 * at quarter-unit heights, not whole ones, because grass and sand tiles are
 * 0.25 thick, so a level's height is a float and never an integer step.
 *
 * Levels are stored CSR-style — one flat array of levels plus per-cell start
 * offsets — so a lookup is two array reads and the whole grid is three typed
 * arrays rather than 21,330 small objects.
 */

export const Surface = {
  NONE: 0, GRASS: 1, SAND: 2, STONE: 3, WOOD: 4, ROCK: 5, METAL: 6,
};

const SURFACE_OF = new Map([
  ['Grass', Surface.GRASS],
  ['Dirt', Surface.SAND],
  ['Carved Stone Walkway', Surface.STONE],
  ['Carved Stone 1', Surface.STONE],
  ['Carved Stone 2', Surface.STONE],
  ['Carved Stone 3', Surface.STONE],
  ['Wood Light', Surface.WOOD],
  ['Wood Light End', Surface.WOOD],
  ['Wood Dark', Surface.WOOD],
  ['Wood Medium', Surface.WOOD],
  ['Cliff', Surface.ROCK],
  ['Metal Iron', Surface.METAL],
]);

export const SURFACE_COLOUR = {
  [Surface.GRASS]: [0.35, 0.62, 0.28],
  [Surface.SAND]: [0.78, 0.62, 0.38],
  [Surface.STONE]: [0.62, 0.60, 0.57],
  [Surface.WOOD]: [0.60, 0.42, 0.24],
  [Surface.ROCK]: [0.45, 0.38, 0.32],
  [Surface.METAL]: [0.40, 0.42, 0.46],
};

/* Two surfaces closer together than this are the same floor sampled twice, not
 * a floor and the ceiling below it. A quarter-unit tile plus its ramp fits
 * inside it; the kit's shortest real stack — a Mid layer on a Base — does not. */
const LEVEL_GAP = 0.6;

// Matches the navmesh's walkableSlopeAngle so the two agree about what is floor.
export const WALKABLE_SLOPE = Math.cos((45 * Math.PI) / 180);

export function isWalkableSurface(material) {
  return SURFACE_OF.has(material);
}

export class Grid {
  constructor({ originX, originZ, width, depth, cellStart, levelY, levelSurface, stats }) {
    this.originX = originX;
    this.originZ = originZ;
    this.width = width;
    this.depth = depth;
    this.cellStart = cellStart;
    this.levelY = levelY;
    this.levelSurface = levelSurface;
    this.stats = stats;
  }

  /** Cell index for a world point, or -1 when it falls outside the grid. */
  cellAt(x, z) {
    const cx = Math.floor(x - this.originX);
    const cz = Math.floor(z - this.originZ);
    if (cx < 0 || cz < 0 || cx >= this.width || cz >= this.depth) return -1;
    return cz * this.width + cx;
  }

  cellCentre(cell) {
    return {
      x: this.originX + (cell % this.width) + 0.5,
      z: this.originZ + Math.floor(cell / this.width) + 0.5,
    };
  }

  levelCount(cell) {
    return cell < 0 ? 0 : this.cellStart[cell + 1] - this.cellStart[cell];
  }

  /**
   * The surface a body at `nearY` is standing on: the closest level at or below
   * it, falling back to the lowest level above when it is under the floor.
   * Pass no `nearY` to get the topmost level, which is what a camera or a
   * top-down query wants.
   */
  levelIndexAt(x, z, nearY) {
    const cell = this.cellAt(x, z);
    const from = cell < 0 ? 0 : this.cellStart[cell];
    const to = cell < 0 ? 0 : this.cellStart[cell + 1];
    if (from === to) return -1;
    if (nearY === undefined) return to - 1;

    let best = -1;
    for (let i = from; i < to; i++) {
      if (this.levelY[i] <= nearY + LEVEL_GAP) best = i;
      else break; // levels are sorted low to high
    }
    return best === -1 ? from : best;
  }

  /** Ground height under a world point, or null where there is no ground. */
  groundAt(x, z, nearY) {
    const index = this.levelIndexAt(x, z, nearY);
    return index === -1 ? null : this.levelY[index];
  }

  surfaceAt(x, z, nearY) {
    const index = this.levelIndexAt(x, z, nearY);
    return index === -1 ? Surface.NONE : this.levelSurface[index];
  }

  isWalkable(x, z) {
    return this.cellAt(x, z) !== -1 && this.levelCount(this.cellAt(x, z)) > 0;
  }

  /**
   * One flat quad per cell level, coloured by surface. Purely a debug view of
   * what the grid believes, so it is built on demand and never during startup.
   */
  createDebugMesh(scene) {
    const positions = [];
    const indices = [];
    const colours = [];
    const inset = 0.06;

    for (let cell = 0; cell < this.width * this.depth; cell++) {
      const { x, z } = this.cellCentre(cell);
      for (let i = this.cellStart[cell]; i < this.cellStart[cell + 1]; i++) {
        const y = this.levelY[i] + 0.02;
        const base = positions.length / 3;
        const half = 0.5 - inset;
        positions.push(x - half, y, z - half, x + half, y, z - half, x + half, y, z + half, x - half, y, z + half);
        const [r, g, b] = SURFACE_COLOUR[this.levelSurface[i]] ?? [1, 0, 1];
        for (let k = 0; k < 4; k++) colours.push(r, g, b, 0.75);
        indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }
    }

    const data = new VertexData();
    data.positions = new Float32Array(positions);
    data.indices = new Uint32Array(indices);
    data.colors = new Float32Array(colours);
    data.normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(data.positions, data.indices, data.normals);

    const mesh = new Mesh('grid-debug', scene);
    data.applyToMesh(mesh, false);
    const material = new StandardMaterial('grid-debug', scene);
    material.diffuseColor = Color3.White();
    material.emissiveColor = new Color3(0.25, 0.25, 0.25);
    material.specularColor = Color3.Black();
    // A debug overlay is worth seeing from underneath too, and culling flat
    // quads saves nothing worth the risk of getting the winding backwards.
    material.backFaceCulling = false;
    material.alpha = 0.75;
    mesh.material = material;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    return mesh;
  }
}

// ------------------------------------------------------------------ building

/**
 * Rasterises the walkable surfaces of `meshes` into the grid.
 *
 * A cell takes its height from a triangle only where the triangle covers the
 * cell's *centre*. Partial cover would let a cliff face's topmost sliver claim
 * a cell the character can never stand in; the centre is the point the grid
 * actually represents.
 */
export function buildGrid(meshes, bounds) {
  const started = performance.now();

  const originX = Math.floor(bounds.min[0]);
  const originZ = Math.floor(bounds.min[2]);
  const width = Math.ceil(bounds.max[0]) - originX;
  const depth = Math.ceil(bounds.max[2]) - originZ;
  const cells = width * depth;

  const counts = new Int32Array(cells + 1);
  const samples = []; // [cell, y, surface] triples, flat

  for (const mesh of meshes) {
    const surface = SURFACE_OF.get(mesh.name);
    if (surface === undefined) continue;

    const positions = mesh.getVerticesData('position');
    const indices = mesh.getIndices();
    if (!positions || !indices) continue;

    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
      const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
      const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
      const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];

      /* Winding was flipped on the way in to match Babylon's front face, so the
       * cross product is taken the other way round to get an outward normal. */
      const ux = cx - ax, uy = cy - ay, uz = cz - az;
      const vx = bx - ax, vy = by - ay, vz = bz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz);
      if (!length) continue;
      nx /= length; ny /= length; nz /= length;
      if (ny < WALKABLE_SLOPE) continue;

      const minX = Math.floor(Math.min(ax, bx, cx) - originX);
      const maxX = Math.floor(Math.max(ax, bx, cx) - originX);
      const minZ = Math.floor(Math.min(az, bz, cz) - originZ);
      const maxZ = Math.floor(Math.max(az, bz, cz) - originZ);
      const plane = nx * ax + ny * ay + nz * az;

      for (let gx = Math.max(0, minX); gx <= Math.min(width - 1, maxX); gx++) {
        for (let gz = Math.max(0, minZ); gz <= Math.min(depth - 1, maxZ); gz++) {
          const px = originX + gx + 0.5;
          const pz = originZ + gz + 0.5;

          /* Same-sign edge test, so a centre exactly on a shared edge lands in
           * both cells rather than falling through the crack between them. */
          const d1 = (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
          const d2 = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz);
          const d3 = (px - ax) * (cz - az) - (cx - ax) * (pz - az);
          if ((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)) continue;

          const cell = gz * width + gx;
          counts[cell]++;
          samples.push(cell, (plane - nx * px - nz * pz) / ny, surface);
        }
      }
    }
  }

  // Bucket the samples per cell, then collapse each cell's samples into levels.
  const start = new Int32Array(cells + 1);
  for (let i = 0; i < cells; i++) start[i + 1] = start[i] + counts[i];
  const cursor = start.slice(0, cells);
  const sampleY = new Float32Array(samples.length / 3);
  const sampleSurface = new Uint8Array(samples.length / 3);
  for (let i = 0; i < samples.length; i += 3) {
    const at = cursor[samples[i]]++;
    sampleY[at] = samples[i + 1];
    sampleSurface[at] = samples[i + 2];
  }

  const cellStart = new Int32Array(cells + 1);
  const levelY = new Float32Array(sampleY.length);
  const levelSurface = new Uint8Array(sampleY.length);
  const order = [];
  let levels = 0;
  let multiLevel = 0;
  let walkable = 0;

  for (let cell = 0; cell < cells; cell++) {
    cellStart[cell] = levels;
    const from = start[cell];
    const to = start[cell + 1];
    if (from === to) continue;

    order.length = 0;
    for (let i = from; i < to; i++) order.push(i);
    order.sort((a, b) => sampleY[a] - sampleY[b]);

    const before = levels;
    for (const i of order) {
      /* Keep the highest sample of a run and the surface that came with it:
       * where a path tile sits on grass, the path is what you walk on. */
      if (levels > before && sampleY[i] - levelY[levels - 1] <= LEVEL_GAP) {
        levelY[levels - 1] = sampleY[i];
        levelSurface[levels - 1] = sampleSurface[i];
      } else {
        levelY[levels] = sampleY[i];
        levelSurface[levels] = sampleSurface[i];
        levels++;
      }
    }
    walkable++;
    if (levels - before > 1) multiLevel++;
  }
  cellStart[cells] = levels;

  return new Grid({
    originX, originZ, width, depth,
    cellStart,
    levelY: levelY.subarray(0, levels),
    levelSurface: levelSurface.subarray(0, levels),
    stats: {
      cells,
      walkableCells: walkable,
      levels,
      multiLevelCells: multiLevel,
      buildMs: Math.round(performance.now() - started),
    },
  });
}
