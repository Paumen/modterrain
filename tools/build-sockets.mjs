import { readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, readAccessor } from './glb.mjs';
import { socketFaces } from './sockets.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'catalog', 'sockets.json');

/* Sampling pitch along a seam: finer than any feature in the pack, coarse
 * enough that two pieces meant to mate sample identically. */
const STEP = 1 / 64;
const QUANT = 256;

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const round = (v) => Math.round(v * 512) / 512;
const area = (t) => Math.hypot(...cross(sub(t[1], t[0]), sub(t[2], t[0]))) / 2;

/* Vertical extent of a face at one position along its seam, as merged
 * intervals. Reading the profile this way rather than triangle by triangle
 * makes it independent of how either piece chose to tessellate. */
function columnAt(triangles, u) {
  const spans = [];
  for (const triangle of triangles) {
    const hits = [];
    for (let i = 0; i < 3; i++) {
      const a = triangle[i];
      const b = triangle[(i + 1) % 3];
      if ((a[0] <= u && b[0] > u) || (b[0] <= u && a[0] > u)) {
        hits.push(a[1] + (b[1] - a[1]) * ((u - a[0]) / (b[0] - a[0])));
      }
    }
    if (hits.length >= 2) spans.push([Math.min(...hits), Math.max(...hits)]);
  }
  if (!spans.length) return null;

  spans.sort((a, b) => a[0] - b[0]);
  const merged = [spans[0].slice()];
  for (const span of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (span[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], span[1]);
    else merged.push(span.slice());
  }
  return merged;
}

const encode = (column, base = 0) =>
  column.map(([lo, hi]) => `${Math.round((lo - base) * QUANT)}:${Math.round((hi - base) * QUANT)}`).join('+');

/* A piece's origin is its cell centre, so its cell boundaries fall on the
 * half-integers — that is where a neighbour's own face can meet it. Scenes
 * are authored against a corner-aligned grid instead, so the test applies to
 * pieces only; scene geometry is read purely for the shapes it exposes. */
const onCellBoundary = (value) => Math.abs(Math.abs(value % 1) - 0.5) < 1e-6;

function planeGroups(faces) {
  const groups = new Map();
  for (const face of faces) {
    const normal = cross(sub(face.corners[1], face.corners[0]), sub(face.corners[2], face.corners[0]));
    const length = Math.hypot(...normal);
    if (!length) continue;
    const unit = normal.map((v) => v / length);
    const flip = (unit.find((v) => Math.abs(v) > 1e-6) ?? 1) < 0;
    const axis = flip ? unit.map((v) => -v) : unit;
    const key = `${face.material}|${axis.map(round).join(',')}|${round(dot(axis, face.corners[0]))}`;
    if (!groups.has(key)) groups.set(key, { color: face.material, axis, faces: [] });
    groups.get(key).faces.push(face);
  }
  return [...groups.values()];
}

/* Both sides of a joint are sampled on the same global lattice along the same
 * world axis, so "do these mate" is a plain array comparison — nothing to
 * align or mirror at match time.
 *
 * `profile` keeps the piece's own heights, so comparing two of them checks
 * shape *and* vertical registration once each is offset by where its piece
 * was placed. `shape` is the same reading with the height taken out, which is
 * what identifies a socket type across pieces sitting at different levels. */
const key = (columns) =>
  (new Set(columns).size === 1 ? `u|${columns[0]}` : `p|${columns.join('|')}`);

/* Shapes are pooled: a socket stores an id, and the table also names each
 * shape's reverse, because rotating or mirroring a piece can flip which way
 * along the seam its profile reads. Matching is then an id comparison. */
class ShapePool {
  constructor() { this.byKey = new Map(); this.list = []; }

  add(columns) {
    const id = this.#intern(columns);
    this.#intern([...columns].reverse());
    return id;
  }

