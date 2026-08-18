import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/loaders/GLTFLoader.js';
import { OrbitControls } from '../vendor/three/controls/OrbitControls.js';
import { GLTFExporter } from '../vendor/three/exporters/GLTFExporter.js';

/* The pack stores 100 units to a cell; the viewport works in cells, so every
 * loaded piece is scaled down once on the way in and all placement maths stays
 * in the same units as the socket data. */
const UNITS_PER_CELL = 100;

/* How far from the origin a piece may be dropped. Near the horizon a ray
 * meets the ground a very long way off, and a piece placed out there is gone
 * from the view with no way back to it. */
const REACH = 12;

const VERDICT = {
  mated: 0x3f8f5f,
  partial: 0xc9a227,
  clash: 0xc9422f,
  open: 0x9a958a,
  abut: 0x4f7a9e,
};

const loader = new GLTFLoader();
const cache = new Map();

const SOCKET = /^Hidden[ _]?/;
let socketColor = () => null;

/* The pack's socket colours are pale by design — under lighting they all read
 * as off-white, which defeats the point of looking at them. They are deepened
 * for display only. A grey stays grey, so the uncoloured `Hidden` faces do not
 * pick up a tint they never had. */
function display(hex) {
  const color = new THREE.Color(hex);
  const hsl = color.getHSL({ h: 0, s: 0, l: 0 });
  return color.setHSL(hsl.h, Math.min(1, hsl.s * 2.4), Math.max(0.32, hsl.l * 0.72));
}

/* The `Hidden` faces are the sockets, and they are also what closes each
 * shell: the visible surfaces alone are one-sided, so a piece with its
 * sockets stripped out reads as a sheet of paper. They are kept, painted in
 * the colour that names them — which is the thing this tab is about. */
function loadPiece(id, piece) {
  if (!cache.has(id)) {
    cache.set(id, loader.loadAsync(`${piece.dir}/${id}.glb`).then((gltf) => {
      const root = gltf.scene;
      root.traverse((node) => {
        const name = node.isMesh ? (node.material?.name ?? '') : '';
        if (!SOCKET.test(name)) return;

        node.userData.socket = true;
        node.material = new THREE.MeshStandardMaterial({
          color: display(socketColor(name.replace('_', ' ')) ?? '#f8f8f8'),
          roughness: 0.85,
          metalness: 0,
        });
      });
      return root;
    }));
  }
  return cache.get(id);
}

