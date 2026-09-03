import { writeFileSync, readFileSync } from 'node:fs';
import { readGlb, readAccessor, nodeWorldMatrices, transformPoint, writeGlb } from '../lib/glb.mjs';
import { readPng } from '../lib/png.mjs';
import { GRASS_PIECES, PIECE_WEIGHTS, BANDS, mulberry32, instanceMatrix } from '../lib/scatter.mjs';

const VERSION = '2.0.0';

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
if (!input || !/\.glb$/i.test(input)) {
  console.error('usage: node tools/build/build-grass-scatter.mjs <scene.glb> [--clusters 0.115] [--per 8] [--seed N]');
  process.exit(1);
}
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const CLUSTERS = Number(flag('clusters', 0.115));
const PER = Number(flag('per', 8));
const CANDIDATES = Number(flag('candidates', 12));
const SEED = Number(flag('seed', 20260903));
const MATERIAL = flag('material', 'Grass');
const MIN_UP = Number(flag('min-up', 0.55));
const ATLAS = flag('atlas', 'models/textures/colormap.png');
const SHADE = Number(flag('ground-shade', 0.5));
const BASE_TINT = Number(flag('base-tint', 0.58));
const TIP_TINT = Number(flag('tip-tint', 1.15));
const outPath = input.replace(/(_merged)?\.glb$/i, '_grass.json');
const meshPath = input.replace(/(_merged)?\.glb$/i, '_grass.glb');

const glb = readGlb(input);
const { json } = glb;
const world = nodeWorldMatrices(json);

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const faces = [];
let area = 0;
let steep = 0;
for (let n = 0; n < json.nodes.length; n++) {
  const node = json.nodes[n];
  if (node.mesh === undefined) continue;
  for (const prim of json.meshes[node.mesh].primitives) {
    if (json.materials[prim.material]?.name !== MATERIAL) continue;
    const pos = readAccessor(glb, prim.attributes.POSITION).data;
    const idx = prim.indices === undefined ? null : readAccessor(glb, prim.indices).data;
    const count = idx ? idx.length : pos.length / 3;
    const m = world[n];
    for (let i = 0; i < count; i += 3) {
      const v = [];
      for (let k = 0; k < 3; k++) {
        const p = (idx ? idx[i + k] : i + k) * 3;
        v.push(transformPoint(m, pos[p], pos[p + 1], pos[p + 2]));
      }
      const nrm = cross(sub(v[1], v[0]), sub(v[2], v[0]));
      const len = Math.hypot(nrm[0], nrm[1], nrm[2]);
      if (len < 1e-9) continue;
      const up = nrm[1] / len;
      if (Math.abs(up) < MIN_UP) { steep++; continue; }
      const s = up < 0 ? -1 : 1;
      faces.push({ v, n: [(nrm[0] / len) * s, up * s, (nrm[2] / len) * s], area: len / 2 });
      area += len / 2;
    }
  }
}
if (!faces.length) {
  console.error(`no ${MATERIAL} triangles in ${input}`);
  process.exit(1);
}

/* The tufts read their colour from one column of the KayKit atlas. Averaging
 * the texels their UVs actually hit is how the ground learns to match them. */
function tuftColour() {
  const atlas = readPng(ATLAS);
  const seen = new Map();
  for (const piece of GRASS_PIECES) {
    const g = readGlb(`models/props/${piece}.glb`);
    const prim = g.json.meshes[0].primitives[0];
    if (prim.attributes.TEXCOORD_0 === undefined) continue;
    const uv = readAccessor(g, prim.attributes.TEXCOORD_0).data;
    for (let i = 0; i < uv.length; i += 2) seen.set(`${uv[i]},${uv[i + 1]}`, [uv[i], uv[i + 1]]);
  }
  let darkest = null;
  let sum = [0, 0, 0];
  for (const [u, v] of seen.values()) {
    const x = Math.min(atlas.width - 1, Math.max(0, Math.floor(u * atlas.width)));
    const y = Math.min(atlas.height - 1, Math.max(0, Math.floor(v * atlas.height)));
    const o = (y * atlas.width + x) * 4;
    const rgb = [atlas.pixels[o], atlas.pixels[o + 1], atlas.pixels[o + 2]];
    sum = sum.map((s, k) => s + rgb[k]);
    const lum = rgb[0] + rgb[1] * 2 + rgb[2];
    if (!darkest || lum < darkest.lum) darkest = { rgb, lum };
  }
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  /* Matching the ground to the tufts makes them vanish into it: the darkest
   * texel of the blades is still inside the range the blades themselves
   * cover. Same hue, clearly deeper, is what lets a tuft read. */
  return {
    srgb: darkest.rgb,
    mean: sum.map((s) => Math.round(s / seen.size)),
    shade: SHADE,
    linear: darkest.rgb.map((c) => Math.round(toLinear(c / 255) * SHADE * 1e4) / 1e4),
  };
}
const ground = tuftColour();

