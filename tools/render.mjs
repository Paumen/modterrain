import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODEL_URL = '/__model.glb';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png',
};

function serve(root, page, model) {
  const server = createServer(async (req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/__render.html') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(page);
      return;
    }
    if (url === MODEL_URL) {
      res.writeHead(200, { 'content-type': MIME['.glb'] }).end(await readFile(model));
      return;
    }
    const path = resolve(root, url.replace(/^\/+/, ''));
    if (relative(root, path).startsWith('..')) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, port: server.address().port })));
}

const PAGE = (url, options) => `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:${options.background}}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"/vendor/three/build/three.module.min.js","three/addons/":"/vendor/three/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const options = ${JSON.stringify(options)};
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(options.width, options.height, false);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
const gltf = await new GLTFLoader().loadAsync(${JSON.stringify(url)});
scene.add(gltf.scene);

if (options.hide) {
  const hide = new RegExp(options.hide);
  for (const node of [...gltf.scene.children]) if (hide.test(node.name ?? '')) node.removeFromParent();
}

const box = new THREE.Box3().setFromObject(gltf.scene);

const size = box.getSize(new THREE.Vector3());
const centre = box.getCenter(new THREE.Vector3());
const radius = size.length() / 2;

const azimuth = THREE.MathUtils.degToRad(options.azimuth);
const elevation = THREE.MathUtils.degToRad(options.elevation);
const direction = new THREE.Vector3(
  Math.cos(elevation) * Math.sin(azimuth),
  Math.sin(elevation),
  Math.cos(elevation) * Math.cos(azimuth),
);

const aspect = options.width / options.height;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, radius * 8);
camera.position.copy(centre).addScaledVector(direction, radius * 3);
camera.lookAt(centre);
camera.updateMatrixWorld();

const frame = new THREE.Box3();
const corner = new THREE.Vector3();
for (let i = 0; i < 8; i++) {
  corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
  frame.expandByPoint(camera.worldToLocal(corner));
}
const centred = frame.getCenter(new THREE.Vector3());
const halfWidth = Math.max(
  (frame.max.x - frame.min.x) / 2,
  ((frame.max.y - frame.min.y) / 2) * aspect,
) * options.zoom;
camera.left = centred.x - halfWidth;
camera.right = centred.x + halfWidth;
camera.top = centred.y + halfWidth / aspect;
camera.bottom = centred.y - halfWidth / aspect;
camera.updateProjectionMatrix();

const sun = new THREE.DirectionalLight(0xfff4e2, 2.6);
sun.position.copy(centre).add(new THREE.Vector3(-0.5, 1, 0.35).multiplyScalar(radius * 2));
sun.target.position.copy(centre);
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xbcd8ff, 0x3b3327, 1.6));

renderer.render(scene, camera);
window.rendered = true;
</script>`;

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const input = argv.find((arg, index) => !arg.startsWith('--') && !argv[index - 1]?.startsWith('--'));

if (!input) {
  console.error('usage: node tools/render.mjs <scene.glb> [--out file.png] [--azimuth deg] [--elevation deg] [--width px] [--height px] [--zoom f] [--background css] [--hide regex]');
  process.exit(1);
}

const options = {
  width: Number(option('width', 1600)),
  height: Number(option('height', 1000)),
  azimuth: Number(option('azimuth', 35)),
  elevation: Number(option('elevation', 32)),
  zoom: Number(option('zoom', 1.02)),
  background: option('background', '#c8dced'),
  hide: option('hide', null),
};

const out = option('out', join(ROOT, `${basename(input).replace(/\.glb$/i, '')}.png`));
const { server, port } = await serve(ROOT, PAGE(MODEL_URL, options), resolve(input));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`http://127.0.0.1:${port}/__render.html`);
await page.waitForFunction('window.rendered === true', null, { timeout: 120000 });
await page.screenshot({ path: out });
await browser.close();
server.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
console.log(out);
