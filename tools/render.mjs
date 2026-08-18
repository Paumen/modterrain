/* Screenshots a GLB from named camera angles, so a scene can be checked by
 * eye the way a glTF viewer would draw it: backfaces culled, one sided shells.
 *
 *   node tools/render.mjs scenes/Riverfall_Bluff.glb --out shots/bluff \
 *     --shots '[{"name":"iso","orbit":"38deg 55deg 2000m","target":"550m 380m 450m"}]'
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, resolve, relative, isAbsolute, sep } from 'node:path';
import { chromium } from 'playwright';

import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json', '.glb':'model/gltf-binary', '.png':'image/png', '.css':'text/css' };

// Serves the repo to the headless page. Paths are resolved and then checked
// against ROOT plus a separator, so neither `..` nor a sibling directory whose
// name merely starts with ROOT can be reached.
const server = createServer((req, res) => {
  const path = resolve(ROOT, `.${decodeURIComponent(req.url.split('?')[0])}`);
  if ((path !== ROOT && !path.startsWith(ROOT + sep)) || !existsSync(path)) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

/* Options are `--name value`, so an option's value has to be consumed with it
 * — otherwise the first bare word in `--out shots/bluff scene.glb` reads as
 * the model.
 */
const OPTIONS = new Set(['out', 'orbit', 'target', 'size', 'shots']);
const values = new Map();
const positional = [];
for (const argv = process.argv.slice(2); argv.length;) {
  const arg = argv.shift();
  const name = arg.startsWith('--') ? arg.slice(2) : null;
  if (name && OPTIONS.has(name)) values.set(name, argv.shift());
  else if (!name) positional.push(arg);
}

const opt = (name, fallback) => values.get(name) ?? fallback;
const model = positional[0];
if (!model) {
  console.error('usage: node tools/render.mjs <file.glb> [--out prefix] [--size WxH] [--shots json] [--orbit o] [--target t]');
  process.exit(1);
}
const src = isAbsolute(model) ? relative(ROOT, model) : model;
const out = opt('out', 'shot');
const size = opt('size', '1200x800').split('x').map(Number);
const shots = JSON.parse(opt('shots', 'null')) ?? [{ name: 'view', orbit: opt('orbit', '35deg 62deg auto'), target: opt('target', 'auto auto auto') }];

// Playwright finds its own Chromium; CHROMIUM_PATH is for installs it cannot.
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 2 });
page.on('console', m => { if (m.type()==='error') console.error('  [page]', m.text()); });

await page.setContent(`<!doctype html><html><head><style>
html,body{margin:0;background:#aecfe6;} model-viewer{width:${size[0]}px;height:${size[1]}px;--poster-color:transparent;}
</style><script type="module" src="http://localhost:${port}/vendor/model-viewer.min.js"></script></head>
<body><model-viewer id="mv" src="http://localhost:${port}/${src}"
  environment-image="neutral" exposure="1.0" shadow-intensity="1.1" shadow-softness="0.7"
  min-camera-orbit="auto auto 0m" max-camera-orbit="auto auto 100000m"
  interpolation-decay="1" disable-zoom></model-viewer></body></html>`, { waitUntil: 'load' });

await page.waitForFunction(() => document.querySelector('#mv')?.loaded === true, null, { timeout: 60000 });
mkdirSync(resolve(out, '..'), { recursive: true });

const dims = await page.evaluate(() => { const m=document.querySelector('#mv'); return { dims: m.getDimensions(), center: m.getBoundingBoxCenter() }; });
console.log('bbox', JSON.stringify(dims));

for (const s of shots) {
  await page.evaluate(({orbit, target}) => {
    const m = document.querySelector('#mv');
    m.cameraOrbit = orbit; m.cameraTarget = target; m.jumpCameraToGoal();
  }, s);
  await page.waitForTimeout(700);
  const file = `${out}-${s.name}.png`;
  await page.locator('#mv').screenshot({ path: file });
  console.log('  wrote', file);
}
await browser.close();
server.close();
