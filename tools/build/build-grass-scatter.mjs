import { writeFileSync } from 'node:fs';
import { readGlb, readAccessor, nodeWorldMatrices, transformPoint } from '../lib/glb.mjs';
import { GRASS_PIECES, BANDS, mulberry32 } from '../lib/scatter.mjs';

const VERSION = '1.0.0';

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
if (!input || !/\.glb$/i.test(input)) {
  console.error('usage: node tools/build/build-grass-scatter.mjs <scene.glb> [--density N] [--seed N] [--material Grass]');
  process.exit(1);
}
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const DENSITY = Number(flag('density', 1.4));
const SEED = Number(flag('seed', 20260903));
const MATERIAL = flag('material', 'Grass');
const MIN_UP = Number(flag('min-up', 0.55));
const outPath = input.replace(/(_merged)?\.glb$/i, '_grass.json');

const glb = readGlb(input);
const { json } = glb;
const world = nodeWorldMatrices(json);

const tris = [];
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
      tris.push(v);
    }
  }
}
if (!tris.length) {
  console.error(`no ${MATERIAL} triangles in ${input}`);
  process.exit(1);
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const faces = [];
let area = 0;
let skipped = 0;
for (const [a, b, c] of tris) {
  const n = cross(sub(b, a), sub(c, a));
  const len = Math.hypot(n[0], n[1], n[2]);
  if (len < 1e-9) continue;
  const up = n[1] / len;
  if (Math.abs(up) < MIN_UP) { skipped++; continue; }
  const s = up < 0 ? -1 : 1;
  const face = { a, b, c, n: [(n[0] / len) * s, up * s, (n[2] / len) * s], area: len / 2 };
  area += face.area;
  faces.push(face);
}

const rnd = mulberry32(SEED);
const samples = [];
let carry = 0;
for (const f of faces) {
  carry += f.area * DENSITY;
  let take = Math.floor(carry);
  carry -= take;
  while (take-- > 0) {
    let u = rnd(), v = rnd();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const p = [0, 1, 2].map((k) => f.a[k] + (f.b[k] - f.a[k]) * u + (f.c[k] - f.a[k]) * v);
    samples.push({ p, n: f.n });
  }
}

const ext = (k) => {
  let lo = Infinity, hi = -Infinity;
  for (const s of samples) { lo = Math.min(lo, s.p[k]); hi = Math.max(hi, s.p[k]); }
  return hi - lo;
};
const axis = ext(0) >= ext(2) ? 0 : 2;
const sorted = samples.map((s) => s.p[axis]).sort((a, b) => a - b);
const cut = [sorted[Math.floor(sorted.length / 3)], sorted[Math.floor((sorted.length * 2) / 3)]];
const bandOf = (p) => (p[axis] < cut[0] ? 0 : p[axis] < cut[1] ? 1 : 2);

const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const items = [];
const perBand = [0, 0, 0];
const perPiece = new Array(GRASS_PIECES.length).fill(0);
for (const s of samples) {
  const band = bandOf(s.p);
  perBand[band]++;
  const family = band === 2 ? (rnd() < 0.5 ? 0 : 1) : band;
  const pick = family * 4 + Math.floor(rnd() * 4);
  perPiece[pick]++;
  const scale = 0.55 + rnd() * rnd() * 1.35;
  const height = scale * (0.75 + rnd() * 0.6);
  const lean = 0.16 * (rnd() - 0.5);
  const leanDir = rnd() * Math.PI * 2;
  const nx = s.n[0] + Math.cos(leanDir) * lean;
  const nz = s.n[2] + Math.sin(leanDir) * lean;
  const clamp = Math.min(1, 0.985 / Math.hypot(nx, nz) || 1);
  items.push([
    pick, round(s.p[0]), round(s.p[1] - 0.01), round(s.p[2]),
    round(rnd() * Math.PI * 2), round(scale), round(height),
    round(nx * (Math.hypot(nx, nz) > 0.985 ? clamp : 1)),
    round(nz * (Math.hypot(nx, nz) > 0.985 ? clamp : 1)),
  ]);
}

const out = {
  meta: {
    version: VERSION,
    built: new Date().toISOString(),
    scene: input.split('/').pop(),
    material: MATERIAL,
    density: DENSITY,
    seed: SEED,
    axis: axis === 0 ? 'x' : 'z',
    cuts: cut.map((v) => round(v)),
    bands: BANDS,
    counts: perBand,
  },
  pieces: GRASS_PIECES,
  items,
};
writeFileSync(outPath, JSON.stringify(out));

console.log(`${MATERIAL}: ${faces.length} faces (${skipped} too steep), ${round(area, 1)} sq cells`);
console.log(`scattered ${items.length} tufts along ${out.meta.axis}, cuts ${out.meta.cuts.join(' / ')}`);
BANDS.forEach((b, i) => console.log(`  band ${i} ${b.padEnd(7)} ${perBand[i]}`));
GRASS_PIECES.forEach((p, i) => console.log(`  ${p} ${perPiece[i]}`));
console.log(`wrote ${outPath}`);
