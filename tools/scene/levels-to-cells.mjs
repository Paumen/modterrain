import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'modterrain-levels-1';
export const CELLS_FORMAT = 'modterrain-cells-1';

const CLIFF = 4;
const SIDES = { W: [-1, 0], E: [1, 0], N: [0, 1], S: [0, -1] };
const FACING_ROT = { W: 0, N: 90, E: 180, S: 270 };
const CORNER_ROT = { WN: 0, NE: 90, ES: 180, SW: 270 };
const DIAGONAL_ROT = { WN: 0, NE: 90, ES: 180, SW: 270 };
const ROT_VEC = {
  0: ([a, b]) => [a, b],
  90: ([a, b]) => [b, -a],
  180: ([a, b]) => [-a, -b],
  270: ([a, b]) => [-b, a],
};
const OUTER_2X2 = { corner: [-1, 1], runs: [[-1, 0], [0, 1]], inward: [0, 0] };
const INNER_2X2 = { low: [-1, 1], lips: [[-1, 0], [0, 1]] };
const LAYERS = (family) => ({
  straight: { Base: 'Basic_Straight_Base_1x2', Mid: 'Basic_Straight_Mid_1x1', Top: 'Basic_Straight_Top_1x1' },
  outer: { Base: 'Basic_Curve_Outer_2x2_Wide_Base', Mid: 'Basic_Curve_Outer_2x2_Wide_Mid', Top: 'Basic_Curve_Outer_2x2_Wide_Top' },
  sharp: { Base: 'Basic_Curve_Outer_1x1_Base', Mid: 'Basic_Curve_Outer_1x1_Mid', Top: 'Basic_Curve_Outer_1x1_Top' },
  inner: { Base: 'Basic_Curve_Inner_2x2_Narrow_Base', Mid: 'Basic_Curve_Inner_2x2_Narrow_Mid', Top: 'Basic_Curve_Inner_2x2_Narrow_Top' },
})[family];

const key = (x, z) => `${x},${z}`;

export function parseLevels(data) {
  if (data.format !== FORMAT) throw new Error(`not ${FORMAT}`);
  const [ox, oz] = data.origin ?? [0, 0];
  const rows = data.rows;
  const cells = new Map();
  rows.forEach((row, r) => {
    const z = oz + rows.length - 1 - r;
    row.trim().split(/\s+/).forEach((token, c) => {
      if (token === '.') return;
      const level = Number(token);
      if (!Number.isInteger(level)) throw new Error(`row ${r + 1} column ${c + 1}: "${token}" is not a whole level or "."`);
      cells.set(key(ox + c, z), level);
    });
  });
  return { cells, origin: [ox, oz], corners: data.corners ?? 'wide' };
}

