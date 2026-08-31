import {
  Engine, WebGPUEngine, Scene, HemisphericLight, DirectionalLight,
  Vector3, Color3, Color4,
} from '../vendor/babylon/babylon.js';
import { loadTerrain } from './terrain.js';
import { buildGrid, Surface } from './grid.js';
import { buildNavigation } from './navigation.js';
import { CameraRig } from './camera.js';
import { attachInput } from './input.js';
import { createCharacter, createDestinationMarker } from './character.js';

const SCENE_URL = '../scenes/Large_Island_v2_No_Ocean_No_Props.glb';

const SURFACE_NAME = {
  [Surface.NONE]: 'nothing',
  [Surface.GRASS]: 'grass',
  [Surface.SAND]: 'sand',
  [Surface.STONE]: 'stone',
  [Surface.WOOD]: 'wood',
  [Surface.ROCK]: 'rock',
  [Surface.METAL]: 'iron',
};

const ui = {
  canvas: document.getElementById('view'),
  loader: document.getElementById('loader'),
  loaderStage: document.getElementById('loader-stage'),
  loaderBar: document.getElementById('loader-bar'),
  loaderError: document.getElementById('loader-error'),
  panel: document.getElementById('panel'),
  panelToggle: document.getElementById('panel-toggle'),
  stats: document.getElementById('stats'),
  readout: document.getElementById('readout'),
  gridToggle: document.getElementById('toggle-grid'),
  navToggle: document.getElementById('toggle-nav'),
};

const progress = (stage, fraction) => {
  ui.loaderStage.textContent = stage;
  ui.loaderBar.style.setProperty('--progress', `${Math.round(fraction * 100)}%`);
};

// ------------------------------------------------------------------- engine

async function createEngine(canvas) {
  if (navigator.gpu) {
    try {
      const engine = new WebGPUEngine(canvas, { antialias: true, stencil: false });
      await engine.initAsync();
      return { engine, api: 'WebGPU' };
    } catch (error) {
      // Reported, not swallowed: a WebGPU adapter that exists but fails to
      // start is worth knowing about even though the page carries on.
      console.warn('WebGPU unavailable, falling back to WebGL2:', error);
    }
  }
  return {
    engine: new Engine(canvas, true, { stencil: false, preserveDrawingBuffer: false }),
    api: 'WebGL2',
  };
}

// -------------------------------------------------------------- start point

/* Somewhere to open the game: open ground spread evenly over the island, for
 * the navmesh to sort into connected stretches. Sampled on a lattice so the
 * candidates cover the whole map rather than clustering on the biggest beach. */
const START_CANDIDATES = 72;

function startCandidates(grid) {
  const stride = Math.max(1, Math.round(Math.sqrt((grid.width * grid.depth) / START_CANDIDATES)));
  const candidates = [];

  for (let gz = Math.floor(stride / 2); gz < grid.depth; gz += stride) {
    for (let gx = Math.floor(stride / 2); gx < grid.width; gx += stride) {
      const cell = gz * grid.width + gx;
      const top = grid.cellStart[cell + 1] - 1;
      if (top < grid.cellStart[cell]) continue;
      // Grass and sand are open ground; stone and wood are narrow paths and docks.
      const surface = grid.levelSurface[top];
      if (surface !== Surface.GRASS && surface !== Surface.SAND) continue;

      const { x, z } = grid.cellCentre(cell);
      candidates.push(new Vector3(x, grid.levelY[top], z));
    }
  }
  return candidates;
}

// ---------------------------------------------------------------- bootstrap

