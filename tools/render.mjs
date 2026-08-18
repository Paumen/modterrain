/* Screenshots a GLB from named camera angles, so a scene can be checked by
 * eye the way a glTF viewer would draw it: backfaces culled, one sided shells.
 *
 *   node tools/render.mjs scenes/Riverfall_Bluff.glb --out shots/bluff \
 *     --shots '[{"name":"iso","orbit":"38deg 55deg 2000m","target":"550m 380m 450m"}]'
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright';

import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json', '.glb':'model/gltf-binary', '.png':'image/png', '.css':'text/css' };

const server = createServer((req, res) => {
  const path = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!path.startsWith(ROOT) || !existsSync(path)) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i+1]; };
const model = args.find((a) => !a.startsWith('--') && !Object.values(['out','orbit','target','fov','size','shots']).includes(a)) ?? args[0];
const src = model.startsWith('/') ? model.slice(ROOT.length + 1) : model;
const out = opt('out', 'shot');
const size = (opt('size', '1200x800')).split('x').map(Number);
const shots = JSON.parse(opt('shots', 'null')) ?? [{ name: 'view', orbit: opt('orbit', '35deg 62deg auto'), target: opt('target', 'auto auto auto') }];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' , args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
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