const rnd = mulberry32(SEED);
const samples = [];
let carry = 0;
for (const f of faces) {
  carry += f.area * CANDIDATES;
  let take = Math.floor(carry);
  carry -= take;
  while (take-- > 0) {
    let u = rnd(), v = rnd();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const p = [0, 1, 2].map((k) => f.v[0][k] + (f.v[1][k] - f.v[0][k]) * u + (f.v[2][k] - f.v[0][k]) * v);
    samples.push({ p, n: f.n });
  }
}

/* Clusters: a handful of seeds, then only the candidates that fall near one
 * survive, thinning outwards. Between the clumps the ground stays bare. */
const wantClusters = Math.max(1, Math.round(area * CLUSTERS));
const seeds = [];
for (let i = 0; i < wantClusters; i++) {
  const s = samples[Math.floor(rnd() * samples.length)];
  seeds.push({ p: s.p, r: 0.4 + rnd() * rnd() * 1.0, want: Math.max(3, Math.round(PER * (0.35 + rnd() * 1.5))), dom: -1, kept: 0 });
}
const MAX_R = 1.4;
const bucket = new Map();
const key = (x, z) => `${Math.floor(x / MAX_R)},${Math.floor(z / MAX_R)}`;
seeds.forEach((s, i) => {
  const k = key(s.p[0], s.p[2]);
  if (!bucket.has(k)) bucket.set(k, []);
  bucket.get(k).push(i);
});
function nearestSeed(p) {
  const cx = Math.floor(p[0] / MAX_R), cz = Math.floor(p[2] / MAX_R);
  let best = -1, bestD = Infinity;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const i of bucket.get(`${cx + dx},${cz + dz}`) ?? []) {
      const s = seeds[i];
      const d = Math.hypot(p[0] - s.p[0], p[2] - s.p[2]);
      if (d < bestD && d <= s.r) { bestD = d; best = i; }
    }
  }
  return best === -1 ? null : { seed: seeds[best], d: bestD };
}

const ext = (k) => {
  let lo = Infinity, hi = -Infinity;
  for (const s of samples) { lo = Math.min(lo, s.p[k]); hi = Math.max(hi, s.p[k]); }
  return hi - lo;
};
const axis = ext(0) >= ext(2) ? 0 : 2;
const sorted = seeds.map((s) => s.p[axis]).sort((a, b) => a - b);
const cuts = [sorted[Math.floor(sorted.length / 3)], sorted[Math.floor((sorted.length * 2) / 3)]];
const bandOf = (p) => (p[axis] < cuts[0] ? 0 : p[axis] < cuts[1] ? 1 : 2);

const cumulative = [];
{
  let acc = 0;
  for (const w of PIECE_WEIGHTS) { acc += w; cumulative.push(acc); }
}
function pickPiece(family) {
  const r = rnd() * cumulative[cumulative.length - 1];
  let k = 0;
  while (k < cumulative.length - 1 && r > cumulative[k]) k++;
  return family * 4 + k;
}