async function start() {
  const { engine, api } = await createEngine(ui.canvas);

  /* Phones report devicePixelRatio of 3 and up. Rendering the full island at
   * 3x costs three times the fragments for a difference nobody can see at
   * arm's length, so the backbuffer is capped at 2x. */
  const density = Math.min(window.devicePixelRatio || 1, 2);
  engine.setHardwareScalingLevel(1 / density);

  const scene = new Scene(engine);
  /* The terrain keeps glTF's right-handed coordinates, so the scene must too.
   * Without this the whole island renders mirrored. */
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0.51, 0.76, 0.92, 1);
  scene.ambientColor = new Color3(0.1, 0.1, 0.12);
  // Nothing hovers, so there is no reason to raycast on every pointer move.
  scene.skipPointerMovePicking = true;

  const sky = new HemisphericLight('sky', new Vector3(0.25, 1, 0.15), scene);
  sky.intensity = 0.72;
  sky.groundColor = new Color3(0.32, 0.30, 0.28);

  const sun = new DirectionalLight('sun', new Vector3(-0.55, -1, -0.4), scene);
  sun.intensity = 0.62;

  progress('downloading the island', 0.1);
  const terrain = await loadTerrain(new URL(SCENE_URL, import.meta.url).href, scene, { onProgress: progress });

  progress('mapping the grid', 0.88);
  const grid = buildGrid(terrain.meshes, terrain.bounds);

  const navigation = await buildNavigation(scene, terrain.meshes, { onProgress: progress });

  progress('ready', 1);

  // --- character, camera, input -------------------------------------------

  /* Start on the largest connected stretch of navmesh, not the middle of the
   * map. The geometric centre of this island is a high plateau that nothing
   * reaches, and opening there strands the character on 4% of the world. */
  const candidates = startCandidates(grid);
  const opening = navigation.findOpenSpace(candidates);
  const startPoint = opening?.point
    ?? navigation.nearestPoint(candidates[0], 12)
    ?? candidates[0]
    ?? Vector3.Zero();
  const character = createCharacter(scene, startPoint);
  const marker = createDestinationMarker(scene);

  const rig = new CameraRig(scene);
  rig.snapTo(startPoint);
  navigation.attachAgent(character.root);

  attachInput(ui.canvas, {
    onOrbit: (dx) => rig.orbit(dx),
    onZoom: (dy) => rig.zoom(dy),
    onTap: (x, y) => {
      /* Ray cast through Babylon's picking. Water is not pickable, so a tap on
       * a river falls through to whatever solid ground is behind it rather
       * than sending the character for a swim. */
      const hit = scene.pick(x, y);
      if (!hit?.hit || !hit.pickedPoint) return;
      if (navigation.goTo(hit.pickedPoint)) marker.show(hit.pickedPoint);
    },
  });

  scene.onBeforeRenderObservable.add(() => {
    const delta = engine.getDeltaTime() / 1000;
    character.faceVelocity(navigation.agentVelocity, delta);
    rig.follow(character.root.position);
    marker.update();
  });

  // --- heads-up display ----------------------------------------------------

  const stats = [
    ['renderer', api],
    ['file', `${(terrain.stats.bytes / 1048576).toFixed(2)} MB, ${terrain.stats.sourceNodes.toLocaleString()} nodes`],
    ['load', `${terrain.stats.totalMs} ms (parse ${terrain.stats.parseMs} ms)`],
    ['draw calls', `${terrain.stats.meshes} (from ${terrain.stats.sourceNodes.toLocaleString()})`],
    ['geometry', `${terrain.stats.triangles.toLocaleString()} tris, ${terrain.stats.vertices.toLocaleString()} verts`],
    ['grid', `${grid.width} x ${grid.depth} cells, ${grid.stats.buildMs} ms`],
    ['walkable', `${grid.stats.walkableCells.toLocaleString()} cells, ${grid.stats.multiLevelCells.toLocaleString()} multi-level`],
    ['navmesh', `${navigation.stats.buildMs} ms (wasm ${navigation.stats.wasmMs} ms)`],
    ['reachable', opening
      ? `${Math.round((opening.reachable / opening.sampled) * 100)}% of the island, ${opening.groups} separate areas`
      : 'unknown'],
  ];
  ui.stats.innerHTML = stats
    .map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`)
    .join('');

  ui.panelToggle.addEventListener('click', () => {
    const open = ui.panel.hasAttribute('hidden');
    ui.panel.toggleAttribute('hidden', !open);
    ui.panelToggle.setAttribute('aria-expanded', String(open));
  });

  let gridMesh = null;
  ui.gridToggle.addEventListener('change', () => {
    if (!gridMesh) gridMesh = grid.createDebugMesh(scene);
    gridMesh.setEnabled(ui.gridToggle.checked);
  });

  let navMesh = null;
  ui.navToggle.addEventListener('change', () => {
    if (!navMesh) navMesh = navigation.createDebugMesh(scene);
    navMesh.setEnabled(ui.navToggle.checked);
  });

  // Ground detection, read straight off the grid rather than by raycast.
  let readoutAt = 0;
  scene.onAfterRenderObservable.add(() => {
    const now = performance.now();
    if (now - readoutAt < 250) return;
    readoutAt = now;

    const { x, y, z } = character.root.position;
    const cell = grid.cellAt(x, z);
    const surface = SURFACE_NAME[grid.surfaceAt(x, z, y)] ?? 'nothing';
    const levels = grid.levelCount(cell);
    ui.readout.textContent = `${engine.getFps().toFixed(0)} fps · cell ${Math.floor(x)},${Math.floor(z)}`
      + ` · ${surface} at y ${y.toFixed(2)}${levels > 1 ? ` · ${levels} levels here` : ''}`;
  });

  engine.runRenderLoop(() => scene.render());
  window.addEventListener('resize', () => engine.resize());

  ui.loader.setAttribute('hidden', '');

  // Handy from the console while building on top of this.
  window.island = { engine, scene, terrain, grid, navigation, rig, character };
}

start().catch((error) => {
  console.error(error);
  ui.loaderError.textContent = String(error?.message ?? error);
  ui.loaderError.removeAttribute('hidden');
});
