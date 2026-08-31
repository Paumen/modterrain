/**
 * Sinks the floors of a scene's cave system, leaving its ceilings where they
 * are, so there is room to put a camera underground.
 *
 *     node tools/deepen-caves.mjs <scene.glb> [out.glb] [--depth N] [--dry-run]
 *
 * A cave in this pack is a stack: a floor, a `Wall_*_Base` standing on it, a
 * `Wall_*_Top` two cells higher, and a ceiling two cells above that — four
 * cells of head height, with no `Mid` anywhere in the scene. The `Mid` layer is
 * the one built to repeat, so a cave gets taller the way a cliff does: drop the
 * floor and the base by N cells and thread N mid rings in behind them. The top
 * and the ceiling never move.
 *
 * Three things do not follow that rule and are handled on their own terms:
 *
 *   - Ramps (`Floor_Incline` under `Ceiling_Incline`, flanked by
 *     `Wall_Incline`) have no mid — an incline cannot repeat — so the whole
 *     ramp sinks as one piece. That leaves its ceiling a cell below the
 *     corridor ceiling at either end, and a wall mid stands in the gap as a
 *     lintel.
 *   - `Prop_Column_*` reaches from floor to ceiling, so it is stretched rather
 *     than moved: the top stays put and the foot follows the floor down.
 *   - Stalagmites sink with the floor; stalactites stay with the ceiling.
 *
 * Pieces are placed by fitting the atom against the scene — every candidate
 * yaw, mirror and stretch is tried and the one whose triangles land on the
 * scene's own, normals included, is the one used. A piece that cannot be
 * fitted that way stops the run rather than being guessed at.
 */

import { readGlb, writeGlb, nodeWorldMatrices, transformPoint, readAccessor, UNITS_PER_CELL } from './glb.mjs';

const args = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--depth') flags.set('depth', Number(args[++i]));
  else if (args[i] === '--dry-run') flags.set('dry', true);
  else if (args[i] === '--force') flags.set('force', true);
  else positional.push(args[i]);
}
const [scene, out = scene] = positional;
const depth = flags.get('depth') ?? 1;

if (!scene || !Number.isInteger(depth) || depth < 1) {
  console.error('usage: node tools/deepen-caves.mjs <scene.glb> [out.glb] [--depth N] [--dry-run]');
  process.exit(1);
}

const glb = readGlb(scene);
const { json, bin } = glb;
const world = nodeWorldMatrices(json);

/* ---- placements ---------------------------------------------------------
 *
 * The scene stores one geometry per piece and material and instances it by
 * node matrix, so a piece placed once is a set of nodes — one per material —
 * that share a matrix. A stretched matrix is how the scene lays a run of flat
 * tiles, which is why the fit below has to allow for scale.
 */