const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const items = [];
const perBand = [0, 0, 0];
const perPiece = new Array(GRASS_PIECES.length).fill(0);
for (const s of samples) {
  const near = nearestSeed(s.p);
  if (!near) continue;
  const { seed, d } = near;
  if (seed.kept >= seed.want) continue;
  const falloff = (1 - (d / seed.r) ** 2) ** 1.5;
  if (rnd() > falloff) continue;
  seed.kept++;
  const band = bandOf(seed.p);
  perBand[band]++;
  const family = band === 2 ? (seed.dom >= 0 ? seed.dom >> 2 : rnd() < 0.5 ? 0 : 1) : band;
  if (seed.dom < 0) seed.dom = pickPiece(family);
  const pick = rnd() < 0.65 ? seed.dom : pickPiece(family);
  perPiece[pick]++;
  const scale = 0.5 + rnd() * rnd() * 1.2;
  const height = 0.8 + rnd() * 0.4;
  const lean = 0.16 * (rnd() - 0.5);
  const leanDir = rnd() * Math.PI * 2;
  let nx = s.n[0] + Math.cos(leanDir) * lean;
  let nz = s.n[2] + Math.sin(leanDir) * lean;
  const flat = Math.hypot(nx, nz);
  if (flat > 0.985) { nx = (nx / flat) * 0.985; nz = (nz / flat) * 0.985; }
  items.push([
    pick, round(s.p[0]), round(s.p[1] - 0.01), round(s.p[2]),
    round(rnd() * Math.PI * 2), round(scale), round(height), round(nx), round(nz),
  ]);
}

/* One mesh, one material, one draw call: every tuft is baked into a single
 * buffer in world space. Unlit, so the atlas gradient the tufts were authored
 * with is what you see, and no normals need storing. */
const geometry = GRASS_PIECES.map((piece) => {
  const g = readGlb(`models/props/${piece}.glb`);
  const world = nodeWorldMatrices(g.json);
  const node = g.json.nodes.findIndex((n) => n.mesh !== undefined);
  const prim = g.json.meshes[g.json.nodes[node].mesh].primitives[0];
  const pos = readAccessor(g, prim.attributes.POSITION).data;
  const uv = readAccessor(g, prim.attributes.TEXCOORD_0).data;
  const idx = prim.indices === undefined ? null : readAccessor(g, prim.indices).data;
  const count = idx ? idx.length : pos.length / 3;
  const m = world[node];
  /* The pieces ship every triangle with its own three vertices; welding the
   * duplicates cuts each tuft to a quarter of the vertices it arrived with. */
  const seen = new Map();
  const verts = [];
  const indices = [];
  for (let i = 0; i < count; i++) {
    const src = idx ? idx[i] : i;
    const p = transformPoint(m, pos[src * 3], pos[src * 3 + 1], pos[src * 3 + 2]);
    const t = [uv[src * 2], uv[src * 2 + 1]];
    const key = `${p[0]},${p[1]},${p[2]},${t[0]},${t[1]}`;
    let at = seen.get(key);
    if (at === undefined) { at = verts.length; verts.push([...p, ...t]); seen.set(key, at); }
    indices.push(at);
  }
  let ymin = Infinity, ymax = -Infinity;
  for (const v of verts) { if (v[1] < ymin) ymin = v[1]; if (v[1] > ymax) ymax = v[1]; }
  return { verts, indices, ymin, span: Math.max(1e-6, ymax - ymin) };
});

const vertexCount = items.reduce((a, it) => a + geometry[it[0]].verts.length, 0);
const indexCount = items.reduce((a, it) => a + geometry[it[0]].indices.length, 0);
const bakedPos = new Float32Array(vertexCount * 3);
const bakedUv = new Float32Array(vertexCount * 2);
const bakedIdx = new Uint32Array(indexCount);
const bakedCol = new Uint8Array(vertexCount * 4);
const tint = mulberry32(SEED + 1);
const lo = [Infinity, Infinity, Infinity];
const hi = [-Infinity, -Infinity, -Infinity];
let at = 0;
let ai = 0;
for (const it of items) {
  const geo = geometry[it[0]];
  const m = instanceMatrix(it);
  /* The atlas gradient alone is a 13% change from blade base to tip, which
   * nothing survives. Baking the ramp per vertex, and jittering it per clump,
   * is what gives a tuft an edge against the ground it stands on. */
  const jitter = 0.9 + tint() * 0.2;
  for (let i = 0; i < geo.verts.length; i++) {
    const [x, y, z, u, v] = geo.verts[i];
    for (let k = 0; k < 3; k++) {
      const w = m[k] * x + m[4 + k] * y + m[8 + k] * z + m[12 + k];
      bakedPos[(at + i) * 3 + k] = w;
      if (w < lo[k]) lo[k] = w;
      if (w > hi[k]) hi[k] = w;
    }
    bakedUv[(at + i) * 2] = u;
    bakedUv[(at + i) * 2 + 1] = v;
    const t = ((y - geo.ymin) / geo.span) ** 0.8;
    const shade = Math.min(1, (BASE_TINT + (TIP_TINT - BASE_TINT) * t) * jitter);
    const b = Math.round(shade * 255);
    bakedCol.set([b, b, b, 255], (at + i) * 4);
  }
  for (let i = 0; i < geo.indices.length; i++) bakedIdx[ai + i] = at + geo.indices[i];
  at += geo.verts.length;
  ai += geo.indices.length;
}
const triangles = indexCount / 3;

