import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, writeGlb, embedImage } from './glb.mjs';
import { TEXTURE_BY_MATERIAL } from './textures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = join(ROOT, 'models');
const TEXTURES_DIR = join(ROOT, 'textures');

const pngCache = new Map();
const pngFor = (file) => {
  if (!pngCache.has(file)) pngCache.set(file, readFileSync(join(TEXTURES_DIR, file)));
  return pngCache.get(file);
};

const files = readdirSync(MODELS_DIR).filter((name) => name.endsWith('.glb')).sort();

let patchedFiles = 0;
let embeddedImages = 0;
const perMaterial = new Map();

for (const file of files) {
  const path = join(MODELS_DIR, file);
  let glb = readGlb(path);
  let changed = false;
  const embeddedThisFile = new Set();

  glb.json.materials?.forEach((material, materialIndex) => {
    const textureFile = TEXTURE_BY_MATERIAL[material.name];
    if (!textureFile) return;

    const textureRef = material.pbrMetallicRoughness?.baseColorTexture;
    if (!textureRef) return;

    const imageIndex = glb.json.textures[textureRef.index].source;
    const image = glb.json.images[imageIndex];
    // Reruns stay idempotent: an already-embedded image has no matching `uri`.
    if (embeddedThisFile.has(imageIndex)) return;
    if (!image.uri || !image.uri.toLowerCase().endsWith(textureFile.toLowerCase())) return;

    glb = { ...glb, ...embedImage(glb, imageIndex, pngFor(textureFile)) };
    glb.json.materials[materialIndex].pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1];
    embeddedThisFile.add(imageIndex);
    changed = true;
    embeddedImages++;
    perMaterial.set(material.name, (perMaterial.get(material.name) ?? 0) + 1);
  });

  if (changed) {
    writeGlb(path, glb.json, glb.bin);
    patchedFiles++;
  }
}

console.log(`${patchedFiles} models patched, ${embeddedImages} images embedded`);
for (const [name, count] of [...perMaterial].sort()) {
  console.log(`  ${String(count).padStart(3)}  ${name}`);
}
