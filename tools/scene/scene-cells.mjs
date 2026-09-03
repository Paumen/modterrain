import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'modterrain-cells-1';

const argv = process.argv.slice(2);
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const flag = (n) => argv.includes(`--${n}`);
const option = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const taken = new Set(['out', 'snap', 'assembly'].map((n) => option(n, null)).filter(Boolean));
const input = argv.find((a) => !a.startsWith('--') && !taken.has(a));
if (isMain && !input) {
  console.error('usage: node tools/scene/scene-cells.mjs <scene.json | cells.json> [--to-dump] [--out file.json] [--verify] [--snap cells]');
  process.exit(1);
}

const SNAP = Number(option('snap', 0.01));
const C = [-1, 1, 1, 1];
const conjugate = (m) => m.map((v, i) => v * C[Math.floor(i / 4)] * C[i % 4]);
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const snapTo = (v, step) => Math.round(v / step) * step;

export function toCells(matrix, snap = 0.01) {
  const W = conjugate(matrix);
  const c0 = [W[0], W[4], W[8]], c1 = [W[1], W[5], W[9]], c2 = [W[2], W[6], W[10]];
  const len = (v) => Math.hypot(...v);
  const sx = len(c0), sy = len(c1), sz = len(c2);
  if (sx < 1e-9 || sy < 1e-9 || sz < 1e-9) return null;
  if (Math.abs(sy - 1) > 1e-3) return null;
  if (Math.abs(c1[0]) > 1e-4 || Math.abs(c1[2]) > 1e-4 || Math.abs(W[1]) > 1e-4 || Math.abs(W[9]) > 1e-4) return null;

  const u2 = c2.map((v) => v / sz);
  const theta = Math.atan2(u2[0], u2[2]) * 180 / Math.PI;
  const rot = ((Math.round(theta / 90) * 90) % 360 + 360) % 360;
  if (Math.abs(theta - Math.round(theta / 90) * 90) > 0.01) return null;

  const rad = rot * Math.PI / 180;
  const cos = Math.round(Math.cos(rad)), sin = Math.round(Math.sin(rad));
  const mirror = (c0[0] * cos + c0[2] * -sin) / sx < 0;

  const stretch = [sx, sz].map((s) => Math.round(s));
  if (stretch.some((s, i) => s < 1 || Math.abs([sx, sz][i] - s) > 1e-3)) return null;

  const at = [snapTo(W[3], 0.5), snapTo(W[7], 0.25), snapTo(W[11], 0.5)];
  const drift = Math.max(Math.abs(W[3] - at[0]), Math.abs(W[7] - at[1]), Math.abs(W[11] - at[2]));
  if (drift > snap) return null;
  return { at: at.map(r6), rot, mirror, stretch, drift };
}

export function toMatrix({ at, rot = 0, mirror = false, stretch = [1, 1] }) {
  const rad = (rot * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad)), sin = Math.round(Math.sin(rad));
  const ax = (mirror ? -1 : 1) * stretch[0];
  const W = [
    cos * ax, 0, sin * stretch[1], at[0],
    0, 1, 0, at[1],
    -sin * ax, 0, cos * stretch[1], at[2],
    0, 0, 0, 1,
  ];
  return conjugate(W);
}

export const PIVOTS = {
  Prop_Bridge_Rope_End_Basic_1x3: [0, 0, 0.5],
  Prop_Bridge_Rope_Middle_Basic_1x1: [0, 0, 0.5],
  Prop_Bridge_Rope_Middle_Cracked_1_1x1: [0, 0, 0.5],
  Prop_Bridge_Rope_Middle_Cracked_2_1x1: [0, 0, 0.5],
};

export const onPivot = (piece, matrix) => {
  const offset = PIVOTS[piece];
  if (!offset) return matrix;
  const out = [...matrix];
  for (let row = 0; row < 3; row++) {
    out[row * 4 + 3] += offset.reduce((sum, cell, axis) => sum + cell * matrix[row * 4 + axis], 0);
  }
  return out;
};

