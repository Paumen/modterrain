import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/loaders/GLTFLoader.js';
import { OrbitControls } from '../vendor/three/controls/OrbitControls.js';

/* The pack stores 100 units to a cell; the viewport works in cells, so every
 * loaded piece is scaled down once on the way in and all placement maths stays
 * in the same units as the socket data. */
const UNITS_PER_CELL = 100;

const VERDICT = {
  mated: 0x3f8f5f,
  partial: 0xc9a227,
  clash: 0xc9422f,
  open: 0x9a958a,
  abut: 0x4f7a9e,
};

const loader = new GLTFLoader();
const cache = new Map();

function loadPiece(id) {
  if (!cache.has(id)) {
    cache.set(id, loader.loadAsync(`models/${id}.glb`).then((gltf) => {
      const root = gltf.scene;
      root.scale.setScalar(1 / UNITS_PER_CELL);
      // Sockets are construction data, not something to look at.
      root.traverse((node) => {
        if (node.isMesh && node.material?.name?.startsWith('Hidden')) node.visible = false;
      });
      return root;
    }));
  }
  return cache.get(id);
}

export function createViewport(canvas, { onTap, onHover }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  camera.position.set(5, 6.2, 6.9);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8578, 2.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(4, 9, 6);
  scene.add(sun);

  // Cell centres are the integers, so the lines belong on the half-integers.
  const floor = new THREE.GridHelper(24, 24, 0xc9c1b2, 0xded6c8);
  floor.position.set(0.5, -0.002, 0.5);
  scene.add(floor);

  const pieces = new THREE.Group();
  const seams = new THREE.Group();
  const preview = new THREE.Group();
  scene.add(pieces, seams, preview);

  // The cell under the pointer, so a placement is never a guess about where
  // the piece is going to land.
  const marker = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0x4f7a3a, transparent: true, opacity: 0.22, depthWrite: false }),
  );
  marker.rotation.x = -Math.PI / 2;
  marker.visible = false;
  scene.add(marker);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.5, 0);
  controls.enablePan = true;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.minDistance = 2;
  controls.maxDistance = 80;

  let frameNeeded = true;
  let steered = false;
  controls.addEventListener('start', () => { steered = true; });
  const draw = () => { renderer.render(scene, camera); frameNeeded = false; };
  const invalidate = () => { frameNeeded = true; };
  controls.addEventListener('change', invalidate);

  renderer.setAnimationLoop(() => {
    if (!frameNeeded || !canvas.clientWidth) return;
    draw();
  });

  function resize() {
    const { clientWidth: width, clientHeight: height } = canvas;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    invalidate();
  }
  new ResizeObserver(resize).observe(canvas);

  // ------------------------------------------------------------- picking

  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  let downAt = null;

  const toPointer = (event) => {
    const box = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - box.left) / box.width) * 2 - 1,
      -((event.clientY - box.top) / box.height) * 2 + 1,
    );
  };

  canvas.addEventListener('pointerdown', (event) => {
    downAt = { x: event.clientX, y: event.clientY };
  });

  /* What is under the pointer: the piece it landed on, if any, and the cell
   * it landed in. Reading the cell from the model that was hit rather than
   * from the ground plane is what lets a surface layer be dropped onto a
   * cliff top — the plane behind it is a different cell entirely. */
  function probe(event) {
    toPointer(event);
    ray.setFromCamera(pointer, camera);

    const picked = ray.intersectObjects(pieces.children, true)[0];
    let owner = null;
    if (picked) {
      let node = picked.object;
      while (node && node.userData.placement === undefined) node = node.parent;
      owner = node?.userData.placement ?? null;
    }

    const point = picked ? picked.point : (ray.ray.intersectPlane(plane, hit) ? hit : null);
    return {
      id: owner,
      x: point ? Math.round(point.x) : null,
      z: point ? Math.round(point.z) : null,
    };
  }

  canvas.addEventListener('pointermove', (event) => {
    if (downAt) return;
    const at = probe(event);
    onHover?.(at.x, at.z);
  });

  canvas.addEventListener('pointerleave', () => onHover?.(null, null));

  // A drag is the camera, not a tap: only a pointer that barely moved places
  // or selects anything.
  canvas.addEventListener('pointerup', (event) => {
    if (!downAt) return;
    const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y);
    downAt = null;
    if (moved > 6) return;

    onTap(probe(event));
  });

  /* A translucent copy of the loaded piece follows the pointer, so its size,
   * facing and level are all answered before the tap rather than after. */
  let ghostFor = null;

  async function ghost(placement) {
    const key = placement && `${placement.piece}|${placement.rot}|${placement.mirror}|${placement.cx}|${placement.cz}|${placement.level}`;
    if (key === ghostFor) return;
    ghostFor = key;

    if (!placement) {
      preview.clear();
      marker.visible = false;
      invalidate();
      return;
    }

    const model = (await loadPiece(placement.piece)).clone(true);
    if (ghostFor !== key) return;

    model.traverse((node) => {
      if (!node.isMesh || !node.visible) return;
      node.material = node.material.clone();
      node.material.transparent = true;
      node.material.opacity = 0.42;
      node.material.depthWrite = false;
    });
    apply(model, placement);

    preview.clear();
    preview.add(model);
    marker.position.set(placement.cx, placement.level + 0.004, placement.cz);
    marker.visible = true;
    invalidate();
  }

  // -------------------------------------------------------------- content

  // A mirrored piece is a negative scale on x, as in the pack's own
  // placements; three.js flips the winding to match, so culling still shows
  // the shell from the right side.
  const apply = (model, placement) => {
    const size = 1 / UNITS_PER_CELL;
    model.position.set(placement.cx, placement.level, placement.cz);
    model.rotation.y = placement.rot * (Math.PI / 2);
    model.scale.set(placement.mirror ? -size : size, size, size);
  };

