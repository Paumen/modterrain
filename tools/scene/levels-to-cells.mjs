import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'modterrain-levels-1';
export const CELLS_FORMAT = 'modterrain-cells-1';

const CLIFF = 4;
const SIDES = { W: [-1, 0], E: [1, 0], N: [0, 1], S: [0, -1] };
const OPPOSITE = { W: 'E', E: 'W', N: 'S', S: 'N' };
const FACING_ROT = { W: 0, N: 90, E: 180, S: 270 };
const CORNER_ROT = { WN: 0, NE: 90, ES: 180, SW: 270 };
const ROT_VEC = {
  0: ([a, b]) => [a, b],
  90: ([a, b]) => [b, -a],
  180: ([a, b]) => [-a, -b],
  270: ([a, b]) => [-b, a],
};
const OUTER = { corner: [-1, 1], cells: [[-1, 0], [-1, 1], [0, 0], [0, 1]] };
const INNER = {
  cliff: { low: [-1, 1], cells: [[0, 0], [-1, 0], [0, 1]], foot: true },
  hill: { low: [-1, 1], cells: [[0, 0], [1, 0], [0, -1], [1, -1]], foot: false },
};
const PIECES = {
  cliff: {
    straight: { Base: 'Basic_Straight_Base_1x2', Mid: 'Basic_Straight_Mid_1x1', Top: 'Basic_Straight_Top_1x1' },
    outer: { Base: 'Basic_Curve_Outer_2x2_Wide_Base', Mid: 'Basic_Curve_Outer_2x2_Wide_Mid', Top: 'Basic_Curve_Outer_2x2_Wide_Top' },
    sharp: { Base: 'Basic_Curve_Outer_1x1_Base', Mid: 'Basic_Curve_Outer_1x1_Mid', Top: 'Basic_Curve_Outer_1x1_Top' },
    inner: { Base: 'Basic_Curve_Inner_2x2_Narrow_Base', Mid: 'Basic_Curve_Inner_2x2_Narrow_Mid', Top: 'Basic_Curve_Inner_2x2_Narrow_Top' },
  },
  hill: {
    straight: 'Grass_Hill_Sharp_Straight_1x2',
    outer: 'Grass_Hill_Sharp_Curve_Outer_2x2',
    inner: 'Grass_Hill_Sharp_Curve_Inner_2x2',
  },
};
const SYMBOL = {
  cliff: { outer: 'c', sharp: 'C', inner: 'i', foot: 'o', W: '<', E: '>', N: '^', S: 'v' },
  hill: { outer: 'r', inner: 'j', W: '/', E: '/', N: '/', S: '/' },
};

