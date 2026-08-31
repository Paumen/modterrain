import { MeshBuilder, StandardMaterial, Color3, TransformNode, Scalar } from '../vendor/babylon/babylon.js';
import { AGENT_HEIGHT, AGENT_RADIUS } from './navigation.js';

/* The character is a placeholder body on a navmesh crowd agent.
 *
 * The agent owns the position: Babylon's crowd writes it into `root` every
 * frame, steering along the path and slowing into the destination on its own.
 * Nothing here integrates velocity or resolves collisions, because the agent
 * cannot leave the navmesh in the first place.
 */

export function createCharacter(scene, position) {
  const root = new TransformNode('character', scene);
  root.position.copyFrom(position);

  const body = MeshBuilder.CreateCapsule('character-body', {
    height: AGENT_HEIGHT,
    radius: AGENT_RADIUS,
    tessellation: 12,
    capSubdivisions: 4,
  }, scene);
  body.parent = root;
  body.position.y = AGENT_HEIGHT / 2; // the agent stands on its feet, not its middle
  body.isPickable = false;

  const material = new StandardMaterial('character', scene);
  material.diffuseColor = new Color3(0.92, 0.36, 0.26);
  material.specularColor = new Color3(0.1, 0.1, 0.1);
  body.material = material;

  // A nose, so which way the character faces is readable at any zoom.
  const nose = MeshBuilder.CreateCylinder('character-nose', {
    height: AGENT_RADIUS * 1.5,
    diameterTop: 0,
    diameterBottom: AGENT_RADIUS * 1.1,
    tessellation: 10,
  }, scene);
  nose.parent = body;
  nose.rotation.x = Math.PI / 2;
  // Far enough forward to clear the capsule it is parented to, or it is buried.
  nose.position.z = AGENT_RADIUS * 1.35;
  nose.position.y = AGENT_HEIGHT * 0.2;
  nose.isPickable = false;
  const noseMaterial = new StandardMaterial('character-nose', scene);
  noseMaterial.diffuseColor = new Color3(1, 0.86, 0.55);
  noseMaterial.specularColor = Color3.Black();
  nose.material = noseMaterial;

  let facing = 0;

  return {
    root,
    body,

    /** Turn towards travel. Below a crawl the agent's heading is just noise. */
    faceVelocity(velocity, deltaSeconds) {
      if (velocity.lengthSquared() < 0.04) return;
      const wanted = Math.atan2(velocity.x, velocity.z);
      let delta = wanted - facing;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      facing += delta * Scalar.Clamp(deltaSeconds * 10, 0, 1);
      body.rotation.y = facing;
    },
  };
}

/** A ring that blinks at the point the character was sent to. */
export function createDestinationMarker(scene) {
  const marker = MeshBuilder.CreateTorus('destination', {
    diameter: 1.5,
    thickness: 0.16,
    tessellation: 24,
  }, scene);
  const material = new StandardMaterial('destination', scene);
  material.diffuseColor = new Color3(1, 0.92, 0.4);
  material.emissiveColor = new Color3(0.5, 0.42, 0.05);
  material.specularColor = Color3.Black();
  marker.material = material;
  marker.isPickable = false;
  marker.setEnabled(false);

  let shownAt = 0;

  return {
    show(point) {
      marker.position.copyFrom(point);
      marker.position.y += 0.12;
      marker.setEnabled(true);
      shownAt = performance.now();
    },
    update() {
      if (!marker.isEnabled()) return;
      const age = (performance.now() - shownAt) / 1000;
      if (age > 1.4) { marker.setEnabled(false); return; }
      const pulse = 1 + Math.sin(age * 9) * 0.12;
      marker.scaling.set(pulse, 1, pulse);
    },
  };
}
