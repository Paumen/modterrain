import { RecastJSPlugin, Vector3, StandardMaterial, Color3 } from '../vendor/babylon/babylon.js';
import createRecast from '../vendor/babylon/recast.js';
import { isWalkableSurface } from './grid.js';

/* Navigation is a Recast navmesh rather than A* over the grid.
 *
 * The grid describes the world; it is a poor description of where a body can
 * walk, because 17.5% of its walkable cells carry more than one level. A
 * navmesh is built from the geometry itself, so caves, bridges and the beach
 * under a cliff are separate walkable surfaces without any special casing, and
 * the funnel algorithm gives paths that cut corners instead of stepping around
 * cell edges. Babylon ships the plugin, so this is the built-in road.
 *
 * The agent is a crowd agent for the same reason: it is constrained to the
 * navmesh by construction, which is where "collision detection" comes from
 * here — there is no surface off the mesh for it to reach.
 */

/* Tuned for a world where one unit is one grid cell, so roughly one metre.
 *
 * cs is the load-bearing one, and it is finer than it looks like it needs to
 * be. The kit's paths, stairs and ramps are a single cell wide, so a coarse
 * voxel grid rounds their connections away and the island falls into islands:
 * measured over the whole scene, cs 0.3 left the largest walkable region at
 * 79.3% of the navmesh in 15 pieces, and cs 0.2 lifts it to ~90% in 10. The
 * high plateau in the middle of the island is one of the pieces that
 * reconnects.
 *
 * Raising walkableClimb to 1.2 units buys the same connectivity for less
 * build time, and is the wrong trade: it reconnects the island by letting the
 * character walk up sheer 1-unit cliff faces.
 */
const CELL_SIZE = 0.2;
const CELL_HEIGHT = 0.2;

export const AGENT_RADIUS = 0.25;
export const AGENT_HEIGHT = 1.7;

// How close a path's far end must land to count as having reached its target.
const ARRIVAL = 1.5;

export const NAVMESH_PARAMETERS = {
  cs: CELL_SIZE,
  ch: CELL_HEIGHT,
  walkableSlopeAngle: 45,
  walkableHeight: Math.ceil(AGENT_HEIGHT / CELL_HEIGHT),
  // Half a unit: the kit's steps and ramps are climbable, its 1-unit cliffs are not.
  walkableClimb: Math.ceil(0.5 / CELL_HEIGHT),
  walkableRadius: Math.ceil(AGENT_RADIUS / CELL_SIZE),
  maxEdgeLen: 12,
  maxSimplificationError: 1.3,
  minRegionArea: 8,
  mergeRegionArea: 20,
  maxVertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
};

export class Navigation {
  constructor(plugin, scene, stats) {
    this.plugin = plugin;
    this.scene = scene;
    this.stats = stats;
    this.crowd = null;
    this.agent = -1;
  }

  /** Nearest point actually on the navmesh, or null when nothing is near. */
  nearestPoint(point, reach = 4) {
    this.plugin.setDefaultQueryExtent(new Vector3(reach, reach * 2, reach));
    const found = this.plugin.getClosestPoint(point);
    // Recast returns the origin when it finds nothing within the query extent.
    if (found.x === 0 && found.y === 0 && found.z === 0) return null;
    return found;
  }

  computePath(from, to) {
    return this.plugin.computePath(from, to);
  }

  /** Whether a path from one point actually arrives at the other. */
  reaches(from, to) {
    const path = this.computePath(from, to);
    if (!path?.length) return false;
    const end = path[path.length - 1];
    return Math.hypot(end.x - to.x, end.y - to.y, end.z - to.z) < ARRIVAL;
  }

