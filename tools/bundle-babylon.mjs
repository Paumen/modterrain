/**
 * Builds vendor/babylon/ — the engine bundle the game page loads.
 *
 *     node tools/bundle-babylon.mjs
 *
 * Babylon ships as hundreds of ES modules, and the game imports a small corner
 * of it: no glTF loader (game/terrain.js reads the GLB itself), no physics, no
 * GUI. Bundling that corner with esbuild is what keeps the payload near 900 KB
 * gzipped instead of the 8.3 MB of the full UMD build.
 *
 * Recast is copied rather than bundled: it is a WASM module Babylon's
 * navigation plugin instantiates at runtime, so the .wasm has to stay a file.
 *
 * Needs network access; run it when the pinned versions below change.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, copyFileSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'vendor', 'babylon');

const BABYLON = '9.23.0';
const RECAST = '1.6.4';
const ESBUILD = '0.28.2';

/* Every Babylon symbol the game uses. esbuild follows these and drops the rest,
 * so anything the game imports must be re-exported here or the build will not
 * carry it. */
const ENTRY = `
export { EngineFactory } from '@babylonjs/core/Engines/engineFactory.js';
export { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
export { Engine } from '@babylonjs/core/Engines/engine.js';
export { Scene } from '@babylonjs/core/scene.js';
export { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
export { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
export { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
export { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
export { Vector2, Vector3, Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector.js';
export { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
export { Scalar } from '@babylonjs/core/Maths/math.scalar.js';
export { Mesh } from '@babylonjs/core/Meshes/mesh.js';
export { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
export { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
export { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
export { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
export { Material } from '@babylonjs/core/Materials/material.js';
export { Ray } from '@babylonjs/core/Culling/ray.js';
export { PickingInfo } from '@babylonjs/core/Collisions/pickingInfo.js';
export { RecastJSPlugin } from '@babylonjs/core/Navigation/Plugins/recastJSPlugin.js';
export { Tools } from '@babylonjs/core/Misc/tools.js';

import '@babylonjs/core/Meshes/thinInstanceMesh.js';
import '@babylonjs/core/Culling/ray.js';
import '@babylonjs/core/Rendering/boundingBoxRenderer.js';
import '@babylonjs/core/Engines/WebGPU/Extensions/index.js';
`;

const work = mkdtempSync(join(tmpdir(), 'babylon-bundle-'));
try {
  console.log(`installing babylon ${BABYLON}, recast ${RECAST}, esbuild ${ESBUILD} …`);
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'bundle', private: true, type: 'module' }));
  execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund',
    `@babylonjs/core@${BABYLON}`, `recast-detour@${RECAST}`, `esbuild@${ESBUILD}`],
    { cwd: work, stdio: 'inherit' });

  writeFileSync(join(work, 'entry.js'), ENTRY);
  mkdirSync(OUT, { recursive: true });

  console.log('bundling …');
  execFileSync(join(work, 'node_modules', '.bin', 'esbuild'), [
    join(work, 'entry.js'), '--bundle', '--format=esm', '--minify', '--target=es2020',
    '--legal-comments=none', `--outfile=${join(OUT, 'babylon.js')}`,
  ], { stdio: 'inherit' });

  for (const [from, to] of [
    [join('node_modules', 'recast-detour', 'recast.wasm.wasm'), 'recast.wasm.wasm'],
    [join('node_modules', '@babylonjs', 'core', 'license.md'), 'LICENSE.babylon.md'],
    [join('node_modules', 'recast-detour', 'License.txt'), 'LICENSE.recast.txt'],
  ]) copyFileSync(join(work, from), join(OUT, to));

  /* recast.wasm.js is a UMD Emscripten bundle that finds its .wasm through
   * document.currentScript — which is null for an ES module, leaving it to
   * guess from the page URL and 404. Wrapping it in a module that resolves the
   * .wasm against its own URL is what lets the game import it directly. */
  const glue = readFileSync(join(work, 'node_modules', 'recast-detour', 'recast.wasm.js'), 'utf8');
  writeFileSync(join(OUT, 'recast.js'), `${glue}
export default function createRecast(options = {}) {
  /* .call(globalThis) because the factory ends with \`this["Recast"] = Module\`.
   * A module is strict, so a plain call would leave \`this\` undefined and throw
   * on the very last line of an otherwise successful load. */
  return Recast.call(globalThis, {
    locateFile: (path) => new URL(path, import.meta.url).href,
    ...options,
  });
}
`);
  rmSync(join(OUT, 'recast.wasm.js'), { force: true });

  writeFileSync(join(OUT, 'VERSIONS.json'),
    `${JSON.stringify({ babylon: BABYLON, recast: RECAST, esbuild: ESBUILD }, null, 2)}\n`);

  for (const name of ['babylon.js', 'recast.js', 'recast.wasm.wasm']) {
    const bytes = statSync(join(OUT, name)).size;
    const gz = gzipSync(readFileSync(join(OUT, name)), { level: 9 }).length;
    console.log(`  ${name.padEnd(20)} ${(bytes / 1024).toFixed(0)} KB  (${(gz / 1024).toFixed(0)} KB gzipped)`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