const posBytes = Buffer.from(bakedPos.buffer, bakedPos.byteOffset, bakedPos.byteLength);
const uvBytes = Buffer.from(bakedUv.buffer, bakedUv.byteOffset, bakedUv.byteLength);
const colBytes = Buffer.from(bakedCol.buffer, bakedCol.byteOffset, bakedCol.byteLength);
const idxBytes = Buffer.from(bakedIdx.buffer, bakedIdx.byteOffset, bakedIdx.byteLength);
const atlasBytes = readFileSync(ATLAS);
const atlasAt = posBytes.length + uvBytes.length + colBytes.length + idxBytes.length;
writeGlb(meshPath, {
  asset: { version: '2.0', generator: 'tools/build/build-grass-scatter.mjs' },
  extensionsUsed: ['KHR_materials_unlit'],
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'Grass Scatter' }],
  meshes: [{ name: 'Grass Scatter', primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1, COLOR_0: 2 }, indices: 3, material: 0 }] }],
  materials: [{
    name: 'Grass Scatter',
    pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 },
    extensions: { KHR_materials_unlit: {} },
    doubleSided: true,
  }],
  textures: [{ sampler: 0, source: 0 }],
  images: [{ bufferView: 4, mimeType: 'image/png', name: 'colormap' }],
  samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: vertexCount, type: 'VEC3', min: lo, max: hi },
    { bufferView: 1, componentType: 5126, count: vertexCount, type: 'VEC2' },
    { bufferView: 2, componentType: 5121, count: vertexCount, type: 'VEC4', normalized: true },
    { bufferView: 3, componentType: 5125, count: indexCount, type: 'SCALAR' },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
    { buffer: 0, byteOffset: posBytes.length, byteLength: uvBytes.length, target: 34962 },
    { buffer: 0, byteOffset: posBytes.length + uvBytes.length, byteLength: colBytes.length, target: 34962 },
    { buffer: 0, byteOffset: posBytes.length + uvBytes.length + colBytes.length, byteLength: idxBytes.length, target: 34963 },
    { buffer: 0, byteOffset: atlasAt, byteLength: atlasBytes.length },
  ],
  buffers: [{ byteLength: atlasAt + atlasBytes.length }],
}, Buffer.concat([posBytes, uvBytes, colBytes, idxBytes, atlasBytes]));

const out = {
  meta: {
    version: VERSION,
    built: new Date().toISOString(),
    scene: input.split('/').pop(),
    material: MATERIAL,
    clusters: CLUSTERS,
    per: PER,
    seed: SEED,
    axis: axis === 0 ? 'x' : 'z',
    cuts: cuts.map((v) => round(v)),
    bands: BANDS,
    counts: perBand,
    seeds: seeds.length,
    triangles,
    mesh: meshPath.split('/').pop(),
    ground,
  },
  pieces: GRASS_PIECES,
  items,
};
writeFileSync(outPath, JSON.stringify(out));

console.log(`${MATERIAL}: ${faces.length} faces (${steep} too steep), ${round(area, 1)} sq cells`);
console.log(`${seeds.length} clusters, ${items.length} tufts, ${triangles.toLocaleString()} triangles`);
console.log(`baked ${meshPath} \u2014 one mesh, one material, ${(((posBytes.length + uvBytes.length + colBytes.length + idxBytes.length) / 1048576)).toFixed(1)} MB of vertex data`);
console.log(`tuft texels: darkest ${ground.srgb.join(',')} sRGB, mean ${ground.mean.join(',')}; ground shaded to ${SHADE}`);
console.log(`split on ${out.meta.axis} at ${out.meta.cuts.join(' / ')}`);
BANDS.forEach((b, i) => console.log(`  band ${i} ${b.padEnd(7)} ${perBand[i]}`));
GRASS_PIECES.forEach((p, i) => console.log(`  ${p} ${perPiece[i]}`));
console.log(`wrote ${outPath}`);