export function loadPlacements(path, { assembly = null, pivots = true } = {}) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const pivot = pivots ? onPivot : (piece, matrix) => matrix;
  if (data.format === FORMAT) {
    return data.pieces.map((p) => ({ piece: p.piece, matrix: pivot(p.piece, p.matrix ?? toMatrix(p)) }));
  }
  if (data.pieces) return data.pieces.map(({ prefab, matrix }) => ({ piece: prefab, matrix: pivot(prefab, matrix) }));
  const assemblies = data.assemblies ?? data;
  const names = Object.keys(assemblies);
  const name = assembly ?? (names.length === 1 ? names[0] : null);
  if (!name) throw new Error(`${basename(path)} holds ${names.length} assemblies; pick one with --assembly <name>`);
  const list = assemblies[name];
  if (!list) throw new Error(`no assembly named ${name}`);
  return list.map((p) => ({ piece: p.piece, matrix: p.matrix ?? quatMatrix(p.pos, p.quat, p.scale) }));
}

export function quatMatrix(pos, quat, scale) {
  const [qx, qy, qz, qw] = quat, [sx, sy, sz] = scale;
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy - wz) * sy, (xz + wy) * sz, pos[0],
    (xy + wz) * sx, (1 - (xx + zz)) * sy, (yz - wx) * sz, pos[1],
    (xz - wy) * sx, (yz + wx) * sy, (1 - (xx + yy)) * sz, pos[2],
    0, 0, 0, 1,
  ];
}

if (isMain) {
  if (flag('to-dump')) {
    const data = JSON.parse(readFileSync(input, 'utf8'));
    if (data.format !== FORMAT) throw new Error(`${basename(input)} is not ${FORMAT}`);
    const pieces = [
      ...data.pieces.map((p) => ({ prefab: p.piece, matrix: toMatrix(p) })),
      ...(data.raw ?? []).map((p) => ({ prefab: p.piece, matrix: p.matrix })),
    ];
    const out = { source: data.source, note: data.note, leaf_count: pieces.length, pieces };
    const path = option('out', null);
    if (path) writeFileSync(path, `${JSON.stringify(out, null, 1)}\n`);
    console.log(`${basename(input)} -> ${pieces.length} placements${path ? ` -> ${path}` : ''}`);
    process.exit(0);
  }

  const placements = loadPlacements(input, { assembly: option('assembly', null), pivots: false });
  const pieces = [];
  let raw = 0;
  let worst = 0;
  for (const { piece, matrix } of placements) {
    const cells = toCells(matrix, SNAP);
    if (!cells) { pieces.push({ piece, matrix }); raw++; continue; }
    const { drift, ...rest } = cells;
    worst = Math.max(worst, drift);
    pieces.push({ piece, ...rest });
  }
  const source = JSON.parse(readFileSync(input, 'utf8'));
  const out = {
    format: FORMAT,
    note: 'Cells, right-handed: +x east, +z north, +y up. at is the piece origin in cells (x and z on the half grid, y on the quarter grid). rot is degrees counter-clockwise about +y seen from above. mirror reflects the piece across its own x before rotating. stretch is [x, z] whole-number factors. An entry carrying matrix instead is an escape, placed freely, in glTF space; placement order is the scene order either way.',
    source: source.source ?? basename(input),
    pieces,
  };
  const path = option('out', null);
  if (path) writeFileSync(path, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`${basename(input)}: ${pieces.length - raw} placements as cells, ${raw} kept as raw matrices`);
  console.log(`  largest snap onto the grid: ${worst.toFixed(4)} cells (tolerance ${SNAP})`);
  if (raw) {
    const by = new Map();
    for (const p of pieces) if (p.matrix) by.set(p.piece, (by.get(p.piece) ?? 0) + 1);
    console.log(`  raw: ${[...by].map(([k, n]) => `${k} x${n}`).join(', ')}`);
  }

  if (flag('verify')) {
    let bad = 0, maxDelta = 0;
    placements.forEach(({ matrix }, i) => {
      const cells = toCells(matrix, SNAP);
      if (!cells) return;
      const back = toMatrix(cells);
      const delta = Math.max(...matrix.map((v, k) => Math.abs(v - back[k])));
      maxDelta = Math.max(maxDelta, delta);
      if (delta > SNAP) bad++;
    });
    console.log(`  round trip: largest difference ${maxDelta.toFixed(6)} over ${pieces.length - raw} placements, ${bad} beyond tolerance`);
    process.exitCode = bad ? 1 : 0;
  }
  if (path) console.log(`  written to ${path}`);
}
