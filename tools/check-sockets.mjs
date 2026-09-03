import { readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORMAT as CELLS_FORMAT, toMatrix as cellsToMatrix } from './scene-cells.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TABLE = JSON.parse(readFileSync(join(ROOT, 'catalog', 'sockets.json'), 'utf8'));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const option = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const taken = new Set(['assembly', 'limit', 'json'].map((n) => option(n, null)).filter(Boolean));
const input = argv.find((a) => !a.startsWith('--') && !taken.has(a));
if (!input) {
  console.error('usage: node tools/check-sockets.mjs <scene.json | placements.json> [--assembly name] [--no-mirror] [--verbose] [--limit n]');
  process.exit(1);
}
const MIRROR = !flag('no-mirror');
const VERBOSE = flag('verbose');
const LIMIT = Number(option('limit', 25));
const FULL = 0.9;
const BAND = 0.25;
const PAIRS = [
  ['Orange', 'Violet'], ['Violet', 'Pink'], ['Violet', 'Blue'],
  ['Violet', 'Red'], ['Red', 'Green'], ['Yellow', 'Green'],
];
const allowed = (a, b) => a === b || PAIRS.some(([x, y]) => (x === a && y === b) || (y === a && x === b));

const PIVOTS = {
  Prop_Bridge_Rope_End_Basic_1x3: [0, 0, 0.5],
  Prop_Bridge_Rope_Middle_Basic_1x1: [0, 0, 0.5],
  Prop_Bridge_Rope_Middle_Cracked_1_1x1: [0, 0, 0.5],
  Prop_Bridge_Rope_Middle_Cracked_2_1x1: [0, 0, 0.5],
};
const onPivot = (piece, m) => {
  const o = PIVOTS[piece];
  if (!o) return m;
  const out = [...m];
  for (let row = 0; row < 3; row++) out[row * 4 + 3] += o.reduce((s, c, a) => s + c * m[row * 4 + a], 0);
  return out;
};
function quatMatrix(pos, quat, scale) {
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
function loadPlacements(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.format === CELLS_FORMAT) {
    return data.pieces.map((p) => ({ piece: p.piece, matrix: onPivot(p.piece, p.matrix ?? cellsToMatrix(p)) }));
  }
  if (data.pieces) return data.pieces.map(({ prefab, matrix }) => ({ piece: prefab, matrix: onPivot(prefab, matrix) }));
  const assemblies = data.assemblies ?? data;
  const names = Object.keys(assemblies);
  const name = option('assembly', names.length === 1 ? names[0] : null);
  if (!name) throw new Error(`${basename(path)} holds ${names.length} assemblies; pick one with --assembly <name>`);
  return assemblies[name].map((p) => ({ piece: p.piece, matrix: p.matrix ?? quatMatrix(p.pos, p.quat, p.scale) }));
}
const worldMatrix = (m) => {
  const s = MIRROR ? [-1, 1, 1, 1] : [1, 1, 1, 1];
  return m.map((v, i) => v * s[Math.floor(i / 4)] * s[i % 4]);
};
const apply = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];
const det3 = (m) => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
const r2 = (v) => Math.round(v * 100) / 100;

const area2 = (poly) => {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};
const ccw = (t) => (area2(t) < 0 ? [...t].reverse() : t);
function clipEdge(poly, x1, y1, x2, y2) {
  const inside = ([x, y]) => (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1) >= -1e-9;
  const next = [];
  for (let k = 0; k < poly.length; k++) {
    const cur = poly[k], prev = poly[(k + poly.length - 1) % poly.length];
    const ci = inside(cur), pi = inside(prev);
    if (ci !== pi) {
      const d1 = (x2 - x1) * (prev[1] - y1) - (y2 - y1) * (prev[0] - x1);
      const d2 = (x2 - x1) * (cur[1] - y1) - (y2 - y1) * (cur[0] - x1);
      const t = d1 / (d1 - d2);
      next.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]);
    }
    if (ci) next.push(cur);
  }
  return next;
}
const above = (poly, y) => (poly.length < 3 ? poly : clipEdge(ccw(poly), -1e6, y, 1e6, y));
function clipOverlap(a, b) {
  let poly = ccw(a);
  const q = ccw(b);
  for (let i = 0; i < q.length && poly.length; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % q.length];
    poly = clipEdge(poly, x1, y1, x2, y2);
  }
  return poly.length < 3 ? 0 : Math.abs(area2(poly));
}