export function compile(map) {
  const { cells, corners } = map;
  const errors = [];
  const at = (x, z) => cells.get(key(x, z));
  const claimed = new Map();
  const claim = (x, z, role) => {
    const k = key(x, z);
    if (claimed.has(k)) errors.push(`cell ${k}: ${role} collides with ${claimed.get(k)}`);
    claimed.set(k, role);
  };
  const drops = new Map();
  for (const [k, level] of cells) {
    const [x, z] = k.split(',').map(Number);
    const low = [];
    for (const [side, [dx, dz]] of Object.entries(SIDES)) {
      const other = at(x + dx, z + dz);
      if (other === undefined || other >= level) continue;
      const drop = level - other;
      if (drop < CLIFF) errors.push(`cell ${k}: drops ${drop} to the ${side}; only cliffs of ${CLIFF} or more are supported`);
      else low.push({ side, ground: other });
    }
    if (low.length) drops.set(k, { level, low });
  }

  const pieces = [];
  const stack = (family, x, z, rot, ground, level, stretch = [1, 1]) => {
    const names = LAYERS(family);
    const place = (piece, y) => pieces.push({ piece, at: [x, y, z], rot, mirror: false, stretch });
    place(names.Base, ground);
    for (let y = ground + 2; y <= level - 3; y++) place(names.Mid, y);
    place(names.Top, level - 2);
  };
  const groundUnder = new Map();
  const bury = (x, z, ground) => {
    const k = key(x, z);
    if (groundUnder.has(k) && groundUnder.get(k) !== ground) errors.push(`cell ${k}: cliffs from two ground levels (${groundUnder.get(k)} and ${ground}) meet here`);
    groundUnder.set(k, ground);
  };
  const symbols = new Map();

  const cornerCells = [];
  for (const [k, { level, low }] of drops) {
    const [x, z] = k.split(',').map(Number);
    if (low.length === 1) continue;
    const sides = low.map((l) => l.side);
    const order = ['W', 'N', 'E', 'S', 'W'];
    let pair = null;
    for (let i = 0; i < 4; i++) if (sides.includes(order[i]) && sides.includes(order[i + 1]) && sides.length === 2) pair = order[i] + order[i + 1];
    if (!pair) { errors.push(`cell ${k}: low on ${sides.join(', ')}; a plateau must be at least two cells wide everywhere`); continue; }
    if (new Set(low.map((l) => l.ground)).size > 1) { errors.push(`cell ${k}: its two cliff sides fall to different ground levels`); continue; }
    cornerCells.push({ x, z, level, ground: low[0].ground, rot: CORNER_ROT[pair] });
  }
  for (const c of cornerCells) {
    const rv = ROT_VEC[c.rot];
    const [cx, cz] = rv(OUTER_2X2.corner);
    const origin = [c.x - cx, c.z - cz];
    const fits = corners === 'wide' && [...OUTER_2X2.runs, OUTER_2X2.inward].every(([a, b]) => {
      const [dx, dz] = rv([a, b]);
      const [x, z] = [origin[0] + dx, origin[1] + dz];
      if (at(x, z) !== c.level || claimed.has(key(x, z))) return false;
      const d = drops.get(key(x, z));
      if ([a, b].join() === OUTER_2X2.inward.join()) return !d;
      return d && d.low.length === 1;
    });
    if (fits) {
      for (const local of [OUTER_2X2.corner, ...OUTER_2X2.runs, OUTER_2X2.inward]) {
        const [dx, dz] = rv(local);
        claim(origin[0] + dx, origin[1] + dz, 'outer curve');
        bury(origin[0] + dx, origin[1] + dz, c.ground);
        symbols.set(key(origin[0] + dx, origin[1] + dz), 'c');
      }
      stack('outer', origin[0] + 0.5, origin[1] + 0.5, c.rot, c.ground, c.level);
    } else {
      claim(c.x, c.z, 'sharp corner');
      bury(c.x, c.z, c.ground);
      symbols.set(key(c.x, c.z), 'C');
      stack('sharp', c.x + 0.5, c.z + 0.5, c.rot, c.ground, c.level);
    }
  }

  for (const [k, level] of cells) {
    if (drops.has(k) || claimed.has(k)) continue;
    const [x, z] = k.split(',').map(Number);
    for (const [pair, rot] of Object.entries(DIAGONAL_ROT)) {
      const rv = ROT_VEC[rot];
      const [lx, lz] = rv(INNER_2X2.low);
      const lowLevel = at(x + lx, z + lz);
      if (lowLevel === undefined || lowLevel >= level) continue;
      const lips = INNER_2X2.lips.map(([a, b]) => { const [dx, dz] = rv([a, b]); return key(x + dx, z + dz); });
      const lipDrops = lips.map((lk) => drops.get(lk));
      if (!lipDrops.every((d) => d && d.level === level && d.low.length === 1 && d.low[0].ground === lowLevel)) continue;
      if (level - lowLevel < CLIFF) continue;
      if (lips.some((lk) => claimed.has(lk)) || claimed.has(key(x + lx, z + lz))) { errors.push(`cell ${k}: inner corner collides with a neighbouring corner`); continue; }
      claim(x, z, 'inner curve');
      bury(x, z, lowLevel);
      symbols.set(k, 'i');
      for (const lk of lips) { const [a, b] = lk.split(',').map(Number); claim(a, b, 'inner curve'); bury(a, b, lowLevel); symbols.set(lk, 'i'); }
      claim(x + lx, z + lz, 'inner curve foot');
      bury(x + lx, z + lz, lowLevel);
      symbols.set(key(x + lx, z + lz), 'o');
      stack('inner', x + 0.5, z + 0.5, rot, lowLevel, level);
      break;
    }
  }

  const runs = new Map();
  for (const [k, { level, low }] of drops) {
    if (claimed.has(k) || low.length !== 1) continue;
    const [x, z] = k.split(',').map(Number);
    const { side, ground } = low[0];
    const along = side === 'W' || side === 'E' ? 'z' : 'x';
    const line = along === 'z' ? x : z;
    const runKey = `${side}|${level}|${ground}|${line}`;
    if (!runs.has(runKey)) runs.set(runKey, []);
    runs.get(runKey).push(along === 'z' ? z : x);
    claim(x, z, `cliff facing ${side}`);
    bury(x, z, ground);
    symbols.set(k, { W: '<', E: '>', N: '^', S: 'v' }[side]);
  }
  for (const [runKey, coords] of runs) {
    const [side, level, ground, line] = runKey.split('|');
    coords.sort((a, b) => a - b);
    let start = coords[0], prev = coords[0];
    const flush = (a, b) => {
      const n = b - a + 1;
      const centre = a + n / 2;
      const [x, z] = side === 'W' || side === 'E' ? [Number(line) + 0.5, centre] : [centre, Number(line) + 0.5];
      stack('straight', x, z, FACING_ROT[side], Number(ground), Number(level), [1, n]);
    };
    for (const c of coords.slice(1)) {
      if (c !== prev + 1) { flush(start, prev); start = c; }
      prev = c;
    }
    flush(start, prev);
  }

  const slabs = new Map();
  const slab = (x, z, y) => {
    if (!slabs.has(y)) slabs.set(y, new Set());
    slabs.get(y).add(key(x, z));
  };
  for (const [k, level] of cells) {
    if (claimed.has(k)) continue;
    const [x, z] = k.split(',').map(Number);
    slab(x, z, level);
    symbols.set(k, '.');
  }
  for (const [k, ground] of groundUnder) {
    const [x, z] = k.split(',').map(Number);
    slab(x, z, ground);
  }
  for (const [y, set] of [...slabs].sort((a, b) => a[0] - b[0])) {
    for (const [x0, z0, w, h] of rectangles(set)) {
      pieces.push({ piece: 'Grass_Flat_1x1', at: [x0 + w / 2, y, z0 + h / 2], rot: 0, mirror: false, stretch: [w, h] });
    }
  }

  return { pieces, errors, symbols };
}