  #intern(columns) {
    const id = key(columns);
    if (!this.byKey.has(id)) {
      const height = Math.max(...columns.flatMap((column) =>
        column.split('+').map((part) => Number(part.split(':')[1]))));
      const entry = { id, columns, height: height / QUANT, colors: new Set(), families: new Set(), open: 0, mated: 0 };
      this.byKey.set(id, entry);
      this.list.push(entry);
    }
    return id;
  }

  get(id) { return this.byKey.get(id); }

  finish() {
    const out = {};
    for (const shape of this.list) {
      const reversed = this.byKey.get(key([...shape.columns].reverse()));
      // A uniform shape is the same column repeated, so it stores one; the
      // rest genuinely vary and are written out in full.
      const uniform = new Set(shape.columns).size === 1;
      out[shape.id] = {
        ...(uniform ? { column: shape.columns[0] } : { columns: shape.columns }),
        uniform,
        // A uniform shape is keyed on its column alone, so it matches over any
        // overlap and has no length of its own; the rest are fixed-length.
        length: uniform ? null : Math.round(shape.columns.length * STEP * 512) / 512,
        height: shape.height,
        reverse: reversed ? reversed.id : null,
        colors: [...shape.colors].sort(),
        families: [...shape.families].filter(Boolean).sort(),
        open: shape.open,
        mated: shape.mated,
      };
    }
    return out;
  }
}

function readSockets(faces, { requireGrid = true } = {}) {
  const sockets = [];
  const skipped = { diagonal: 0, offGrid: 0 };

  for (const group of planeGroups(faces)) {
    const [nx, ny, nz] = group.axis;
    const triangles = group.faces.map((f) => f.corners);

    if (Math.abs(ny) > 0.9) {
      // Horizontal cap: the surface a piece stacks onto, described by its
      // footprint rather than a profile.
      const points = triangles.flat();
      sockets.push({
        color: group.color,
        axis: 'y',
        at: round(points[0][1]),
        box: [
          round(Math.min(...points.map((p) => p[0]))), round(Math.min(...points.map((p) => p[2]))),
          round(Math.max(...points.map((p) => p[0]))), round(Math.max(...points.map((p) => p[2]))),
        ],
        faces: group.faces,
      });
      continue;
    }

    const axis = Math.abs(nx) > 0.999 ? 'x' : Math.abs(nz) > 0.999 ? 'z' : null;
    if (!axis) { skipped.diagonal++; continue; }

    const along = axis === 'x' ? 2 : 0;
    const at = round(axis === 'x' ? triangles[0][0][0] : triangles[0][0][2]);
    if (requireGrid && !onCellBoundary(at)) { skipped.offGrid++; continue; }

    const flat = triangles.map((t) => t.map((c) => [c[along], c[1]]));
    const points = flat.flat();
    const from = Math.min(...points.map((p) => p[0]));
    const to = Math.max(...points.map((p) => p[0]));

    let run = null;
    const runs = [];
    for (let i = Math.ceil((from - STEP / 2) / STEP); i <= Math.floor((to - STEP / 2) / STEP); i++) {
      const column = columnAt(flat, i * STEP + STEP / 2);
      if (!column) { run = null; continue; }
      if (!run) { run = { start: i, columns: [] }; runs.push(run); }
      run.columns.push(column);
    }

    for (const { start, columns } of runs) {
      const bounds = columns.flat();
      const floor = Math.min(...bounds.map((b) => b[0]));
      sockets.push({
        color: group.color,
        axis,
        at,
        from: round(start * STEP),
        to: round((start + columns.length) * STEP),
        y: [round(floor), round(Math.max(...bounds.map((b) => b[1])))],
        columns: columns.map((column) => encode(column, floor)),
        faces: group.faces,
      });
    }
  }
  return { sockets, skipped };
}

// ---------------------------------------------------------------- models

const catalog = JSON.parse(readFileSync(join(ROOT, 'catalog', 'catalog.json'), 'utf8'));
const meta = new Map(catalog.models.map((entry) => [entry.id, entry]));