const placements = new Map();
json.nodes.forEach((node, index) => {
  if (node.mesh === undefined || !world[index] || !node.matrix) return;
  const piece = (node.name ?? '').split('__')[0];
  const key = `${piece}|${node.matrix.join(',')}`;
  if (!placements.has(key)) placements.set(key, { piece, nodes: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  const rec = placements.get(key);
  rec.nodes.push(index);
  for (const prim of json.meshes[node.mesh].primitives ?? []) {
    (rec.materials ??= new Set()).add((json.materials[prim.material] ?? {}).name);
    const a = json.accessors[prim.attributes.POSITION];
    for (let c = 0; c < 8; c++) {
      const p = transformPoint(world[index], c & 1 ? a.max[0] : a.min[0], c & 2 ? a.max[1] : a.min[1], c & 4 ? a.max[2] : a.min[2]);
      for (let k = 0; k < 3; k++) {
        if (p[k] < rec.min[k]) rec.min[k] = p[k];
        if (p[k] > rec.max[k]) rec.max[k] = p[k];
      }
    }
  }
});
const all = [...placements.values()];

/* ---- triangles ---------------------------------------------------------- */

const determinant = (m) =>
  m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);

function trianglesOf(source, jsonOf, matrices, indices, scale = 1) {
  const out = [];
  for (const index of indices) {
    const node = jsonOf.nodes[index];
    const mirrored = determinant(matrices[index]) < 0;
    for (const prim of jsonOf.meshes[node.mesh].primitives ?? []) {
      const pos = readAccessor(source, prim.attributes.POSITION);
      const idx = prim.indices !== undefined ? readAccessor(source, prim.indices).data : null;
      const count = idx ? idx.length : pos.count;
      const tris = [];
      for (let t = 0; t < count; t += 3) {
        const v = [0, 1, 2].map((k) => {
          const i = idx ? idx[t + k] : t + k;
          return transformPoint(matrices[index], pos.data[i * 3], pos.data[i * 3 + 1], pos.data[i * 3 + 2]).map((c) => c * scale);
        });
        if (mirrored) v.reverse();
        tris.push(v);
      }
      out.push({ material: (jsonOf.materials[prim.material] ?? {}).name ?? 'Hidden', tris });
    }
  }
  return out;
}

const atoms = new Map();
function atom(name) {
  if (!atoms.has(name)) {
    const source = readGlb(new URL(`../atoms/${name}.glb`, import.meta.url).pathname);
    const matrices = nodeWorldMatrices(source.json);
    const indices = source.json.nodes.map((n, i) => (n.mesh !== undefined && matrices[i] ? i : -1)).filter((i) => i >= 0);
    const parts = trianglesOf(source, source.json, matrices, indices, 1 / UNITS_PER_CELL);
    const points = parts.flatMap((p) => p.tris.flat());
    atoms.set(name, {
      parts,
      min: [0, 1, 2].map((k) => Math.min(...points.map((p) => p[k]))),
      max: [0, 1, 2].map((k) => Math.max(...points.map((p) => p[k]))),
    });
  }
  return atoms.get(name);
}

/* ---- fitting an atom onto a placement ------------------------------------ */

const ORIENTATIONS = [];
for (const mirror of [0, 1]) for (const yaw of [0, 1, 2, 3]) ORIENTATIONS.push({ yaw, mirror });
const YAWS = ORIENTATIONS.filter((o) => !o.mirror);

const turn = ({ yaw, mirror }, p) => {
  const x = mirror ? -p[0] : p[0];
  const cos = [1, 0, -1, 0][yaw];
  const sin = [0, 1, 0, -1][yaw];
  return [cos * x + sin * p[2], p[1], -sin * x + cos * p[2]];
};

/* Mirroring reverses winding, so the placed triangle keeps facing outwards. */
function place(fit, tri) {
  const { orientation, offset, scale } = fit;
  const out = tri.map((p) => {
    const q = turn(orientation, p);
    return [q[0] * scale[0] + offset[0], q[1] * scale[1] + offset[1], q[2] * scale[2] + offset[2]];
  });
  return orientation.mirror ? out.reverse() : out;
}

const round = (v) => (Number(v.toFixed(2)) + 0).toString();
function signature(tris) {
  return tris
    .map((t) => {
      const n = [
        (t[1][1] - t[0][1]) * (t[2][2] - t[0][2]) - (t[1][2] - t[0][2]) * (t[2][1] - t[0][1]),
        (t[1][2] - t[0][2]) * (t[2][0] - t[0][0]) - (t[1][0] - t[0][0]) * (t[2][2] - t[0][2]),
        (t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[1][1] - t[0][1]) * (t[2][0] - t[0][0]),
      ];
      const length = Math.hypot(...n) || 1;
      const centre = [0, 1, 2].map((k) => (t[0][k] + t[1][k] + t[2][k]) / 3);
      return `${centre.map(round)}|${n.map((v) => round(v / length))}`;
    })
    .sort()
    .join(';');
}

function fitAtom(name, rec) {
  const shape = atom(name);
  const target = signature(trianglesOf(glb, json, world, rec.nodes).flatMap((p) => p.tris));
  const hits = [];
  for (const orientation of ORIENTATIONS) {
    const points = shape.parts.flatMap((p) => p.tris.flat()).map((p) => turn(orientation, p));
    const min = [0, 1, 2].map((k) => Math.min(...points.map((p) => p[k])));
    const max = [0, 1, 2].map((k) => Math.max(...points.map((p) => p[k])));
    const scale = [0, 1, 2].map((k) => (max[k] - min[k] < 1e-6 ? 1 : (rec.max[k] - rec.min[k]) / (max[k] - min[k])));
    const offset = [0, 1, 2].map((k) => rec.min[k] - min[k] * scale[k]);
    const fit = { orientation, offset, scale };
    if (signature(shape.parts.flatMap((p) => p.tris).map((t) => place(fit, t))) === target) hits.push(fit);
  }
  if (hits.length !== 1) {
    throw new Error(`${name} does not fit its placement at ${rec.min.map((v) => v.toFixed(1))} (${hits.length} candidates)`);
  }
  return hits[0];
}

/* ---- what each piece is -------------------------------------------------- */

const isRamp = (p) => /^(Floor|Ceiling)_Incline_/.test(p) || /^Wall_Incline_/.test(p);
const isSlab = (p) => p === 'Floor_And_Ceiling_Flat_1x1';
const isFloorPiece = (p) => /^Floor_(Curve|Incline)/.test(p) || isSlab(p);
const isWallBase = (p) => /^Wall_.*_Base$/.test(p) && !/^Wall_Incline_/.test(p);
const isCaveBase = (p) => p === 'Cave_Edge_Esse_Base_3x3' || p === 'Cave_Center_Base_1x1';
const isCaveMid = (p) => p === 'Cave_Edge_Esse_Mid_2x3';
const isFloorProp = (p) => /^Prop_(Stalagmite|Protrusion_Floor)/.test(p);
const isColumn = (p) => /^Prop_Column_/.test(p);
/* The pool is one big disc that reads as water only where a cave floor dips
 * below it, so it has to follow the floor down to stay that way. */
const isCaveWater = (rec) => rec.materials.has('Cave Pool');

const overlaps = (a, b, axis) => Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]) > 0.2;