function rectangles(set) {
  const left = new Set(set);
  const out = [];
  const parse = (k) => k.split(',').map(Number);
  const sorted = [...left].map(parse).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  for (const [x0, z0] of sorted) {
    if (!left.has(key(x0, z0))) continue;
    let w = 1;
    while (left.has(key(x0 + w, z0))) w++;
    let h = 1;
    while ([...Array(w).keys()].every((i) => left.has(key(x0 + i, z0 + h)))) h++;
    for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) left.delete(key(x0 + i, z0 + j));
    out.push([x0, z0, w, h]);
  }
  return out;
}

export function picture(map, symbols) {
  const xs = [], zs = [];
  for (const k of map.cells.keys()) { const [x, z] = k.split(',').map(Number); xs.push(x); zs.push(z); }
  const lines = [];
  for (let z = Math.max(...zs); z >= Math.min(...zs); z--) {
    let line = '';
    for (let x = Math.min(...xs); x <= Math.max(...xs); x++) line += (map.cells.has(key(x, z)) ? symbols.get(key(x, z)) ?? '?' : ' ') + ' ';
    lines.push(line.trimEnd());
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const option = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
  const input = argv.find((a) => !a.startsWith('--') && a !== option('out', null));
  if (!input) {
    console.error('usage: node tools/scene/levels-to-cells.mjs <levels.json> [--out cells.json]');
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(input, 'utf8'));
  const map = parseLevels(data);
  const { pieces, errors, symbols } = compile(map);
  console.log(picture(map, symbols));
  console.log(`${basename(input)}: ${map.cells.size} cells -> ${pieces.length} pieces`);
  if (errors.length) {
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  const path = option('out', null);
  if (path) {
    writeFileSync(path, `${JSON.stringify({ format: CELLS_FORMAT, source: `${basename(input)} via levels-to-cells`, pieces }, null, 1)}\n`);
    console.log(`  written to ${path}`);
  }
}