/* A piece's origin is the centre of its anchor cell, so cell i covers
 * [i - 0.5, i + 0.5]. Shells that overhang their cell (most cliff faces do)
 * must not claim the neighbouring one, hence rounding inwards. */
function cells(min, max) {
  if (!min || !max) return [[0, 0]];
  const range = (lo, hi) => {
    const first = Math.round(lo + 0.5);
    const last = Math.max(first, Math.round(hi - 0.5));
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  };
  return range(min[0], max[0]).flatMap((x) => range(min[2], max[2]).map((z) => [x, z]));
}

const shapes = new ShapePool();
const pieces = {};
const totals = { grid: 0, caps: 0, diagonal: 0, offGrid: 0 };

for (const file of readdirSync(join(ROOT, 'models')).filter((n) => n.endsWith('.glb')).sort()) {
  const id = file.replace(/\.glb$/, '');
  const entry = meta.get(id);
  const { sockets, skipped } = readSockets(socketFaces(readGlb(join(ROOT, 'models', file))));
  totals.diagonal += skipped.diagonal;
  totals.offGrid += skipped.offGrid;

  const grid = [];
  const caps = [];
  for (const socket of sockets) {
    if (socket.axis === 'y') {
      caps.push({ color: socket.color, at: socket.at, box: socket.box });
      totals.caps++;
      continue;
    }
    const shape = shapes.add(socket.columns);
    shapes.get(shape).colors.add(socket.color);
    if (entry?.family) shapes.get(shape).families.add(entry.family);
    grid.push({
      color: socket.color,
      axis: socket.axis,
      at: socket.at,
      from: socket.from,
      to: socket.to,
      base: socket.y[0],
      shape,
    });
    totals.grid++;
  }

  pieces[id] = {
    family: entry?.family ?? null,
    layer: entry?.layer ?? null,
    size: entry?.size ?? null,
    dwh: entry?.dwh ?? null,
    min: entry?.min ?? null,
    max: entry?.max ?? null,
    triangles: entry?.triangles ?? null,
    cells: cells(entry?.min, entry?.max),
    sockets: grid,
    caps,
    // Curved and off-grid faces have no neighbouring cell to be checked
    // against; the builder reports them rather than calling the piece clean.
    unchecked: skipped.diagonal + skipped.offGrid,
  };
}

// ---------------------------------------------------------------- scenes
/* Whether a socket may be left open is written nowhere in the pack, so it is
 * measured: every socket instance in the shipped dioramas is either mated to
 * a partner or deliberately exposed. A shape routinely exposed there is safe
 * to leave open; one that never is probably wants a neighbour. */

const instanceOf = (name) => {
  const parts = String(name).split('__');
  return `${parts[0]}#${parts[parts.length - 1]}`;
};

for (const file of readdirSync(join(ROOT, 'scenes')).filter((n) => n.endsWith('.glb')).sort()) {
  const glb = readGlb(join(ROOT, 'scenes', file));
  // Scenes name materials `Hidden_Blue` and are authored at one unit per cell;
  // normalise both so they read like the models.
  for (const material of glb.json.materials ?? []) {
    if (material.name?.startsWith('Hidden_')) material.name = material.name.replace('_', ' ');
  }
  const scene = glb.json.scenes[glb.json.scene ?? 0];
  glb.json.nodes.push({ matrix: [100, 0, 0, 0, 0, 100, 0, 0, 0, 0, 100, 0, 0, 0, 0, 1], children: [...scene.nodes] });
  scene.nodes = [glb.json.nodes.length - 1];

  const faces = socketFaces(glb);
  const partners = new Map();
  for (const face of faces) partners.set(face.key, (partners.get(face.key) ?? 0) + 1);

  const byInstance = new Map();
  for (const face of faces) {
    const key = instanceOf(face.piece);
    if (!byInstance.has(key)) byInstance.set(key, []);
    byInstance.get(key).push(face);
  }

  for (const list of byInstance.values()) {
    for (const socket of readSockets(list, { requireGrid: false }).sockets) {
      if (socket.axis === 'y') continue;
      const shape = shapes.get(key(socket.columns));
      if (!shape) continue;
      const total = socket.faces.reduce((sum, face) => sum + area(face.corners), 0);
      const mated = socket.faces.reduce((sum, face) => sum + (partners.get(face.key) > 1 ? area(face.corners) : 0), 0);
      shape[mated > total * 0.9 ? 'mated' : 'open']++;
    }
  }
}

