import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, readAccessor, nodeWorldMatrices, transformPoint } from './glb.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ATOMS = join(ROOT, 'atoms');
const OUT = join(ROOT, 'catalog', 'sockets.json');
const SKIP = /^(Docks_|Prop_)/;

const r4 = (v) => Math.round(v * 10000) / 10000;
const near = (a, b) => Math.abs(a - b) < 1e-3;

function atomFaces(file) {
  const glb = readGlb(join(ATOMS, file));
  const { json } = glb;
  const world = nodeWorldMatrices(json);
  const out = [];
  json.nodes.forEach((node, i) => {
    if (node.mesh === undefined || !world[i]) return;
    for (const prim of json.meshes[node.mesh].primitives ?? []) {
      if ((prim.mode ?? 4) !== 4) continue;
      const material = json.materials?.[prim.material]?.name ?? '';
      const pos = readAccessor(glb, prim.attributes.POSITION);
      const idx = prim.indices !== undefined ? readAccessor(glb, prim.indices).data : null;
      const count = idx ? idx.length : pos.count;
      const at = (k) => transformPoint(world[i], pos.data[k * 3], pos.data[k * 3 + 1], pos.data[k * 3 + 2]);
      for (let t = 0; t + 2 < count; t += 3) {
        const a = idx ? idx[t] : t, b = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
        out.push({ material, points: [at(a), at(b), at(c)] });
      }
    }
  });
  return out;
}

const pieces = {};
for (const file of readdirSync(ATOMS).filter((f) => f.endsWith('.glb')).sort()) {
  const name = file.slice(0, -4);
  if (SKIP.test(name)) continue;
  const tris = atomFaces(file);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const groups = new Map();
  const skewed = {};
  for (const tri of tris) {
    for (const p of tri.points) for (const k of [0, 1, 2]) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
    if (!tri.material.startsWith('Hidden ')) continue;
    const [p0, p1, p2] = tri.points;
    const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const v = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n);
    if (len < 1e-9) continue;
    const axis = n.findIndex((x) => Math.abs(x / len) > 0.999);
    if (axis < 0) {
      skewed[tri.material] = r4((skewed[tri.material] ?? 0) + len / 2);
      continue;
    }
    const sign = Math.sign(n[axis]);
    const coord = r4(p0[axis]);
    const lat = axis === 1 ? 0 : (axis === 0 ? 2 : 0);
    const alt = axis === 1 ? 2 : 1;
    const key = `${tri.material}|${axis}|${sign}|${coord}`;
    if (!groups.has(key)) groups.set(key, { material: tri.material, axis, sign, coord, tris: [], area: 0 });
    const g = groups.get(key);
    g.tris.push(tri.points.flatMap((p) => [r4(p[lat]), r4(p[alt])]));
    g.area = r4(g.area + len / 2);
  }

  const sockets = [];
  for (const g of groups.values()) {
    const us = g.tris.flatMap((t) => [t[0], t[2], t[4]]);
    const vs = g.tris.flatMap((t) => [t[1], t[3], t[5]]);
    const span = [r4(Math.min(...us)), r4(Math.max(...us))];
    const range = [r4(Math.min(...vs)), r4(Math.max(...vs))];
    const socket = { socket: g.material.slice(7), axis: g.axis, sign: g.sign, coord: g.coord, area: g.area, tris: g.tris };
    if (g.axis === 1) {
      socket.side = g.sign > 0 ? '+y' : '-y';
      socket.span = span;
      socket.depth = range;
    } else {
      socket.side = `${g.sign > 0 ? '+' : '-'}${g.axis === 0 ? 'x' : 'z'}`;
      socket.span = span;
      socket.y = range;
      const c = g.coord - g.sign * 0.5;
      socket.cell = near(c, Math.round(c)) ? Math.round(c) : null;
      socket.spansCells = near(span[0] - 0.5, Math.round(span[0] - 0.5)) && near(span[1] - 0.5, Math.round(span[1] - 0.5));
    }
    sockets.push(socket);
  }
  sockets.sort((a, b) => a.socket.localeCompare(b.socket) || a.axis - b.axis || a.coord - b.coord);

  const cells = [];
  for (let x = Math.round(min[0] + 0.5); x <= Math.round(max[0] - 0.5); x++) {
    for (let z = Math.round(min[2] + 0.5); z <= Math.round(max[2] - 0.5); z++) cells.push([x, z]);
  }
  pieces[name] = { min: min.map(r4), max: max.map(r4), cells, sockets };
  if (Object.keys(skewed).length) pieces[name].skewed = skewed;
}

writeFileSync(OUT, `${JSON.stringify({
  generated: 'node tools/build-sockets.mjs',
  note: 'Coloured sockets per piece, in the piece\'s own frame. Cell (0,0) is the origin cell, spanning -0.5..0.5. Props and docks are excluded. tris are the exact 2D profile in the socket plane: for a vertical socket (u = the lateral axis, v = height), for a horizontal one (u = x, v = z).',
  skipped: SKIP.source,
  pieces,
}, null, 1)}\n`);

const all = Object.values(pieces);
const vertical = all.flatMap((p) => p.sockets.filter((s) => s.axis !== 1));
console.log(`${all.length} pieces, ${all.reduce((n, p) => n + p.sockets.length, 0)} coloured sockets`);
console.log(`  vertical: ${vertical.length}, of which ${vertical.filter((s) => s.cell === null).length} not on a cell edge and ${vertical.filter((s) => !s.spansCells).length} not spanning whole cell edges`);
console.log(`  pieces with skewed coloured faces the table cannot hold: ${all.filter((p) => p.skewed).length}`);
console.log(`written to ${OUT}`);