/* A slab is the same piece used either way up, and the scene also stacks it as
 * plain fill between a cave ceiling and the ground above. Four cells — a base
 * and a top — is what tells the three apart: a slab with a floor that far under
 * it is a ceiling, a slab with a ceiling that far over it is a floor, and a
 * slab with neither is fill, which stays where it is. */
const slabs = all.filter((r) => isSlab(r.piece));
const under = (a, b, gap) => overlaps(a, b, 0) && overlaps(a, b, 2) && Math.abs(a.max[1] - (b.min[1] - gap)) < 0.05;
for (const rec of slabs) {
  rec.ceiling = all.some((f) => f !== rec && isFloorPiece(f.piece) && under(f, rec, 4));
}
for (const rec of slabs) {
  rec.floor = !rec.ceiling && all.some((c) => c !== rec && (/^Ceiling_/.test(c.piece) || c.ceiling) && under(rec, c, 4));
}

const sinks = (rec) =>
  isRamp(rec.piece) ||
  (isFloorPiece(rec.piece) && (isSlab(rec.piece) ? rec.floor : true)) ||
  isWallBase(rec.piece) ||
  isCaveBase(rec.piece) ||
  isFloorProp(rec.piece) ||
  isCaveWater(rec);

/* ---- new geometry -------------------------------------------------------- */

const materialIndex = new Map(json.materials.map((m, i) => [m.name, i]));
function materialFor(name) {
  const candidates = [name, name.replace(/ /g, '_'), name.replace(/ Face$/, '')];
  for (const c of candidates) if (materialIndex.has(c)) return materialIndex.get(c);
  throw new Error(`no scene material for ${name}`);
}

const additions = []; // { piece, group, material, tris }
let group = 0;
const addPiece = (piece, parts) => {
  for (const part of parts) additions.push({ piece, group, material: part.material, tris: part.tris });
  group++;
};

/* ---- the edit ------------------------------------------------------------ */

if (!flags.get('force') && json.nodes.some((n) => /^Wall_.*_Mid__/.test(n.name ?? ''))) {
  throw new Error(`${scene} already has wall mids in it; it looks deepened already (--force to go again)`);
}

const report = new Map();
const count = (what, n = 1) => report.set(what, (report.get(what) ?? 0) + n);

for (const rec of all) {
  if (!sinks(rec)) continue;
  for (const index of rec.nodes) json.nodes[index].matrix[13] -= depth;
  count(`sank ${rec.piece}`);
}

/* Columns reach floor to ceiling: hold the head and stretch the foot down. */
for (const rec of all.filter((r) => isColumn(r.piece))) {
  const height = rec.max[1] - rec.min[1];
  const factor = (height + depth) / height;
  for (const index of rec.nodes) {
    const m = json.nodes[index].matrix;
    for (const row of [1, 5, 9]) m[row] *= factor;
    m[13] = rec.max[1] + (m[13] - rec.max[1]) * factor;
  }
  count('stretched a column');
}