  /**
   * The most connected place to stand, given some candidate points.
   *
   * A navmesh is not one surface. Cliffs, water and drops cut this island into
   * about ten separate stretches of walkable ground, and a path between two of
   * them does not exist — so a character dropped on a small one is stuck on it
   * however good the pathfinding is. This groups the candidates by what can
   * reach what, then returns the member of the biggest group nearest that
   * group's middle.
   *
   * Cost is a path query per candidate pair only until a group claims its
   * members, so it is roughly candidates x groups, not candidates squared.
   */
  findOpenSpace(candidates) {
    const points = [];
    for (const candidate of candidates) {
      const on = this.nearestPoint(candidate, 2);
      if (on) points.push(on);
    }
    if (!points.length) return null;

    const claimed = new Uint8Array(points.length);
    let best = null;
    let groups = 0;

    for (let i = 0; i < points.length; i++) {
      if (claimed[i]) continue;
      groups++;
      claimed[i] = 1;
      const members = [points[i]];
      for (let j = i + 1; j < points.length; j++) {
        if (claimed[j]) continue;
        if (this.reaches(points[i], points[j])) {
          claimed[j] = 1;
          members.push(points[j]);
        }
      }
      if (!best || members.length > best.members.length) best = { members };
    }

    // Stand near the middle of that group rather than on whichever member
    // happened to seed it, which is otherwise an arbitrary edge of the island.
    const middle = best.members.reduce(
      (sum, p) => ({ x: sum.x + p.x / best.members.length, y: sum.y + p.y / best.members.length, z: sum.z + p.z / best.members.length }),
      { x: 0, y: 0, z: 0 },
    );
    let chosen = best.members[0];
    let nearest = Infinity;
    for (const point of best.members) {
      const distance = Math.hypot(point.x - middle.x, point.y - middle.y, point.z - middle.z);
      if (distance < nearest) { nearest = distance; chosen = point; }
    }

    return { point: chosen, reachable: best.members.length, sampled: points.length, groups };
  }

  attachAgent(transform, { speed = 4.5 } = {}) {
    this.crowd = this.plugin.createCrowd(1, AGENT_RADIUS, this.scene);
    this.agent = this.crowd.addAgent(transform.position.clone(), {
      radius: AGENT_RADIUS,
      height: AGENT_HEIGHT,
      maxAcceleration: 24,
      maxSpeed: speed,
      collisionQueryRange: AGENT_RADIUS * 4,
      pathOptimizationRange: AGENT_RADIUS * 12,
      separationWeight: 1,
    }, transform);
    return this.agent;
  }

  goTo(point) {
    if (this.agent === -1) return false;
    const target = this.nearestPoint(point);
    if (!target) return false;
    this.crowd.agentGoto(this.agent, target);
    return true;
  }

  get agentVelocity() {
    return this.agent === -1 ? Vector3.Zero() : this.crowd.getAgentVelocity(this.agent);
  }

  createDebugMesh(scene) {
    const mesh = this.plugin.createDebugNavMesh(scene);
    mesh.name = 'navmesh-debug';
    mesh.isPickable = false;
    // The plugin hands back bare geometry, so it arrives with no material.
    const material = new StandardMaterial('navmesh-debug', scene);
    material.diffuseColor = new Color3(0.2, 0.75, 1);
    material.emissiveColor = new Color3(0.05, 0.25, 0.4);
    material.specularColor = Color3.Black();
    material.alpha = 0.5;
    material.backFaceCulling = false;
    mesh.material = material;
    // Lift it clear of the ground it was built from, or the two z-fight.
    mesh.position.y += 0.08;
    return mesh;
  }
}

/**
 * Builds the navmesh from the terrain.
 *
 * Only the surfaces a body could stand on are fed in. Water is left out so
 * rivers stay barriers to be bridged rather than walked across, and the rope
 * railings are left out because 23,088 triangles of hanging cord voxelise into
 * noise. That also keeps the build well under a second.
 */
export async function buildNavigation(scene, meshes, { onProgress, parameters } = {}) {
  const started = performance.now();

  onProgress?.('navigation', 0.9);
  const recast = await createRecast();
  const ready = performance.now();

  const plugin = new RecastJSPlugin(recast);
  const solid = meshes.filter((mesh) => isWalkableSurface(mesh.name));
  plugin.createNavMesh(solid, { ...NAVMESH_PARAMETERS, ...parameters });

  return new Navigation(plugin, scene, {
    inputMeshes: solid.length,
    wasmMs: Math.round(ready - started),
    buildMs: Math.round(performance.now() - ready),
  });
}
