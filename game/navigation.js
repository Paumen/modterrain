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
 * walkableRadius is the load-bearing one. It erodes the walkable area away
 * from every edge, and the kit's paths are a single cell wide: at cs 0.3 a
 * radius of 1 voxel leaves 0.4 units of a 1-unit path walkable, while 2 voxels
 * erodes the path out of existence entirely.
 */
const CELL_SIZE = 0.3;
const CELL_HEIGHT = 0.2;

export const AGENT_RADIUS = 0.3;
export const AGENT_HEIGHT = 1.7;

const NAVMESH_PARAMETERS = {
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
export async function buildNavigation(scene, meshes, { onProgress } = {}) {
  const started = performance.now();

  onProgress?.('navigation', 0.9);
  const recast = await createRecast();
  const ready = performance.now();

  const plugin = new RecastJSPlugin(recast);
  const solid = meshes.filter((mesh) => isWalkableSurface(mesh.name));
  plugin.createNavMesh(solid, NAVMESH_PARAMETERS);

  return new Navigation(plugin, scene, {
    inputMeshes: solid.length,
    wasmMs: Math.round(ready - started),
    buildMs: Math.round(performance.now() - ready),
  });
}
