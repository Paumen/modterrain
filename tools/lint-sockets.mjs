import { readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlacements } from './scene-cells.mjs';
import { readGlb, readAccessor, nodeWorldMatrices, transformPoint } from './glb.mjs';
import { buildIndex, raycast } from './ray.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ATOMS = join(ROOT, 'atoms');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const values = new Set(['assembly', 'json', 'limit', 'ocean', 'reach'].map((n) => option(n, null)).filter(Boolean));
const input = argv.find((a) => !a.startsWith('--') && !values.has(a));
if (!input) {
  console.error('usage: node tools/lint-sockets.mjs <scene.json | placements.json> [--assembly name] [--ocean y] [--reach cells] [--no-mirror] [--plain] [--verbose] [--limit n] [--json report.json]');
  process.exit(1);
}

const LIMIT = Number(option('limit', 25));
const OCEAN = option('ocean', null) === null ? -Infinity : Number(option('ocean'));
const REACH = Number(option('reach', 100));
const MIRROR = !flag('no-mirror');
const PLAIN = flag('plain');
const VERBOSE = flag('verbose');
const EPS = 0.02;
const LIFT = 0.01;
const FULL = 0.9;
const BAND = 0.25;
const PAIRS = [
  ['Hidden Orange', 'Hidden Violet'],
  ['Hidden Violet', 'Hidden Pink'],
  ['Hidden Violet', 'Hidden Blue'],
  ['Hidden Violet', 'Hidden Red'],
  ['Hidden Red', 'Hidden Green'],
  ['Hidden Yellow', 'Hidden Green'],
];
const ALLOWED = (socket, partner) => partner === socket.material
  || PAIRS.some(([a, b]) => (a === socket.material && b === partner) || (b === socket.material && a === partner));

function worldMatrix(matrix) {
  const sign = MIRROR ? [-1, 1, 1, 1] : [1, 1, 1, 1];
  return matrix.map((v, i) => v * sign[Math.floor(i / 4)] * sign[i % 4]);
}

const det3 = (m) => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
const apply = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];

const atomCache = new Map();
function atomTriangles(name) {
  if (atomCache.has(name)) return atomCache.get(name);
  let glb;
  try {
    glb = readGlb(join(ATOMS, `${name}.glb`));
  } catch {
    atomCache.set(name, null);
    return null;
  }
  const { json } = glb;
  const world = nodeWorldMatrices(json);
  const tris = [];
  json.nodes.forEach((node, index) => {
    if (node.mesh === undefined || !world[index]) return;
    for (const prim of json.meshes[node.mesh].primitives ?? []) {
      if ((prim.mode ?? 4) !== 4) continue;
      const material = json.materials?.[prim.material]?.name ?? '';
      const pos = readAccessor(glb, prim.attributes.POSITION);
      const idx = prim.indices !== undefined ? readAccessor(glb, prim.indices).data : null;
      const count = idx ? idx.length : pos.count;
      const at = (i) => transformPoint(world[index], pos.data[i * 3], pos.data[i * 3 + 1], pos.data[i * 3 + 2]);
      for (let t = 0; t + 2 < count; t += 3) {
        const a = idx ? idx[t] : t, b = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
        tris.push({ material, points: [at(a), at(b), at(c)] });
      }
    }
  });
  atomCache.set(name, tris);
  return tris;
}

const placements = loadPlacements(input, { assembly: option('assembly', null) });
const faces = [];
const missing = new Set();
const flat = [];
const flatMaterial = [];
const flatOwner = [];
let skewed = 0;