const key = (x, z) => `${x},${z}`;
const unkey = (k) => k.split(',').map(Number);

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
  const pieces = [];
  const symbols = new Map();
  const claimed = new Map();
  const groundUnder = new Map();
  const at = (x, z) => cells.get(key(x, z));
  const held = (kind, x, z) => claimed.has(`${kind}|${key(x, z)}`);
  const claim = (kind, x, z, role) => {
    const k = `${kind}|${key(x, z)}`;
    if (claimed.has(k)) errors.push(`cell ${key(x, z)}: ${role} collides with ${claimed.get(k)}`);
    claimed.set(k, role);
  };
  const bury = (x, z, ground) => {
    const k = key(x, z);
    if (!groundUnder.has(k)) groundUnder.set(k, new Set());
    groundUnder.get(k).add(ground);
  };
  const take = (kind, x, z, role, ground) => {
    claim(kind, x, z, role);
    bury(x, z, ground);
    const s = SYMBOL[kind][role.split(' ')[0]] ?? SYMBOL[kind][role];
    symbols.set(key(x, z), symbols.has(key(x, z)) && symbols.get(key(x, z)) !== s ? '+' : s);
  };
  const place = (kind, shape, x, z, rot, ground, level, stretch = [1, 1], cap = null) => {
    const put = (piece, y) => pieces.push({ piece, at: [x, y, z], rot, mirror: false, stretch });
    if (kind === 'hill') { put(PIECES.hill[shape], ground); return; }
    const names = PIECES.cliff[shape];
    put(names.Base, ground);
    if (cap !== null) {
      for (let y = ground + 2; y <= cap - 1; y++) put(names.Mid, y);
      return;
    }
    for (let y = ground + 2; y <= level - 3; y++) put(names.Mid, y);
    put(names.Top, level - 2);
  };

  const drops = new Map();
  const capped = new Map();
  for (const [k, level] of cells) {
    const [x, z] = unkey(k);
    const low = [];
    for (const [side, [dx, dz]] of Object.entries(SIDES)) {
      const other = at(x + dx, z + dz);
      if (other === undefined || other >= level) continue;
      const drop = level - other;
      if (drop === 1) low.push({ side, ground: other, kind: 'hill', depth: 1 });
      else if (drop >= CLIFF) low.push({ side, ground: other, kind: 'cliff', depth: 1 });
      else errors.push(`cell ${k}: drops ${drop} to the ${side}; a drop is 1 (a hill) or ${CLIFF} and more (a cliff)`);
    }
    if (low.length) drops.set(k, { level, low });
  }
  for (const [k, level] of cells) {
    const [x, z] = unkey(k);
    for (const [side, [dx, dz]] of Object.entries(SIDES)) {
      const front = drops.get(key(x + dx, z + dz));
      const hit = front && front.level === level && front.low.find((l) => l.side === side && l.kind === 'hill' && l.depth === 1);
      if (!hit) continue;
      if (!drops.has(k)) drops.set(k, { level, low: [] });
      drops.get(k).low.push({ side, ground: hit.ground, kind: 'hill', depth: 2 });
    }
  }
  const sidesOf = (low, kind) => low.filter((l) => l.depth === 1 && l.kind === kind).map((l) => l.side);
  for (const [k, { level, low }] of drops) {
    const hills = low.filter((l) => l.kind === 'hill');
    const cliffs = low.filter((l) => l.kind === 'cliff');
    if (hills.length && cliffs.length) {
      errors.push(`cell ${k}: a hill edge and a cliff edge meet here. Capping the cliff stack under the hill was measured and does not close: it leaves the hill's Pink flank and the neighbouring cliff Top's Yellow open, and pairs Yellow against Orange. The kit's answer is the Grass_Hill_Grade_Transition_* family, which is not compiled yet.`);
    }
    for (const group of [hills, cliffs]) {
      const grounds = new Set(group.filter((l) => l.depth === 1).map((l) => l.ground));
      if (grounds.size > 1) errors.push(`cell ${k}: falls to two different ground levels (${[...grounds].join(', ')})`);
    }
    for (const kind of ['hill', 'cliff']) {
      const sides = sidesOf(low, kind);
      if (sides.length > 2 || (sides.length === 2 && OPPOSITE[sides[0]] === sides[1])) {
        errors.push(`cell ${k}: low on ${sides.join(', ')}; a plateau must be at least two cells wide everywhere`);
      }
    }
    const deep = low.filter((l) => l.depth === 2).map((l) => l.side);
    if (deep.some((s) => deep.includes(OPPOSITE[s]) || sidesOf(low, 'hill').includes(OPPOSITE[s]))) {
      errors.push(`cell ${k}: two hill ramps overlap; a hill plateau must be at least four cells wide`);
    }
  }
  if (errors.length) return { pieces, errors, symbols };

  const cornerOf = (low, kind) => {
    const sides = sidesOf(low, kind);
    if (sides.length !== 2) return null;
    for (const pair of Object.keys(CORNER_ROT)) if (sides.includes(pair[0]) && sides.includes(pair[1])) return pair;
    return null;
  };
  for (const kind of ['cliff', 'hill']) {
    for (const [k, { level, low }] of drops) {
      const pair = cornerOf(low, kind);
      if (!pair) continue;
      const [x, z] = unkey(k);
      const ground = low.find((l) => l.depth === 1 && l.kind === kind).ground;
      const rot = CORNER_ROT[pair];
      const rv = ROT_VEC[rot];
      const [cx, cz] = rv(OUTER.corner);
      const origin = [x - cx, z - cz];
      const block = OUTER.cells.map(([a, b]) => { const [dx, dz] = rv([a, b]); return [origin[0] + dx, origin[1] + dz]; });
      const free = block.every(([bx, bz]) => at(bx, bz) === level && !held(kind, bx, bz) && !capped.has(key(bx, bz)));
      const fits = free && block.every(([bx, bz]) => {
        const d = drops.get(key(bx, bz));
        if (kind === 'hill') return d && d.low.every((l) => l.kind === 'hill' && l.ground === ground);
        if (bx === origin[0] && bz === origin[1]) return !d;
        return (bx === x && bz === z) || (d && d.low.length === 1 && d.low[0].kind === 'cliff');
      });
      if (kind === 'cliff' && (corners !== 'wide' || !fits)) {
        take(kind, x, z, 'sharp corner', ground);
        place(kind, 'sharp', x + 0.5, z + 0.5, rot, ground, level, [1, 1], capped.get(k) ?? null);
        continue;
      }
      if (!fits) { errors.push(`cell ${k}: a hill corner needs its 2x2 block free; the plateau is too small here`); continue; }
      for (const [bx, bz] of block) take(kind, bx, bz, 'outer corner', ground);
      place(kind, 'outer', origin[0] + 0.5, origin[1] + 0.5, rot, ground, level);
    }
  }

  for (const [k, level] of cells) {
    const d = drops.get(k);
    if (d && d.low.some((l) => l.depth === 1)) continue;
    const [x, z] = unkey(k);
    for (const [pair, rot] of Object.entries(CORNER_ROT)) {
      const rv = ROT_VEC[rot];
      const [lx, lz] = rv(INNER.cliff.low);
      const lowLevel = at(x + lx, z + lz);
      if (lowLevel === undefined || lowLevel >= level) continue;
      const drop = level - lowLevel;
      const kind = drop === 1 ? 'hill' : drop >= CLIFF ? 'cliff' : null;
      if (!kind || held(kind, x, z)) continue;
      const lips = [[lx, 0], [0, lz]].map(([dx, dz]) => key(x + dx, z + dz));
      const facing = [pair[0], pair[1]];
      const ok = lips.every((lk) => {
        const ld = drops.get(lk);
        return at(...unkey(lk)) === level && ld && ld.low.some((l) => l.depth === 1 && l.kind === kind && l.ground === lowLevel && (l.side === facing[0] || l.side === facing[1]));
      });
      if (!ok) continue;
      const shape = INNER[kind];
      const block = shape.cells.map(([a, b]) => { const [dx, dz] = rv([a, b]); return [x + dx, z + dz]; });
      if (block.some(([bx, bz]) => at(bx, bz) !== level || held(kind, bx, bz) || capped.has(key(bx, bz)))) { errors.push(`cell ${k}: an inner corner collides with a neighbouring corner`); break; }
      for (const [bx, bz] of block) take(kind, bx, bz, 'inner corner', lowLevel);
      if (shape.foot) take(kind, x + lx, z + lz, 'foot', lowLevel);
      place(kind, 'inner', x + 0.5, z + 0.5, rot, lowLevel, level);
      break;
    }
  }

  const runs = new Map();
  for (const [k, { level, low }] of drops) {
    for (const front of low.filter((l) => l.depth === 1)) {
      const { side, ground, kind } = front;
      if (held(kind, ...unkey(k))) continue;
      if (sidesOf(low, kind).length !== 1) continue;
      const [x, z] = unkey(k);
      const along = side === 'W' || side === 'E' ? 'z' : 'x';
      const line = along === 'z' ? x : z;
      const cap = kind === 'cliff' ? capped.get(k) ?? '' : '';
      const runKey = `${kind}|${side}|${level}|${ground}|${line}|${cap}`;
      if (!runs.has(runKey)) runs.set(runKey, []);
      runs.get(runKey).push(along === 'z' ? z : x);
      take(kind, x, z, side, ground);
      if (kind === 'hill') {
        const [dx, dz] = SIDES[OPPOSITE[side]];
        if (at(x + dx, z + dz) !== level) { errors.push(`cell ${k}: a hill ramp needs the cell behind it at the same level`); continue; }
        take(kind, x + dx, z + dz, side, ground);
      }
    }
  }
  for (const [runKey, coords] of runs) {
    const [kind, side, level, ground, line, cap] = runKey.split('|');
    coords.sort((a, b) => a - b);
    let start = coords[0], prev = coords[0];
    const flush = (a, b) => {
      const n = b - a + 1;
      const centre = a + n / 2;
      const [x, z] = side === 'W' || side === 'E' ? [Number(line) + 0.5, centre] : [centre, Number(line) + 0.5];
      place(kind, 'straight', x, z, FACING_ROT[side], Number(ground), Number(level), [1, n], cap === '' ? null : Number(cap));
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
    if (held('hill', ...unkey(k)) || held('cliff', ...unkey(k))) continue;
    const [x, z] = unkey(k);
    slab(x, z, level);
    symbols.set(k, '.');
  }
  for (const [k, levels] of groundUnder) for (const g of levels) slab(...unkey(k), g);
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
  const sorted = [...left].map(unkey).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
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
  for (const k of map.cells.keys()) { const [x, z] = unkey(k); xs.push(x); zs.push(z); }
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