/* The view is framed once, when the board stops being empty. Re-framing on
 * every placement slides the ground out from under the pointer between taps,
 * so after the first piece the camera is the user's alone. */
  let framed = false;

  function frame(placements) {
    if (steered || framed || !placements.length) return;
    framed = true;
    const box = new THREE.Box3();
    for (const placement of placements) {
      box.expandByPoint(new THREE.Vector3(placement.cx - 1, placement.level, placement.cz - 1));
      box.expandByPoint(new THREE.Vector3(placement.cx + 1, placement.level + 1, placement.cz + 1));
    }

    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1.5);
    const distance = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.15;

    controls.target.copy(centre);
    camera.position.set(
      centre.x + distance * 0.55,
      centre.y + distance * 0.62,
      centre.z + distance * 0.75,
    );
    controls.update();
  }

  async function sync(placements, sockets, selected) {
    plane.constant = 0;

    const loaded = await Promise.all(placements.map((placement) => loadPiece(placement.piece)));
    pieces.clear();

    placements.forEach((placement, index) => {
      const model = loaded[index].clone(true);
      apply(model, placement);
      model.userData.placement = placement.id;

      if (placement.id === selected) {
        model.traverse((node) => {
          if (!node.isMesh || !node.visible) return;
          node.material = node.material.clone();
          node.material.emissive = new THREE.Color(0x4f7a3a);
          node.material.emissiveIntensity = 0.35;
        });
      }
      pieces.add(model);
    });

    seams.clear();
    for (const socket of sockets) {
      const verdict = socket.verdict === 'open' && socket.abuts ? 'abut' : socket.verdict;
      const length = socket.to - socket.from;
      const height = Math.max(socket.height, 0.02);
      const geometry = new THREE.PlaneGeometry(length, height);
      const material = new THREE.MeshBasicMaterial({
        color: VERDICT[verdict],
        transparent: true,
        opacity: socket.owner === selected ? 0.85 : 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const quad = new THREE.Mesh(geometry, material);
      const mid = (socket.from + socket.to) / 2;
      if (socket.axis === 'x') {
        quad.position.set(socket.at, socket.floor + height / 2, mid);
        quad.rotation.y = Math.PI / 2;
      } else {
        quad.position.set(mid, socket.floor + height / 2, socket.at);
      }
      seams.add(quad);
    }

    frame(placements);
    resize();
    invalidate();
  }

  resize();
  return { sync, ghost, resize, invalidate };
}