/* Wall mids fill in behind the base that just dropped. */
for (const rec of all.filter((r) => isWallBase(r.piece))) {
  const fit = fitAtom(rec.piece, rec);
  const mid = atom(rec.piece.replace(/_Base$/, '_Mid'));
  for (let n = 0; n < depth; n++) {
    const bottom = rec.min[1] + 2 - depth + n;
    const lift = { ...fit, offset: [fit.offset[0], bottom - mid.min[1] * fit.scale[1], fit.offset[2]] };
    addPiece(rec.piece.replace(/_Base$/, '_Mid'), mid.parts.map((p) => ({ material: p.material, tris: p.tris.map((t) => place(lift, t)) })));
  }
  count('added a wall mid', depth);
}

/* The cave mouths already have a mid ring, so they are copied, not fitted. */
for (const rec of all.filter((r) => isCaveMid(r.piece))) {
  for (let n = 1; n <= depth; n++) {
    for (const index of rec.nodes) {
      const node = json.nodes[index];
      const matrix = node.matrix.slice();
      matrix[13] -= n;
      json.nodes.push({ name: node.name.replace(/__(\d+)$/, (_, g) => `__${Number(g) + 100 * n}`), mesh: node.mesh, matrix });
      json.scenes[json.scene ?? 0].nodes.push(json.nodes.length - 1);
    }
  }
  count('added a cave mouth mid', depth);
}

/* Which way the piece's one visible face looks, so a lintel can be turned to
 * face the corridor rather than the rock behind it. */