const placements = loadPlacements(input);
const world = [];
const missing = new Set();
placements.forEach((placement, index) => {
  const entry = TABLE.pieces[placement.piece];
  if (!entry) { missing.add(placement.piece); return; }
  const m = worldMatrix(placement.matrix);
  const flip = det3(m) < 0 ? -1 : 1;
  for (const s of entry.sockets) {
    if (s.axis === 1) continue;
    const lat = s.axis === 0 ? 2 : 0;
    const out = { index, piece: placement.piece, socket: s.socket, tris: [], area: 0 };
    for (const t of s.tris) {
      const pts = [0, 1, 2].map((k) => {
        const p = [0, 0, 0];
        p[s.axis] = s.coord;
        p[lat] = t[k * 2];
        p[1] = t[k * 2 + 1];
        return apply(m, p);
      });
      const u = [0, 1, 2].map((k) => pts[1][k] - pts[0][k]);
      const v = [0, 1, 2].map((k) => pts[2][k] - pts[0][k]);
      const raw = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(...raw);
      if (len < 1e-9) continue;
      const n = raw.map((x) => x * flip);
      const axis = n.findIndex((x) => Math.abs(x / len) > 0.999);
      if (axis < 0) continue;
      const wlat = axis === 0 ? 2 : 0;
      out.axis = axis;
      out.sign = Math.sign(n[axis]);
      out.coord = Math.round(pts[0][axis] * 100) / 100;
      out.tris.push(pts.map((p) => [p[wlat], p[1]]));
      out.area += len / 2;
    }
    if (out.tris.length) {
      out.top = Math.max(...out.tris.flat().map((p) => p[1]));
      world.push(out);
    }
  }
});

const planes = new Map();
for (const s of world) {
  const key = `${s.axis}:${s.coord}`;
  if (!planes.has(key)) planes.set(key, []);
  planes.get(key).push(s);
}
for (const list of planes.values()) {
  for (const a of list) {
    a.cover = a.cover ?? new Map();
    a.band = a.band ?? new Map();
    for (const b of list) {
      if (a.index === b.index || a.sign === b.sign) continue;
      const lo = a.top - BAND;
      for (const ta of a.tris) for (const tb of b.tris) {
        const o = clipOverlap(ta, tb);
        if (o <= 1e-9) continue;
        a.cover.set(b.socket, (a.cover.get(b.socket) ?? 0) + o);
        const band = above(clipEdge(ccw(ta), -1e6, lo, 1e6, lo), lo);
        if (band.length >= 3) {
          const inBand = clipOverlap(band, tb);
          if (inBand > 1e-9) a.band.set(b.socket, (a.band.get(b.socket) ?? 0) + inBand);
        }
      }
    }
  }
}

const bandArea = (s) => s.tris.reduce((n, t) => {
  const clipped = above(t, s.top - BAND);
  return n + (clipped.length < 3 ? 0 : Math.abs(area2(clipped)));
}, 0);
const judge = (s) => {
  const frac = (m) => (s.cover.get(m) ?? 0) / s.area;
  for (const [m] of s.cover) if (frac(m) >= FULL && allowed(s.socket, m)) return { state: 'paired', partner: m };
  if (s.socket === 'Orange') {
    const ba = bandArea(s);
    if (ba > 0 && (s.band.get('Violet') ?? 0) / ba >= FULL) return { state: 'paired', partner: 'Violet (top band)' };
  }
  for (const [m] of s.cover) if (frac(m) >= FULL) return { state: 'wrong', partner: m };
  return { state: 'open', partner: null };
};