// ------------------------------------------------------- resting contacts
/* Only walls stack through a socket; everywhere else a piece is simply set at
 * the right height on whatever is below. That has no colour to check, so the
 * builder leans on what the dioramas actually do — which family gets laid on
 * which — instead of guessing. */

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const multiply = (a, b) => {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
};
const apply = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

const familyOf = new Map(catalog.models.map((entry) => [entry.id, entry.family]));
const rests = new Map();

for (const file of readdirSync(join(ROOT, 'scenes')).filter((n) => n.endsWith('.glb')).sort()) {
  const glb = readGlb(join(ROOT, 'scenes', file));
  const { json } = glb;
  const scene = json.scenes[json.scene ?? 0];
  json.nodes.push({ matrix: [100, 0, 0, 0, 0, 100, 0, 0, 0, 0, 100, 0, 0, 0, 0, 1], children: [...scene.nodes] });
  scene.nodes = [json.nodes.length - 1];

  const world = new Array(json.nodes.length).fill(null);
  const walk = (index, parent) => {
    world[index] = multiply(parent, json.nodes[index].matrix ?? identity);
    for (const child of json.nodes[index].children ?? []) walk(child, world[index]);
  };
  for (const index of scene.nodes) walk(index, identity);

  const boxes = new Map();
  json.nodes.forEach((node, index) => {
    if (node.mesh === undefined || !world[index]) return;
    const key = instanceOf(node.name);
    const box = boxes.get(key)
      ?? { piece: String(node.name).split('__')[0], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const prim of json.meshes[node.mesh].primitives ?? []) {
      const position = readAccessor(glb, prim.attributes.POSITION);
      for (let v = 0; v < position.count; v++) {
        const point = apply(world[index], position.data[v * 3], position.data[v * 3 + 1], position.data[v * 3 + 2]);
        for (let a = 0; a < 3; a++) {
          if (point[a] < box.min[a]) box.min[a] = point[a];
          if (point[a] > box.max[a]) box.max[a] = point[a];
        }
      }
    }
    boxes.set(key, box);
  });

  const list = [...boxes.values()].filter((box) => familyOf.get(box.piece));
  const overlaps = (a, b) => a.min[0] <= b.max[0] - 0.05 && b.min[0] <= a.max[0] - 0.05
    && a.min[2] <= b.max[2] - 0.05 && b.min[2] <= a.max[2] - 0.05;

  for (const upper of list) {
    for (const lower of list) {
      if (upper === lower) continue;
      if (Math.abs(upper.min[1] - lower.max[1]) > 0.02) continue;
      if (!overlaps(upper, lower)) continue;
      const key = `${familyOf.get(lower.piece)}>${familyOf.get(upper.piece)}`;
      rests.set(key, (rests.get(key) ?? 0) + 1);
    }
  }
}

const stacks = {};
for (const [key, count] of [...rests].sort((a, b) => b[1] - a[1])) stacks[key] = count;

const table = shapes.finish();
const seen = Object.values(table).filter((shape) => shape.open + shape.mated);

console.log(`${totals.grid} grid sockets + ${totals.caps} stacking caps across ${Object.keys(pieces).length} pieces`);
console.log(`${Object.keys(table).length} shapes pooled, ${seen.length} of them observed in the dioramas`);
console.log(`${totals.diagonal} curved and ${totals.offGrid} off-grid faces cannot be grid-checked`);

console.log(`${Object.keys(stacks).length} family-on-family resting contacts observed`);
writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString(), step: STEP, quant: QUANT, shapes: table, pieces, stacks,
}));
console.log('→ catalog/sockets.json');