export function createViewport(canvas, { onTap, onHover, colorOf }) {
  socketColor = colorOf ?? socketColor;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  camera.position.set(6.2, 12.6, 8.6);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8578, 2.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(4, 9, 6);
  scene.add(sun);

  // Cell centres are the integers, so the lines belong on the half-integers.
  // The ground runs well past any sensible build and fades into the page
  // colour, so the board reads as open rather than as a small mat.
  const paper = getComputedStyle(document.body).getPropertyValue('--paper-deep').trim() || '#ece6db';
  scene.fog = new THREE.Fog(new THREE.Color(paper), 26, 62);

  const floor = new THREE.GridHelper(64, 64, 0xc9c1b2, 0xded6c8);
  floor.position.set(0.5, -0.002, 0.5);
  scene.add(floor);

  /* The plane you are building on. Without it, raising the level changes
   * nothing you can see until a piece lands, and the pick would still be
   * taken against the ground. */
  const deck = new THREE.Group();
  const deckGrid = new THREE.GridHelper(24, 24, 0x4f7a3a, 0x4f7a3a);
  deckGrid.material.transparent = true;
  deckGrid.material.opacity = 0.5;
  deckGrid.position.set(0.5, 0, 0.5);
  const deckFill = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    new THREE.MeshBasicMaterial({ color: 0x4f7a3a, transparent: true, opacity: 0.06, depthWrite: false }),
  );
  deckFill.rotation.x = -Math.PI / 2;
  deckFill.position.set(0.5, 0, 0.5);
  deck.add(deckGrid, deckFill);
  deck.visible = false;
  scene.add(deck);

  const pieces = new THREE.Group();
  const seams = new THREE.Group();
  const preview = new THREE.Group();
  const marks = new THREE.Group();
  scene.add(pieces, seams, preview, marks);

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
  // Where the build is. Turning or zooming pivots on this rather than on
  // wherever the camera was first aimed, or the view swings around a point
  // off to one side of what is being built.
  const middle = new THREE.Vector3(0, 0.5, 0);
  const bounds = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));

  /* The panels float over the canvas rather than beside it, so the picture is
   * wider than the part of it anyone can see. Framing works against the clear
   * band between them: fitting to the whole canvas hides half a build behind
   * the picker, which is where the picker usually is. */
  let insets = { top: 0, right: 0, bottom: 0 };

  function setInsets(next) {
    insets = { top: next.top ?? 0, right: next.right ?? 0, bottom: next.bottom ?? 0 };
    invalidate();
  }
  controls.addEventListener('start', () => { steered = true; });
  const draw = () => { renderer.render(scene, camera); frameNeeded = false; };
  const invalidate = () => { frameNeeded = true; };
  controls.addEventListener('change', () => { depthCue(); invalidate(); });

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
    // No hover on a touch screen: the preview has to appear on the press, so
    // the press itself shows where the piece is about to land.
    const at = probe(event);
    onHover?.(at.x, at.z);
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
    const inside = point && Math.abs(point.x) <= REACH && Math.abs(point.z) <= REACH;
    return {
      id: owner,
      x: inside ? Math.round(point.x) : null,
      z: inside ? Math.round(point.z) : null,
    };
  }

  canvas.addEventListener('pointermove', (event) => {
    const at = probe(event);
    if (downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 6) {
      onHover?.(null, null);
      return;
    }
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

    const model = (await loadPiece(placement.piece, placement)).clone(true);
    if (ghostFor !== key) return;

    model.traverse((node) => {
      if (!node.isMesh) return;
      if (node.userData.socket && !showSockets) { node.visible = false; return; }
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

  // ---------------------------------------------------------------- views

  /* Standing viewpoints, because orbiting back to a square-on look by hand is
   * fiddly and the level of a piece is far easier to read from the front. */
  // Pitch is kept well off the horizon: at a few degrees the ground collapses
  // to a strip and there is nowhere left to build.
  // Pitch, then compass bearing of the camera about the build. Iso stands off
  // a corner; front stands square-on to the near edge, which is the whole
  // point of having it.
  const ANGLES = {
    iso: [0.62, Math.PI / 4],
    top: [1.52, 0],
    front: [0.34, 0],
    side: [0.34, Math.PI / 2],
  };

  /* How far back the camera has to stand, along a given heading, for the
   * whole build to be on screen. The build is measured across the screen
   * rather than as a sphere: a long thin row of pieces seen end-on needs a
   * fraction of the room the same row needs seen broadside. Both fields are
   * checked, because on a portrait phone the horizontal one is the tight
   * one and fitting to the vertical alone pushes the build off the sides. */
  // The camera's own axes for a heading, so the build can be measured the way
  // it will be seen rather than as a sphere.
  function basis(heading) {
    const dir = heading.clone().normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    return { dir, right, up: new THREE.Vector3().crossVectors(dir, right).normalize() };
  }

  // What fraction of the canvas is left clear by the panels over it.
  function clear() {
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    return {
      across: Math.max(0.25, (width - insets.right) / width),
      down: Math.max(0.25, (height - insets.top - insets.bottom) / height),
    };
  }

  function span(heading) {
    const { dir, right, up } = basis(heading);
    const size = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    let across = 0;
    let tall = 0;
    let deep = 0;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const corner = new THREE.Vector3(size.x * sx, size.y * sy, size.z * sz);
          across = Math.max(across, Math.abs(corner.dot(right)));
          tall = Math.max(tall, Math.abs(corner.dot(up)));
          deep = Math.max(deep, Math.abs(corner.dot(dir)));
        }
      }
    }

    const vertical = (camera.fov * Math.PI) / 360;
    const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
    const room = clear();
    const reach = Math.max(
      across / (Math.tan(horizontal) * room.across),
      tall / (Math.tan(vertical) * room.down),
    );
    return Math.max(reach * 1.12 + deep, controls.minDistance);
  }

  /* Aim so the build sits in the clear band, not at the centre of the canvas:
   * the target is lifted off the build by however far the middle of that band
   * is from the middle of the picture. */
  function aimAt(heading, distance) {
    // OrbitControls clamps how far the camera may stand off its target, and
    // that clamp is what a fitted view runs into: a forty-cell diorama needs
    // the camera three times further back than a hand-held zoom ever asks
    // for, and being clamped leaves it inside the scene, staring at the far
    // side of shells it cannot see through.
    controls.maxDistance = Math.max(80, distance * 1.05);
    const { dir, right, up } = basis(heading);
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    const vertical = Math.tan((camera.fov * Math.PI) / 360) * distance;
    controls.target.copy(middle)
      .addScaledVector(up, ((insets.top - insets.bottom) / height) * vertical)
      .addScaledVector(right, (insets.right / width) * vertical * camera.aspect);
    camera.position.copy(controls.target).addScaledVector(dir, distance);
    depthCue();
  }

  /* Fog and the far plane were sized for a build of a few cells. A whole
   * diorama stands further off than the fog's far edge, so it faded to paper
   * before it was ever drawn — the view looked empty however well it was
   * framed. Both now follow how far the camera is standing back. */
  function depthCue() {
    const reach = camera.position.distanceTo(controls.target);
    const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
    scene.fog.near = Math.max(26, reach + radius);
    scene.fog.far = Math.max(62, reach + radius * 3 + 40);

    const far = Math.max(500, reach + radius * 4 + 100);
    if (camera.far !== far) {
      camera.far = far;
      camera.updateProjectionMatrix();
    }
  }

  // A standing viewpoint frames what is on the grid: turning to the front of
  // a build only helps if the build is actually in the picture.
  function setView(name) {
    const [pitch, yaw] = ANGLES[name] ?? ANGLES.iso;
    const heading = new THREE.Vector3(
      Math.cos(pitch) * Math.sin(yaw),
      Math.sin(pitch),
      Math.cos(pitch) * Math.cos(yaw),
    );
    aimAt(heading, span(heading));
    controls.update();
    steered = true;
    invalidate();
  }

  /* Turning and zooming from buttons as well as from the drag, because on a
   * touch screen the drag is also how a piece gets placed. */
  function orbit(radians) {
    const offset = camera.position.clone().sub(controls.target);
    const angle = Math.atan2(offset.x, offset.z) + radians;
    const flat = Math.hypot(offset.x, offset.z);
    aimAt(new THREE.Vector3(flat * Math.sin(angle), offset.y, flat * Math.cos(angle)), offset.length());
    controls.update();
    steered = true;
    invalidate();
  }

  /* Five standing zoom stops rather than a free factor, so the buttons land
   * on the same handful of framings every time. They are spaced by a constant
   * ratio — a step near the build and a step far from it look the same size —
   * and they follow the build: the stop that frames a single plate is deep
   * inside a whole diorama. */
  function stops() {
    const far = span(new THREE.Vector3(0.42, 0.72, 0.55));
    const near = Math.max(controls.minDistance, far / 8);
    const ratio = (far / near) ** (1 / 4);
    return [0, 1, 2, 3, 4].map((step) => Number((near * ratio ** step).toFixed(2)));
  }

  // A drag or a pinch leaves the camera between stops. The first press then
  // snaps to the neighbouring stop in the direction asked for; from there on
  // every press is exactly one stop.
  function zoom(direction) {
    const inward = direction < 0;
    const ladder = stops();
    const rungs = inward ? [...ladder].reverse() : ladder;
    const offset = camera.position.clone().sub(controls.target);
    const current = offset.length();
    const next = rungs.find((stop) => (inward ? stop < current * 0.99 : stop > current * 1.01));
    const distance = next ?? rungs[rungs.length - 1];
    aimAt(offset, distance);
    controls.update();
    steered = true;
    invalidate();
    return distance;
  }

  /* Which way the grid runs across the screen. The nudge buttons move the
   * ghost the way the arrow points, and after the camera has been turned
   * that is no longer the way the grid's own axes run. The heading snaps to
   * the nearest quarter turn, so a nudge is always a whole cell. */
  function axes() {
    const offset = camera.position.clone().sub(controls.target);
    const turns = ((Math.round(Math.atan2(offset.x, offset.z) / (Math.PI / 2)) % 4) + 4) % 4;
    return {
      right: [[1, 0], [0, -1], [-1, 0], [0, 1]][turns],
      away: [[0, -1], [-1, 0], [0, 1], [1, 0]][turns],
    };
  }

  // Sockets can be taken back out of the view once they have been read; the
  // pieces go back to being shells when they are.
  let showSockets = true;

  function setSockets(show) {
    showSockets = show;
    pieces.traverse((node) => { if (node.userData.socket) node.visible = show; });
    preview.traverse((node) => { if (node.userData.socket) node.visible = show; });
    invalidate();
  }

  // The pick lands on the plane you are building on, not on the ground: at
  // level 2 the ground behind a cliff is a different cell entirely.
  function setLevel(level) {
    plane.constant = -level;
    deck.position.y = level + 0.004;
    deck.visible = Math.abs(level) > 1e-6;
    invalidate();
  }

  // -------------------------------------------------------------- content

  // A mirrored piece is a negative scale on x, as in the pack's own
  // placements; three.js flips the winding to match, so culling still shows
  // the shell from the right side.
  const apply = (model, placement) => {
    const size = (placement.scale ?? 1) / UNITS_PER_CELL;
    model.position.set(placement.cx, placement.level, placement.cz);
    model.rotation.y = placement.rot * (Math.PI / 2);
    model.scale.set(placement.mirror ? -size : size, size, size);
  };

/* The view is framed once, when the board stops being empty. Re-framing on
 * every placement slides the ground out from under the pointer between taps,
 * so after the first piece the camera is the user's alone. */
  let framed = false;

  // What is on the grid, in cells, with a cell of air around it so a piece on
  // the edge is not flush against the side of the picture.
  function extent(placements) {
    // Measured off the pieces themselves, not off the cells they were placed
    // on: a piece is anchored on one cell but a scene can run five cells past
    // it, and a cliff stack is far taller than the level it sits at. Framing
    // on the anchors cuts all of that off the picture.
    pieces.updateMatrixWorld(true);
    bounds.setFromObject(pieces);

    if (!placements.length || bounds.isEmpty() || !Number.isFinite(bounds.min.x + bounds.max.x)) {
      bounds.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
    } else {
      // Enough air for a piece not to sit flush against the edge of the
      // picture; the framing itself keeps a margin beyond this.
      bounds.expandByScalar(0.1);
    }
    bounds.getCenter(middle);
  }

  function frame(placements) {
    if (steered || framed || !placements.length) return;
    framed = true;
    const heading = new THREE.Vector3(0.42, 0.72, 0.55);
    aimAt(heading, span(heading));
    controls.update();
  }

  async function sync(placements, sockets, selected) {
    const loaded = await Promise.all(placements.map((placement) => loadPiece(placement.piece, placement)));
    pieces.clear();

    placements.forEach((placement, index) => {
      const model = loaded[index].clone(true);
      apply(model, placement);
      model.userData.placement = placement.id;
      if (!showSockets) model.traverse((node) => { if (node.userData.socket) node.visible = false; });

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

    // The pivot and the framing both follow the build, whether or not the
    // camera does.
    extent(placements);

    marks.clear();
    for (const placement of placements) {
      if (placement.id !== selected) continue;
      marks.add(anchor(placement));
    }

    frame(placements);
    resize();
    invalidate();
  }

  /* Which cell a piece is anchored on, and which way it is facing. A multi-cell
   * piece hangs off one specific cell and every rotation is about that cell, so
   * without the marker there is no way to tell where a piece will pivot. */
  function anchor(placement) {
    const group = new THREE.Group();
    group.position.set(placement.cx, placement.level + 0.01, placement.cz);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.13, 0.2, 24),
      new THREE.MeshBasicMaterial({ color: 0x2b2a26, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthTest: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);

    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.13, 0.3, 3),
      new THREE.MeshBasicMaterial({ color: 0x4f7a3a, depthTest: false }),
    );
    arrow.position.set(0, 0, 0.42);
    arrow.rotation.set(Math.PI / 2, 0, 0);
    group.add(arrow);

    // Facing follows the piece: a quarter turn about the vertical, and a
    // mirrored piece faces the other way across x.
    group.rotation.y = placement.rot * (Math.PI / 2);
    group.scale.x = placement.mirror ? -1 : 1;
    group.renderOrder = 2;
    return group;
  }

  /* The placed pieces as one binary glTF. Sockets stay out of it — they are
   * hidden in the view and they are not part of what was built. */
  function exportGlb() {
    return new Promise((resolve, reject) => {
      new GLTFExporter().parse(
        pieces,
        (result) => resolve(new Blob([result], { type: 'model/gltf-binary' })),
        reject,
        { binary: true, onlyVisible: true },
      );
    });
  }

  resize();
  return { sync, ghost, setView, setLevel, setSockets, setInsets, orbit, zoom, axes, exportGlb, resize, invalidate };
}