const per = new Map();
const wrong = [];
for (const s of world) {
  s.verdict = judge(s);
  if (!per.has(s.socket)) per.set(s.socket, { n: 0, paired: 0, open: 0, wrong: 0 });
  const st = per.get(s.socket);
  st.n++;
  st[s.verdict.state === 'paired' ? 'paired' : s.verdict.state === 'wrong' ? 'wrong' : 'open']++;
  if (s.verdict.state === 'wrong') wrong.push(s);
}
const centre = (i) => {
  const m = worldMatrix(placements[i].matrix);
  return [m[3], m[7], m[11]].map(r2);
};
const pad = (s, n) => String(s).padEnd(n);
console.log(`${basename(input)}: ${placements.length} placements, ${world.length} coloured sockets (table only, no geometry)`);
if (missing.size) console.log(`  not in the socket table: ${[...missing].join(', ')}`);
console.log('\nsocket      total  paired  unpaired  wrong');
for (const [k, s] of [...per].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${pad(k, 9)} ${pad(s.n, 6)} ${pad(s.paired, 7)} ${pad(s.open, 9)} ${s.wrong}`);
}
const totals = [...per.values()].reduce((a, s) => ({ n: a.n + s.n, paired: a.paired + s.paired, open: a.open + s.open, wrong: a.wrong + s.wrong }), { n: 0, paired: 0, open: 0, wrong: 0 });
console.log(`  ${pad('all', 9)} ${pad(totals.n, 6)} ${pad(totals.paired, 7)} ${pad(totals.open, 9)} ${totals.wrong}`);
if (wrong.length) {
  const by = new Map();
  for (const s of wrong) {
    const k = `${s.socket} on ${s.piece} covered by ${s.verdict.partner}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  console.log(`\nwrong-colour pairings (top ${LIMIT})`);
  for (const [k, n] of [...by].sort((a, b) => b[1] - a[1]).slice(0, LIMIT)) console.log(`  ${pad(n, 6)} ${k}`);
  if (VERBOSE) {
    console.log('\nwrong-colour sockets');
    for (const s of wrong) console.log(`  #${s.index} ${s.piece} at ${centre(s.index).join(',')}  ${s.socket} facing ${s.sign > 0 ? '+' : '-'}${'xyz'[s.axis]} at ${'xyz'[s.axis]}=${s.coord}  covered by ${s.verdict.partner}`);
  }
}
const report = option('json', null);
if (report) {
  writeFileSync(report, `${JSON.stringify({
    input: basename(input),
    placements: placements.length,
    missing: [...missing],
    materials: Object.fromEntries(per),
    socketList: world.map((s) => ({
      placement: s.index, piece: s.piece, material: `Hidden ${s.socket}`,
      axis: s.axis, coord: s.coord, sign: s.sign,
      state: s.verdict.state, partner: s.verdict.partner,
    })),
  }, null, 2)}\n`);
  console.log(`\nreport written to ${report}`);
}
if (flag('open')) {
  const list = world.filter((s) => s.verdict.state === 'open');
  console.log(`\nunpaired sockets (top ${LIMIT})`);
  for (const s of list.slice(0, LIMIT)) {
    const best = [...s.cover].map(([m, a]) => `${m} ${(a / s.area).toFixed(2)}`).join(', ') || 'nothing on the other side';
    const us = s.tris.flat();
    const u = [Math.min(...us.map((p) => p[0])), Math.max(...us.map((p) => p[0]))].map(r2);
    const y = [Math.min(...us.map((p) => p[1])), Math.max(...us.map((p) => p[1]))].map(r2);
    console.log(`  #${s.index} ${s.piece} at ${centre(s.index).join(',')}  ${s.socket} facing ${s.sign > 0 ? '+' : '-'}${'xyz'[s.axis]} at ${'xyz'[s.axis]}=${s.coord} spanning ${'xyz'[s.axis === 0 ? 2 : 0]} ${u.join('..')} y ${y.join('..')}  <- ${best}`);
  }
}
process.exitCode = wrong.length ? 1 : 0;