placements.forEach((placement, index) => {
  const tris = atomTriangles(placement.piece);
  if (!tris) {
    missing.add(placement.piece);
    return;
  }
  const m = worldMatrix(placement.matrix);
  const flip = det3(m) < 0 ? -1 : 1;
  for (const tri of tris) {
    const w = tri.points.map((p) => apply(m, p));
    for (const p of w) flat.push(p[0], p[1], p[2]);
    flatMaterial.push(tri.material);
    flatOwner.push(index);
    if (!tri.material.startsWith('Hidden')) continue;
    const plainOnly = tri.material === 'Hidden' && !PLAIN;
    const u = [w[1][0] - w[0][0], w[1][1] - w[0][1], w[1][2] - w[0][2]];
    const v = [w[2][0] - w[0][0], w[2][1] - w[0][1], w[2][2] - w[0][2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n);
    if (len < 1e-9) continue;
    n = n.map((x) => (x / len) * flip);
    const centroid = [0, 1, 2].map((k) => (w[0][k] + w[1][k] + w[2][k]) / 3);
    const samples = [centroid, ...w.map((p) => [0, 1, 2].map((k) => (p[k] * 2 + centroid[k]) / 3))];
    const face = { index, piece: placement.piece, material: tri.material, normal: n, centroid, samples, axis: -1, cover: new Map(), exposed: false, plainOnly };
    const axis = n.findIndex((x) => Math.abs(x) > 0.999);
    if (axis < 0) {
      skewed++;
    } else {
      const o = [0, 1, 2].filter((k) => k !== axis);
      const min = o.map((k) => Math.min(...w.map((p) => p[k])));
      const max = o.map((k) => Math.max(...w.map((p) => p[k])));
      const area = (max[0] - min[0]) * (max[1] - min[1]);
      if (area > 1e-6) Object.assign(face, { axis, coord: Math.round(w[0][axis] * 100) / 100, sign: Math.sign(n[axis]), min, max, area });
    }
    faces.push(face);
  }
});

const planes = new Map();
for (const face of faces) {
  if (face.axis < 0 || face.area === undefined) continue;
  const key = `${face.axis}:${face.coord}`;
  if (!planes.has(key)) planes.set(key, []);
  planes.get(key).push(face);
}
for (const list of planes.values()) {
  for (const a of list) {
    for (const b of list) {
      if (a.index === b.index || a.sign === b.sign) continue;
      const w = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
      const h = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
      if (w <= EPS || h <= EPS) continue;
      a.cover.set(b.material, (a.cover.get(b.material) ?? 0) + w * h);
    }
  }
}

const index = buildIndex(Float64Array.from(flat), 1);
const AZIMUTHS = [0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (deg * Math.PI) / 180);
const DIRECTIONS = [[0, 1, 0], [0, -1, 0]];
for (const elevation of [15, 40, 70]) {
  const up = Math.sin((elevation * Math.PI) / 180), flatLen = Math.cos((elevation * Math.PI) / 180);
  for (const a of AZIMUTHS) {
    DIRECTIONS.push([Math.cos(a) * flatLen, up, Math.sin(a) * flatLen]);
    DIRECTIONS.push([Math.cos(a) * flatLen, -up, Math.sin(a) * flatLen]);
  }
}
const CONE = 0.06;
const escapes = (p, d) => {
  if (raycast(index, p[0], p[1], p[2], d[0], d[1], d[2], REACH) !== Infinity) return false;
  return !(d[1] < 0 && OCEAN > -Infinity);
};
const wideOpen = (p, d) => {
  const side = Math.abs(d[1]) < 0.9 ? [-d[2], 0, d[0]] : [1, 0, 0];
  const lift = [d[1] * side[2] - d[2] * side[1], d[2] * side[0] - d[0] * side[2], d[0] * side[1] - d[1] * side[0]];
  for (const [a, b] of [[CONE, 0], [-CONE, 0], [0, CONE], [0, -CONE]]) {
    const q = [0, 1, 2].map((k) => d[k] + side[k] * a + lift[k] * b);
    const len = Math.hypot(...q);
    if (!escapes(p, q.map((v) => v / len))) return false;
  }
  return true;
};
const underwater = (p) => {
  if (p[1] <= OCEAN) return true;
  const t = raycast(index, p[0], p[1], p[2], 0, 1, 0, REACH);
  return t !== Infinity && flatMaterial[index.hit].startsWith('Water');
};
const triNormal = (t) => {
  const a = t * 9;
  const u = [flat[a + 3] - flat[a], flat[a + 4] - flat[a + 1], flat[a + 5] - flat[a + 2]];
  const v = [flat[a + 6] - flat[a], flat[a + 7] - flat[a + 1], flat[a + 8] - flat[a + 2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(...n);
  return len < 1e-9 ? null : n.map((x) => x / len);
};
const BUTT = 2e-3;
const butted = (face, p) => {
  const n = face.normal;
  for (let ix = index.bx(p[0] - 0.01); ix <= index.bx(p[0] + 0.01); ix++) {
    for (let iz = index.bz(p[2] - 0.01); iz <= index.bz(p[2] + 0.01); iz++) {
      for (const t of index.bins[iz * index.cols + ix]) {
        if (flatOwner[t] === face.index) continue;
        const a = t * 9;
        const m = triNormal(t);
        if (!m) continue;
        const raw = m[0] * n[0] + m[1] * n[1] + m[2] * n[2];
        if (Math.abs(raw) < 0.95) continue;
        const d = (p[0] - flat[a]) * m[0] + (p[1] - flat[a + 1]) * m[1] + (p[2] - flat[a + 2]) * m[2];
        if (Math.abs(d) > BUTT) continue;
        const q = [p[0] - d * m[0], p[1] - d * m[1], p[2] - d * m[2]];
        const v0 = [flat[a + 3] - flat[a], flat[a + 4] - flat[a + 1], flat[a + 5] - flat[a + 2]];
        const v1 = [flat[a + 6] - flat[a], flat[a + 7] - flat[a + 1], flat[a + 8] - flat[a + 2]];
        const v2 = [q[0] - flat[a], q[1] - flat[a + 1], q[2] - flat[a + 2]];
        const d00 = v0[0] * v0[0] + v0[1] * v0[1] + v0[2] * v0[2];
        const d01 = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2];
        const d11 = v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2];
        const d20 = v2[0] * v0[0] + v2[1] * v0[1] + v2[2] * v0[2];
        const d21 = v2[0] * v1[0] + v2[1] * v1[1] + v2[2] * v1[2];
        const den = d00 * d11 - d01 * d01;
        if (Math.abs(den) < 1e-12) continue;
        const bv = (d11 * d20 - d01 * d21) / den;
        const bw = (d00 * d21 - d01 * d20) / den;
        if (bv >= -1e-3 && bw >= -1e-3 && bv + bw <= 1 + 1e-3) return true;
      }
    }
  }
  return false;
};
for (const face of faces) {
  if (face.plainOnly) continue;
  const n = face.normal;
  const dirs = [n, ...DIRECTIONS.filter((d) => d[0] * n[0] + d[1] * n[1] + d[2] * n[2] > 0.05)];
  for (const s of face.samples) {
    if (butted(face, s)) continue;
    const p = [s[0] + n[0] * LIFT, s[1] + n[1] * LIFT, s[2] + n[2] * LIFT];
    if (underwater(p)) continue;
    const open = dirs.find((d) => escapes(p, d));
    if (!open) continue;
    if (wideOpen(p, open)) {
      face.exposed = true;
      face.open = open;
      face.openAt = p;
      break;
    }
    face.crack = true;
  }
}

const columns = new Set();
for (let t = 0; t < flat.length; t += 9) {
  const xs = [flat[t], flat[t + 3], flat[t + 6]], zs = [flat[t + 2], flat[t + 5], flat[t + 8]];
  for (let x = Math.floor(Math.min(...xs) + 1e-3); x <= Math.floor(Math.max(...xs) - 1e-3); x++) {
    for (let z = Math.floor(Math.min(...zs) + 1e-3); z <= Math.floor(Math.max(...zs) - 1e-3); z++) columns.add(`${x},${z}`);
  }
}
const leavesScene = (p, d) => {
  const len = Math.hypot(d[0], d[2]);
  if (len < 1e-6) return false;
  for (let t = 1.2; t < REACH; t += 0.25) {
    if (columns.has(`${Math.floor(p[0] + (d[0] / len) * t)},${Math.floor(p[2] + (d[2] / len) * t)}`)) return false;
  }
  return true;
};
for (const face of faces) if (face.exposed) face.edge = leavesScene(face.openAt, face.open);

const sockets = new Map();
for (const face of faces) {
  if (face.plainOnly || face.material === 'Hidden' || face.axis < 0 || face.area === undefined) continue;
  const key = `${face.index}|${face.material}|${face.axis}|${face.coord}|${face.sign}`;
  const s = sockets.get(key) ?? sockets.set(key, { index: face.index, piece: face.piece, material: face.material, axis: face.axis, coord: face.coord, sign: face.sign, faces: [], area: 0, top: -Infinity }).get(key);
  s.faces.push(face);
  s.area += face.area;
  if (face.axis !== 1) s.top = Math.max(s.top, face.max[0]);
}
const judge = (s) => {
  const total = new Map();
  for (const face of s.faces) for (const [m, a] of face.cover) total.set(m, (total.get(m) ?? 0) + a);
  const fraction = (m) => (total.get(m) ?? 0) / s.area;
  for (const [m] of total) if (fraction(m) >= FULL && ALLOWED(s, m)) return { state: 'paired', partner: m };
  if (s.material === 'Hidden Orange' && s.axis !== 1) {
    const band = s.faces.filter((f) => f.min[0] >= s.top - BAND - 0.01);
    const bandArea = band.reduce((sum, f) => sum + f.area, 0);
    const violet = band.reduce((sum, f) => sum + (f.cover.get('Hidden Violet') ?? 0), 0);
    if (bandArea > 0 && violet / bandArea >= FULL) return { state: 'paired', partner: 'Hidden Violet (top band)' };
  }
  for (const [m] of total) if (m !== 'Hidden' && fraction(m) >= FULL) return { state: 'wrong', partner: m };
  return { state: s.faces.some((f) => f.exposed) ? 'exposed' : 'buried', partner: null };
};
const perMaterial = new Map();
const perPiece = new Map();
const wrongPairs = new Map();
const wrongSockets = [];
const stat = (map, key) => {
  if (!map.has(key)) map.set(key, { sockets: 0, paired: 0, buried: 0, wrong: 0, faces: 0, cracked: 0, exposed: 0 });
  return map.get(key);
};
for (const s of sockets.values()) {
  const verdict = judge(s);
  s.verdict = verdict;
  for (const st of [stat(perMaterial, s.material), stat(perPiece, s.piece)]) {
    st.sockets++;
    if (verdict.state === 'paired') st.paired++;
    if (verdict.state === 'buried') st.buried++;
    if (verdict.state === 'wrong') st.wrong++;
  }
  if (verdict.state === 'wrong') {
    wrongSockets.push(s);
    const key = `${s.material} on ${s.piece} covered by ${verdict.partner}`;
    wrongPairs.set(key, (wrongPairs.get(key) ?? 0) + 1);
  }
}
for (const face of faces) {
  if (face.plainOnly) continue;
  for (const st of [stat(perMaterial, face.material), stat(perPiece, face.piece)]) {
    st.faces++;
    if (face.exposed) st.exposed++;
    else if (face.crack) st.cracked++;
  }
}
const exposed = faces.filter((f) => f.exposed);
const atEdge = exposed.filter((f) => f.edge).length;

const placementCenter = (i) => {
  const m = worldMatrix(placements[i].matrix);
  return [m[3], m[7], m[11]].map((v) => Math.round(v * 100) / 100);
};
const round = (v) => Math.round(v * 100) / 100;
const pad = (s, n) => String(s).padEnd(n);
const label = `${basename(input)}${option('assembly', '') ? ` [${option('assembly', '')}]` : ''}`;

const tested = faces.filter((f) => !f.plainOnly);
console.log(`${label}: ${placements.length} placements, ${flatMaterial.length} triangles, ${tested.length} socket faces (${skewed} not axis aligned)`);
if (missing.size) console.log(`  not in atoms/: ${[...missing].join(', ')}`);
const cracked = faces.filter((f) => f.crack && !f.exposed).length;
console.log(`\nexposed hidden faces: ${exposed.length}  (open to the sky or the horizon through a gap wider than a hairline; the real errors)`);
console.log(`  at an open edge of the scene: ${atEdge}  (nothing stands in the escaping ray's direction: a cut-out scene simply ends there)`);
console.log(`hairline cracks: ${cracked}  (a hidden face reachable only through a sub-0.06-cell gap; informational)`);
console.log(`wrong-colour sockets: ${wrongSockets.length}  (a coloured socket fully covered by a colour the kit does not pair it with)`);
console.log('\nper socket colour           sockets  paired  buried  wrong | faces  cracked  exposed');
for (const [material, s] of [...perMaterial].sort((a, b) => b[1].faces - a[1].faces)) {
  console.log(`  ${pad(material, 24)} ${pad(s.sockets, 8)} ${pad(s.paired, 7)} ${pad(s.buried, 7)} ${pad(s.wrong, 5)} | ${pad(s.faces, 6)} ${pad(s.cracked, 8)} ${s.exposed}`);
}
if (wrongPairs.size) {
  console.log(`\nwrong-colour pairings (top ${LIMIT})`);
  for (const [key, n] of [...wrongPairs].sort((a, b) => b[1] - a[1]).slice(0, LIMIT)) console.log(`  ${pad(n, 6)} ${key}`);
}
const worst = [...perPiece].filter(([, s]) => s.exposed).sort((a, b) => b[1].exposed - a[1].exposed);
if (worst.length) {
  console.log(`\nexposed by piece (top ${LIMIT})`);
  for (const [piece, s] of worst.slice(0, LIMIT)) console.log(`  ${pad(s.exposed, 6)} of ${pad(s.faces, 6)} ${piece}`);
}
if (VERBOSE && exposed.length) {
  console.log('\nexposed faces');
  const seen = new Set();
  for (const face of exposed) {
    const key = `${face.index}|${face.material}|${face.axis}|${face.coord}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dir = face.axis >= 0 ? `${face.sign > 0 ? '+' : '-'}${'xyz'[face.axis]} at ${'xyz'[face.axis]}=${face.coord}` : `n=(${face.normal.map(round).join(',')})`;
    console.log(`  #${face.index} ${face.piece} at ${placementCenter(face.index).join(',')}  ${face.material} facing ${dir}  near ${face.centroid.map(round).join(',')}  open towards (${face.open.map(round).join(',')})${face.edge ? '  [scene edge]' : ''}`);
  }
}

if (VERBOSE && wrongSockets.length) {
  console.log('\nwrong-colour sockets');
  for (const s of wrongSockets) {
    const o = [0, 1, 2].filter((k) => k !== s.axis);
    const c = [0, 0, 0];
    c[s.axis] = s.coord;
    c[o[0]] = (Math.min(...s.faces.map((f) => f.min[0])) + Math.max(...s.faces.map((f) => f.max[0]))) / 2;
    c[o[1]] = (Math.min(...s.faces.map((f) => f.min[1])) + Math.max(...s.faces.map((f) => f.max[1]))) / 2;
    console.log(`  #${s.index} ${s.piece} at ${placementCenter(s.index).join(',')}  ${s.material} facing ${s.sign > 0 ? '+' : '-'}${'xyz'[s.axis]} near ${c.map(round).join(',')}  covered by ${s.verdict.partner}`);
  }
}

const report = option('json', null);
if (report) {
  writeFileSync(report, JSON.stringify({
    input: label,
    placements: placements.length,
    triangles: flatMaterial.length,
    faces: faces.length,
    cracked,
    atEdge,
    missing: [...missing],
    materials: Object.fromEntries(perMaterial),
    wrongColour: wrongSockets.map((s) => ({ placement: s.index, piece: s.piece, at: placementCenter(s.index), material: s.material, partner: s.verdict.partner })),
    sockets: Object.fromEntries(perMaterial),
    socketList: [...sockets.values()].map((s) => ({
      placement: s.index, piece: s.piece, material: s.material,
      axis: s.axis, coord: s.coord, sign: s.sign,
      state: s.verdict.state, partner: s.verdict.partner,
    })),
    exposed: exposed.map((f) => ({
      placement: f.index, piece: f.piece, at: placementCenter(f.index), material: f.material,
      normal: f.normal.map(round), near: f.centroid.map(round), open: f.open.map(round), edge: f.edge,
    })),
  }, null, 2));
  console.log(`\nreport written to ${report}`);
}

process.exitCode = exposed.length || wrongSockets.length ? 1 : 0;
