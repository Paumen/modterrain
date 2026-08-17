/**
 * One-off (but rerunnable) fix for the missing-texture bug documented in
 * PROVENANCE.md §2: several materials reference a `.png` by an absolute path
 * on the original author's machine, and that file was never part of the
 * delivered zip. The actual textures — matched by filename against the
 * pack's own Unity project, not guessed — now live in `textures/`.
 *
 * Run from the repo root:  node tools/embed-textures.mjs
 *
 * For each affected material, this embeds the real PNG directly into the
 * `.glb`'s binary chunk (see `embedImage` in tools/glb.mjs) in place of the
 * broken `uri`, and resets `baseColorFactor` to white. That reset isn't a
 * guess: the pack's Unity source shows `_Color = 1,1,1,1` for every one of
 * these materials — an untinted texture — so the flat color currently baked
 * into `baseColorFactor` is an artifact of the broken export (most likely an
 * average of the texture's own pixels, computed as a fallback when the
 * exporter couldn't carry the image through), not a deliberate tint to
 * preserve.
 *
 * Everything else about the mesh — geometry, UVs, the texture/sampler
 * wiring — was already correct; only the image data was missing.
 */

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
  const embeddedThisFile = new Set(); // image index → already patched, don't re-embed if shared

  glb.json.materials?.forEach((material, materialIndex) => {
    const textureFile = TEXTURE_BY_MATERIAL[material.name];
    if (!textureFile) return;

    const textureRef = material.pbrMetallicRoughness?.baseColorTexture;
    if (!textureRef) return; // this material has no texture slot in this model to fix

    const imageIndex = glb.json.textures[textureRef.index].source;
    const image = glb.json.images[imageIndex];
    // Idempotent: skip images already embedded (no `uri`, or a `uri` that
    // isn't the broken absolute path we're expecting) and images already
    // handled earlier in this same file.
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