function faceNormal(shape) {
  const [a, b, c] = shape.parts.find((p) => p.material === 'Cliff Face').tris[0];
  const n = [
    (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
    (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
  ];
  const length = Math.hypot(...n);
  return n.map((v) => v / length);
}

/* A sunken ramp leaves its ceiling a cell low where it meets a corridor; a
 * wall mid stands across the opening as a lintel. */
const LINTEL = 'Wall_Straight_Basic_1x2_Mid';
for (const rec of all.filter((r) => /^Ceiling_Incline_/.test(r.piece))) {
  const size = [0, 1, 2].map((k) => rec.max[k] - rec.min[k]);
  const along = size[0] > size[2] ? 0 : 2;
  const across = along === 0 ? 2 : 0;
  const points = trianglesOf(glb, json, world, rec.nodes).flatMap((p) => p.tris.flat());
  const lowest = points.reduce((a, b) => (a[1] <= b[1] ? a : b));
  const lowEnd = Math.abs(lowest[along] - rec.min[along]) < Math.abs(lowest[along] - rec.max[along]);

  for (const end of [0, 1]) {
    // the ramp has already sunk, so its ceiling here is `depth` below the corridor's
    const at = end ? rec.max[along] : rec.min[along];
    const ceiling = (end === (lowEnd ? 0 : 1) ? rec.min[1] : rec.max[1]) - depth;
    const facing = end ? 1 : -1; // the lintel looks out of the ramp, into the corridor
    const shape = atom(LINTEL);
    const wanted = [0, 0, 0];
    wanted[along] = facing;
    const orientation = YAWS.find((o) => {
      const n = turn(o, faceNormal(shape));
      return wanted.every((w, k) => Math.abs(n[k] - w) < 0.01);
    });
    for (let n = 0; n < depth; n++) {
      const fit = { orientation, offset: [0, 0, 0], scale: [1, 1, 1] };
      const placed = shape.parts.map((p) => ({ material: p.material, tris: p.tris.map((t) => place(fit, t)) }));
      const flat = placed.flatMap((p) => p.tris.flat());
      const min = [0, 1, 2].map((k) => Math.min(...flat.map((p) => p[k])));
      const max = [0, 1, 2].map((k) => Math.max(...flat.map((p) => p[k])));
      const shift = [0, 0, 0];
      shift[along] = at - (facing > 0 ? max[along] : min[along]);
      shift[across] = rec.min[across] - min[across];
      shift[1] = ceiling + n - min[1];
      addPiece(LINTEL, placed.map((p) => ({
        material: p.material,
        tris: p.tris.map((t) => t.map((v) => [v[0] + shift[0], v[1] + shift[1], v[2] + shift[2]])),
      })));
    }
    count('added a ramp lintel', depth);
  }
}

/* A mouth now opens a cell below the ground outside it. A sharp path incline
 * takes up the difference over two cells — the mouth's own cell and the one in
 * front of it — which means cutting that cell out of the ground it is laid in.
 * The incline only ever drops one cell, so a deeper cave keeps its step. */
const MOUTH_RAMP = 'Path_Terrain_Incline_Sharp_Center_1x2';
const GROUND = new Set(['Path_Terrain_Dirt_Flat_1x1', 'Floor_And_Ceiling_Flat_1x1']);

/* Flat ground is laid as one stretched tile, so a cell is cut out of it by
 * splitting the tile into the rectangles around the cell. Scaling in world
 * axes keeps a box a box however the piece was turned. */
function reshape(rec, index, box) {
  const m = world[index].slice();
  const scale = [0, 1, 2].map((k) => (box.max[k] - box.min[k]) / (rec.max[k] - rec.min[k]));
  const shift = [0, 1, 2].map((k) => box.min[k] - rec.min[k] * scale[k]);
  for (let col = 0; col < 4; col++) for (let k = 0; k < 3; k++) m[col * 4 + k] *= scale[k];
  for (let k = 0; k < 3; k++) m[12 + k] += shift[k];
  return m;
}

function cutOut(rec, cell) {
  const rest = [];
  const [x0, x1, z0, z1] = [rec.min[0], rec.max[0], rec.min[2], rec.max[2]];
  const [cx0, cx1] = [Math.max(x0, cell.min[0]), Math.min(x1, cell.max[0])];
  if (cell.min[0] > x0 + 0.01) rest.push([x0, cell.min[0], z0, z1]);
  if (cell.max[0] < x1 - 0.01) rest.push([cell.max[0], x1, z0, z1]);
  if (cell.min[2] > z0 + 0.01) rest.push([cx0, cx1, z0, cell.min[2]]);
  if (cell.max[2] < z1 - 0.01) rest.push([cx0, cx1, cell.max[2], z1]);

  for (const index of rec.nodes) {
    const node = json.nodes[index];
    rest.forEach(([a, b, c, d], n) => {
      const matrix = reshape(rec, index, { min: [a, rec.min[1], c], max: [b, rec.max[1], d] });
      if (n === 0) node.matrix = matrix;
      else {
        json.nodes.push({ name: `${node.name}_cut${n}`, mesh: node.mesh, matrix });
        json.scenes[json.scene ?? 0].nodes.push(json.nodes.length - 1);
      }
    });
  }
}

const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
for (const mouth of all.filter((r) => r.piece === 'Cave_Center_Base_1x1')) {
  // `mouth` was measured before the sink, so its top is still the old floor,
  // which is the level of the ground outside.
  const grade = Math.round(mouth.max[1]);
  const floor = grade - depth;

  const ways = DIRECTIONS.map(([dx, dz]) => {
    const cell = {
      min: [mouth.min[0] + dx, grade - 1, mouth.min[2] + dz],
      max: [mouth.max[0] + dx, grade, mouth.max[2] + dz],
    };
    const over = (r) =>
      r.min[0] < cell.max[0] - 0.05 && r.max[0] > cell.min[0] + 0.05 &&
      r.min[2] < cell.max[2] - 0.05 && r.max[2] > cell.min[2] + 0.05;
    const covering = all.filter((r) => over(r) && Math.abs(r.max[1] - grade) < 0.05);
    // daylight, not more cave: outside the mouth there is nothing overhead at all
    const roofed = all.some((r) => over(r) && r.min[1] > grade + 0.05);
    return { step: [dx, dz], cell, covering: roofed ? [] : covering };
  }).filter((w) => w.covering.length);

  if (ways.length === 0) {
    count('left a mouth alone: nothing steps up outside it');
    continue;
  }
  if (ways.length > 1) {
    throw new Error(`the mouth at ${mouth.min.map((v) => v.toFixed(1))} steps up on ${ways.length} sides`);
  }
  const [way] = ways;
  if (depth !== 1) {
    count(`left a ${depth}-cell step at a mouth: the path incline only drops one`);
    continue;
  }
  // the ramp lies across two cells — the mouth's own and the one outside — and
  // the flat ground runs under both, so both come out of it
  const cut = {
    min: [Math.min(mouth.min[0], way.cell.min[0]), grade - 1, Math.min(mouth.min[2], way.cell.min[2])],
    max: [Math.max(mouth.max[0], way.cell.max[0]), grade, Math.max(mouth.max[2], way.cell.max[2])],
  };
  const inTheWay = all.filter(
    (r) => !sinks(r) && r.max[1] > grade - 0.05 && r.max[1] < grade + 0.5 &&
      r.min[0] < cut.max[0] - 0.05 && r.max[0] > cut.min[0] + 0.05 &&
      r.min[2] < cut.max[2] - 0.05 && r.max[2] > cut.min[2] + 0.05,
  );
  const stubborn = inTheWay.filter((r) => !GROUND.has(r.piece) || r.max[1] > grade + 0.05);
  if (stubborn.length) {
    throw new Error(`the mouth at ${mouth.min.map((v) => v.toFixed(1))} needs ${stubborn.map((r) => r.piece)} cut, which this tool will not do`);
  }
  for (const rec of inTheWay) cutOut(rec, cut);

  const [dx, dz] = way.step;
  const shape = atom(MOUTH_RAMP);
  const orientation = YAWS.find((o) => {
    const uphill = turn(o, [1, 0, 0]); // the atom climbs towards +x
    return Math.abs(uphill[0] - dx) < 0.01 && Math.abs(uphill[2] - dz) < 0.01;
  });
  const placed = shape.parts.map((p) => ({
    material: p.material,
    tris: p.tris.map((t) => place({ orientation, offset: [0, 0, 0], scale: [1, 1, 1] }, t)),
  }));
  const flat = placed.flatMap((p) => p.tris.flat());
  const min = [0, 1, 2].map((k) => Math.min(...flat.map((p) => p[k])));
  const max = [0, 1, 2].map((k) => Math.max(...flat.map((p) => p[k])));
  const shift = [
    dx ? (dx > 0 ? way.cell.max[0] - max[0] : way.cell.min[0] - min[0]) : mouth.min[0] - min[0],
    floor - min[1],
    dz ? (dz > 0 ? way.cell.max[2] - max[2] : way.cell.min[2] - min[2]) : mouth.min[2] - min[2],
  ];
  addPiece(MOUTH_RAMP, placed.map((p) => ({
    material: p.material,
    tris: p.tris.map((t) => t.map((v) => [v[0] + shift[0], v[1] + shift[1], v[2] + shift[2]])),
  })));
  count('ramped a cave mouth');
}

/* ---- write the additions into the file ----------------------------------- */

const chunks = [bin];
let offset = bin.length;
const pad = () => {
  const n = (4 - (offset % 4)) % 4;
  if (n) {
    chunks.push(Buffer.alloc(n));
    offset += n;
  }
};

for (const add of additions) {
  const data = Buffer.alloc(add.tris.length * 9 * 4);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let at = 0;
  for (const tri of add.tris) {
    for (const v of tri) {
      for (let k = 0; k < 3; k++) {
        data.writeFloatLE(v[k], at);
        at += 4;
        if (v[k] < min[k]) min[k] = v[k];
        if (v[k] > max[k]) max[k] = v[k];
      }
    }
  }
  pad();
  json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
  chunks.push(data);
  offset += data.length;
  json.accessors.push({
    componentType: 5126,
    type: 'VEC3',
    bufferView: json.bufferViews.length - 1,
    count: add.tris.length * 3,
    min,
    max,
  });
  const name = `${add.piece}__${add.material.replace(/ /g, '_')}__0__${add.group}`;
  json.meshes.push({ name, primitives: [{ attributes: { POSITION: json.accessors.length - 1 }, mode: 4, material: materialFor(add.material) }] });
  json.nodes.push({ name: `${name}__1`, mesh: json.meshes.length - 1 });
  json.scenes[json.scene ?? 0].nodes.push(json.nodes.length - 1);
}
json.buffers[0].byteLength = offset;

for (const [what, n] of [...report].sort()) console.log(`  ${String(n).padStart(4)}  ${what}`);
console.log(`  ${additions.length} new meshes, ${json.nodes.length} nodes total`);

if (flags.get('dry')) {
  console.log(`dry run: ${scene} not written`);
} else {
  writeGlb(out, json, Buffer.concat(chunks));
  console.log(`${scene} → ${out} (floors ${depth} cell${depth > 1 ? 's' : ''} lower)`);
}
