/* The builder is a tab of the catalog rather than a page of its own, so it
 * builds its own markup into whatever host the catalog hands it and reuses
 * the catalog data the page has already fetched. One instance per page, hence
 * plain module state. */

const CELL = 46;
const PAD = 1.5;

let sockets;
let STEP;
let QUANT;
let names;
let families;
let swatches;

let host;
let grid;
let inspector;
let sheet;
let search;
let familySelect;
let paletteList;
let paletteCount;
let brushLabel;
let levelLabel;
let mirrorButton;

const placements = [];
let nextId = 1;
let brush = null;
let rotation = 0;
let mirrored = false;
let level = 0;
let selected = null;

// ------------------------------------------------------------------ shapes

const decode = (text) =>
  text.split('+').map((part) => part.split(':').map((value) => Number(value) / QUANT));

const columnCache = new Map();
function columns(id) {
  if (!columnCache.has(id)) {
    const shape = sockets.shapes[id];
    columnCache.set(id, shape.uniform ? decode(shape.column) : shape.columns.map(decode));
  }
  return columnCache.get(id);
}

/* A socket reads along the increasing world axis of its seam. Rotating or
 * mirroring a piece can flip which end that is, so the reading is reversed
 * rather than the stored shape being rewritten. */
function columnOf(socket, index) {
  const shape = sockets.shapes[socket.shape];
  if (shape.uniform) return columns(socket.shape);
  const list = columns(socket.shape);
  const i = socket.flipped ? list.length - 1 - index : index;
  return list[i] ?? null;
}

// ------------------------------------------------------------- placements

// Rotation is a quarter turn about the vertical axis: (x, z) → (z, −x).
// Mirroring negates x first, matching how the pack's own assemblies place a
// mirrored piece with a scale of −1 on x.
function place(point, rot, mirror) {
  let [x, z] = mirror ? [-point[0], point[1]] : point;
  for (let i = 0; i < rot; i++) [x, z] = [z, -x];
  return [x, z];
}

function worldCells(placement) {
  const piece = sockets.pieces[placement.piece];
  return piece.cells.map((cell) => {
    const [x, z] = place(cell, placement.rot, placement.mirror);
    return [x + placement.cx, z + placement.cz];
  });
}

function worldSockets(placement) {
  const piece = sockets.pieces[placement.piece];
  const cells = worldCells(placement);

  return piece.sockets.map((socket, index) => {
    const ends = socket.axis === 'x'
      ? [[socket.at, socket.from], [socket.at, socket.to]]
      : [[socket.from, socket.at], [socket.to, socket.at]];
    const [a, b] = ends.map((end) => place(end, placement.rot, placement.mirror));

    const axis = Math.abs(a[0] - b[0]) < 1e-6 ? 'x' : 'z';
    const along = axis === 'x' ? 1 : 0;
    const across = axis === 'x' ? 0 : 1;
    const at = (axis === 'x' ? a[0] : a[1]) + (axis === 'x' ? placement.cx : placement.cz);

    // A socket looks away from its own piece. Without that, two pieces sitting
    // side by side would have their co-planar faces read as a joint, when in
    // truth both are facing the same way.
    const centre = cells.reduce((sum, cell) => sum + cell[across], 0) / cells.length;

    return {
      index,
      owner: placement.id,
      color: socket.color,
      shape: socket.shape,
      axis,
      at,
      facing: at > centre ? 1 : -1,
      flipped: a[along] > b[along],
      from: Math.min(a[along], b[along]) + (axis === 'x' ? placement.cz : placement.cx),
      to: Math.max(a[along], b[along]) + (axis === 'x' ? placement.cz : placement.cx),
      floor: socket.base + placement.level,
    };
  });
}

const height = (placement) => {
  const piece = sockets.pieces[placement.piece];
  return [(piece.min?.[1] ?? 0) + placement.level, (piece.max?.[1] ?? 0) + placement.level];
};

// ------------------------------------------------------------- validation

const steps = (socket) => Math.round((socket.to - socket.from) / STEP);
const same = (a, b) => a.length === b.length
  && a.every(([lo, hi], i) => Math.abs(lo - b[i][0]) < 1e-6 && Math.abs(hi - b[i][1]) < 1e-6);

const lift = (column, floor) => column.map(([lo, hi]) => [lo + floor, hi + floor]);

/* Both sides of a joint are sampled on the same lattice along the same world
 * axis, so agreement is a column-by-column comparison over the overlap — no
 * alignment to guess, and a longer piece meeting a shorter one simply mates
 * over the part they share. */
function compare(a, b) {
  const from = Math.max(a.from, b.from);
  const to = Math.min(a.to, b.to);
  const count = Math.round((to - from) / STEP);
  if (count <= 0) return null;

  let agree = 0;
  let conflict = 0;
  for (let k = 0; k < count; k++) {
    const u = from + k * STEP;
    const one = columnOf(a, Math.round((u - a.from) / STEP));
    const two = columnOf(b, Math.round((u - b.from) / STEP));
    if (!one || !two) continue;
    if (same(lift(one, a.floor), lift(two, b.floor))) agree++;
    else conflict++;
  }
  return { overlap: count, agree, conflict, from, to };
}

function evaluate() {
  const all = placements.flatMap((placement) => worldSockets(placement));
  const occupied = new Map();
  for (const placement of placements) {
    for (const [x, z] of worldCells(placement)) {
      const key = `${x},${z},${placement.level}`;
      if (!occupied.has(key)) occupied.set(key, []);
      occupied.get(key).push(placement.id);
    }
  }

  for (const socket of all) {
    socket.partners = [];
    socket.agree = 0;
    socket.conflict = 0;
    for (const other of all) {
      if (other.owner === socket.owner) continue;
      if (other.axis !== socket.axis || Math.abs(other.at - socket.at) > 1e-6) continue;
      if (other.facing === socket.facing) continue;
      const result = compare(socket, other);
      if (!result) continue;
      socket.partners.push({ socket: other, ...result });
      socket.agree += result.agree;
      socket.conflict += result.conflict;
    }

    // A seam that is only partly covered is fine — a long piece can meet a
    // short one. A seam where facing columns disagree is not: that is two
    // profiles pushed into the same place.
    const total = steps(socket);
    socket.verdict = !socket.partners.length ? 'open'
      : socket.conflict > 0 ? 'clash'
        : socket.agree >= total ? 'mated'
          : 'partial';
    socket.covered = total ? socket.agree / total : 0;
  }

  // A neighbouring cell with no facing socket is not a fault — most of the
  // pack's vertical contacts work that way — but it is worth showing.
  for (const socket of all) {
    if (socket.verdict !== 'open') continue;
    const side = socket.axis === 'x' ? [[0.5, 0], [-0.5, 0]] : [[0, 0.5], [0, -0.5]];
    const mid = (socket.from + socket.to) / 2;
    socket.abuts = side.some(([dx, dz]) => {
      const x = Math.round((socket.axis === 'x' ? socket.at : mid) + dx);
      const z = Math.round((socket.axis === 'x' ? mid : socket.at) + dz);
      const owners = occupied.get(`${x},${z},${placementById(socket.owner).level}`) ?? [];
      return owners.some((id) => id !== socket.owner);
    });
  }

  return all;
}

const placementById = (id) => placements.find((placement) => placement.id === id);

function stacking(placement) {
  const [bottom] = height(placement);
  const under = [];
  const over = [];
  const mine = new Set(worldCells(placement).map(([x, z]) => `${x},${z}`));

  for (const other of placements) {
    if (other.id === placement.id) continue;
    const overlap = worldCells(other).some(([x, z]) => mine.has(`${x},${z}`));
    if (!overlap) continue;
    const [otherBottom, otherTop] = height(other);
    if (Math.abs(bottom - otherTop) < 1e-6) under.push(other);
    if (Math.abs(otherBottom - height(placement)[1]) < 1e-6) over.push(other);
  }
  return { under, over };
}

// ---------------------------------------------------------------- drawing

const svg = (tag, attributes = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
};

function bounds() {
  const cells = placements.flatMap(worldCells);
  if (!cells.length) return { x0: -4, z0: -4, x1: 4, z1: 4 };
  return {
    x0: Math.min(...cells.map((c) => c[0])) - PAD,
    z0: Math.min(...cells.map((c) => c[1])) - PAD,
    x1: Math.max(...cells.map((c) => c[0])) + PAD,
    z1: Math.max(...cells.map((c) => c[1])) + PAD,
  };
}

function render() {
  const view = bounds();
  const width = (view.x1 - view.x0 + 1) * CELL;
  const depth = (view.z1 - view.z0 + 1) * CELL;
  const sx = (x) => (x - view.x0) * CELL;
  const sz = (z) => (z - view.z0) * CELL;

  grid.setAttribute('viewBox', `0 0 ${width} ${depth}`);
  grid.setAttribute('width', width);
  grid.setAttribute('height', depth);
  grid.replaceChildren();

  const lines = svg('g', { class: 'grid-lines' });
  for (let x = Math.floor(view.x0); x <= Math.ceil(view.x1) + 1; x++) {
    lines.append(svg('line', { x1: sx(x - 0.5), y1: 0, x2: sx(x - 0.5), y2: depth }));
  }
  for (let z = Math.floor(view.z0); z <= Math.ceil(view.z1) + 1; z++) {
    lines.append(svg('line', { x1: 0, y1: sz(z - 0.5), x2: width, y2: sz(z - 0.5) }));
  }
  grid.append(lines);

  const hits = svg('g', { class: 'grid-hits' });
  for (let x = Math.floor(view.x0); x <= Math.ceil(view.x1); x++) {
    for (let z = Math.floor(view.z0); z <= Math.ceil(view.z1); z++) {
      const cell = svg('rect', {
        x: sx(x - 0.5), y: sz(z - 0.5), width: CELL, height: CELL, class: 'cell',
        'data-x': x, 'data-z': z,
      });
      cell.addEventListener('click', () => (brush ? addAt(x, z) : select(topmostAt(x, z))));
      hits.append(cell);
    }
  }
  grid.append(hits);

  const bodies = svg('g', { class: 'bodies' });
  for (const placement of [...placements].sort((a, b) => a.level - b.level)) {
    const group = svg('g', {
      class: `body${placement.id === selected ? ' is-selected' : ''}`,
      'data-level': placement.level,
    });
    const cells = worldCells(placement);
    for (const [x, z] of cells) {
      group.append(svg('rect', { x: sx(x - 0.5) + 2, y: sz(z - 0.5) + 2, width: CELL - 4, height: CELL - 4, rx: 4 }));
    }

    // Labels are clipped to the footprint they sit on, so a big name on a
    // one-cell piece cannot run across its neighbours.
    const span = Math.max(...cells.map((c) => c[0])) - Math.min(...cells.map((c) => c[0])) + 1;
    const label = svg('text', {
      x: sx(cells.reduce((sum, c) => sum + c[0], 0) / cells.length),
      y: sz(cells.reduce((sum, c) => sum + c[1], 0) / cells.length) + 4,
      class: 'body-label',
    });
    label.textContent = clip(short(placement.piece), Math.floor(span * CELL / 4.6));
    const title = svg('title');
    title.textContent = names.get(placement.piece) ?? placement.piece;
    label.append(title);
    group.append(label);
    bodies.append(group);
  }
  grid.append(bodies);

  const seams = svg('g', { class: 'seams' });
  for (const socket of evaluate()) {
    const isSelected = socket.owner === selected;
    const classes = ['seam', socket.verdict === 'open' && socket.abuts ? 'abut' : socket.verdict];
    if (isSelected) classes.push('is-selected');
    const line = socket.axis === 'x'
      ? { x1: sx(socket.at), y1: sz(socket.from - 0.5) + CELL / 2, x2: sx(socket.at), y2: sz(socket.to - 0.5) + CELL / 2 }
      : { x1: sx(socket.from - 0.5) + CELL / 2, y1: sz(socket.at), x2: sx(socket.to - 0.5) + CELL / 2, y2: sz(socket.at) };
    seams.append(svg('line', { ...line, class: classes.join(' ') }));
  }
  grid.append(seams);
}

const short = (id) => id.replace(/_/g, ' ').replace(/\s(Base|Mid|Top|Under)$/, '');
const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`);

// ---------------------------------------------------------------- editing

/* Bodies do not take clicks: laying a surface layer means clicking a cell
 * that is already occupied, so the grid always answers the click. With a
 * piece loaded a click places it; with none, a click selects what is there. */
function topmostAt(x, z) {
  const hits = placements.filter((placement) =>
    worldCells(placement).some(([cx, cz]) => cx === x && cz === z));
  return hits.sort((a, b) => height(a)[1] - height(b)[1]).pop()?.id ?? null;
}

function addAt(x, z) {
  if (!brush) return;
  const id = nextId++;
  placements.push({ id, piece: brush, cx: x, cz: z, level, rot: rotation, mirror: mirrored });
  selected = id;
  render();
  showInspector();

  // Keep the piece list up while building — the seam report only takes the
  // sheet over when the placement actually went wrong.
  if (evaluate().some((socket) => socket.owner === id && socket.verdict === 'clash')) showSheet('seams');
}

/* One column means the palette and the seam report cannot both be on screen,
 * so they share a sheet under the grid. Placing or picking a piece moves the
 * sheet to whichever of the two the next step needs. */
function showSheet(name) {
  if (!sheet) return;
  for (const [key, part] of Object.entries(sheet)) {
    part.tab.setAttribute('aria-selected', String(key === name));
    part.panel.hidden = key !== name;
  }
}

function select(id) {
  selected = id;
  render();
  showInspector();
  if (id !== null) showSheet('seams');
}

function remove(id) {
  const index = placements.findIndex((placement) => placement.id === id);
  if (index >= 0) placements.splice(index, 1);
  selected = null;
  render();
  showInspector();
}

// -------------------------------------------------------------- inspector

const pct = (value) => `${Math.round(value * 100)}%`;

function openAdvice(shapeId) {
  const shape = sockets.shapes[shapeId];
  const seen = shape.open + shape.mated;
  if (!seen) return { tone: 'unknown', text: 'never seen in the shipped scenes — no evidence either way' };
  const share = shape.open / seen;
  if (share >= 0.6) return { tone: 'fine', text: `left open in ${pct(share)} of ${seen} uses — normally exposed on purpose` };
  if (share >= 0.2) return { tone: 'mixed', text: `left open in ${pct(share)} of ${seen} uses — either way is used` };
  return { tone: 'wants', text: `left open in only ${pct(share)} of ${seen} uses — this edge usually wants a neighbour` };
}

/* Which pieces would mate into an open seam: every piece, in each of its
 * eight placements, is asked whether one of its sockets would agree with this
 * one from the neighbouring cell. */
function candidates(socket) {
  const found = [];
  const dx = socket.axis === 'x' ? (socket.at > placementById(socket.owner).cx ? 1 : -1) : 0;
  const dz = socket.axis === 'z' ? (socket.at > placementById(socket.owner).cz ? 1 : -1) : 0;
  const mid = Math.round((socket.from + socket.to) / 2 - 0.5);
  const cx = socket.axis === 'x' ? Math.round(socket.at + dx / 2) : mid;
  const cz = socket.axis === 'z' ? Math.round(socket.at + dz / 2) : mid;

  for (const piece of Object.keys(sockets.pieces)) {
    for (let rot = 0; rot < 4; rot++) {
      for (const mirror of [false, true]) {
        const trial = { id: -1, piece, cx, cz, level: placementById(socket.owner).level, rot, mirror };
        for (const other of worldSockets(trial)) {
          if (other.axis !== socket.axis || Math.abs(other.at - socket.at) > 1e-6) continue;
          if (other.facing === socket.facing) continue;
          const result = compare(socket, other);
          if (!result || result.agree === 0) continue;
          found.push({ piece, rot, mirror, agree: result.agree, of: steps(socket) });
        }
      }
    }
  }

  const best = new Map();
  for (const entry of found) {
    const current = best.get(entry.piece);
    if (!current || entry.agree > current.agree) best.set(entry.piece, entry);
  }
  return [...best.values()].sort((a, b) => b.agree - a.agree);
}

/* Nothing in the pack marks a surface as something you may build on, so the
 * suggestions come from what the dioramas do: how often each family was laid
 * on top of this one. */
function laidOn(family) {
  return Object.entries(sockets.stacks ?? {})
    .filter(([key]) => key.split('>')[0] === family)
    .map(([key, count]) => ({ family: key.split('>')[1], count }))
    .sort((a, b) => b.count - a.count);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showInspector() {
  inspector.replaceChildren();
  const placement = placements.find((entry) => entry.id === selected);
  if (!placement) {
    inspector.append(element('p', 'inspect-empty',
      'Clear the loaded piece with Esc, then click the grid to inspect what is placed there.'));
    return;
  }

  const piece = sockets.pieces[placement.piece];
  inspector.append(element('h2', null, names.get(placement.piece) ?? placement.piece));
  inspector.append(element('p', 'inspect-meta',
    `${families.get(piece.family) ?? piece.family ?? 'unclassified'} · ${piece.size ?? '—'} · level ${placement.level}`
    + `${placement.rot ? ` · turned ${placement.rot * 90}°` : ''}${placement.mirror ? ' · mirrored' : ''}`));

  const actions = element('div', 'inspect-actions');
  const drop = element('button', null, 'Remove');
  drop.addEventListener('click', () => remove(placement.id));
  actions.append(drop);
  inspector.append(actions);

  const mine = evaluate().filter((socket) => socket.owner === placement.id);
  inspector.append(element('h3', null, `Seams (${mine.length})`));

  const list = element('ul', 'seam-list');
  for (const socket of mine) {
    const item = element('li', `seam-item ${socket.verdict === 'open' && socket.abuts ? 'abut' : socket.verdict}`);
    const head = element('div', 'seam-head');
    head.append(swatch(socket.color));
    head.append(element('strong', null, socket.color.replace('Hidden ', '') || 'Hidden'));
    head.append(element('span', 'seam-where', `${socket.axis === 'x' ? 'x' : 'z'} = ${socket.at}`));
    head.append(element('span', `seam-verdict ${socket.verdict}`, verdictLabel(socket)));
    item.append(head);

    if (socket.verdict === 'clash') {
      for (const partner of socket.partners) {
        const other = placementById(partner.socket.owner);
        item.append(element('p', 'seam-note',
          `meets ${short(other.piece)} — ${partner.socket.color.replace('Hidden ', '')}`
          + `${partner.socket.color === socket.color ? ' (same colour, different profile)' : ''}`
          + ` — ${pct(partner.conflict / partner.overlap)} of the shared span disagrees`));
      }
    } else if (socket.verdict === 'partial') {
      item.append(element('p', 'seam-note', `${pct(socket.covered)} of this seam mates; the rest has no neighbour`));
    } else if (socket.verdict === 'open') {
      const advice = openAdvice(socket.shape);
      item.append(element('p', `seam-note ${advice.tone}`, advice.text));
      if (socket.abuts) item.append(element('p', 'seam-note', 'a piece sits in the next cell but presents no socket here'));
      const button = element('button', 'seam-fits', 'What fits here?');
      button.addEventListener('click', () => showCandidates(item, socket, button));
      item.append(button);
    }
    list.append(item);
  }
  inspector.append(list);

  if (piece.unchecked) {
    inspector.append(element('p', 'inspect-warn',
      `${piece.unchecked} curved or off-grid face${piece.unchecked === 1 ? '' : 's'} on this piece cannot be checked against a neighbouring cell.`));
  }

  const { under, over } = stacking(placement);
  const [bottom, top] = height(placement);
  inspector.append(element('h3', null, 'Stacking'));
  const stack = element('ul', 'stack-list');
  stack.append(element('li', null, `occupies y ${bottom} … ${top}`));
  for (const other of under) stack.append(element('li', 'rests', `rests on ${short(other.piece)}`));
  for (const other of over) stack.append(element('li', 'rests', `${short(other.piece)} rests on this`));
  inspector.append(stack);

  const suggestions = laidOn(piece.family);
  if (suggestions.length) {
    inspector.append(element('p', 'seam-note',
      'Laid on top rather than butted — no socket is involved, so set the level and place:'));
    const laid = element('ul', 'fits-list');
    for (const entry of suggestions.slice(0, 6)) {
      const item = element('li');
      const button = element('button', null, `${families.get(entry.family) ?? entry.family} · ${entry.count}×`);
      button.addEventListener('click', () => {
        level = top;
        familySelect.value = entry.family;
        search.value = '';
        syncToolbar();
      });
      item.append(button);
      laid.append(item);
    }
    inspector.append(laid);
  } else {
    inspector.append(element('p', 'seam-note', 'nothing was ever laid on this family in the shipped dioramas'));
  }
}

function verdictLabel(socket) {
  if (socket.verdict === 'mated') return 'mates';
  if (socket.verdict === 'partial') return 'part';
  if (socket.verdict === 'clash') return 'will not fit';
  return socket.abuts ? 'open, abuts' : 'open';
}

function swatch(color) {
  const node = element('i', 'swatch');
  node.style.background = swatches.get(color) ?? '#f8f8f8';
  return node;
}

function showCandidates(item, socket, button) {
  button.remove();
  const matches = candidates(socket);
  if (!matches.length) {
    item.append(element('p', 'seam-note wants', 'no piece in the pack presents a matching profile here'));
    return;
  }
  const list = element('ul', 'fits-list');
  for (const match of matches.slice(0, 12)) {
    const entry = element('li');
    const button2 = element('button', null,
      `${short(match.piece)}${match.rot ? ` · ${match.rot * 90}°` : ''}${match.mirror ? ' · mirrored' : ''}`
      + `${match.agree < match.of ? ` · ${pct(match.agree / match.of)}` : ''}`);
    button2.addEventListener('click', () => {
      brush = match.piece;
      rotation = match.rot;
      mirrored = match.mirror;
      syncToolbar();
    });
    entry.append(button2);
    list.append(entry);
  }
  item.append(element('p', 'seam-note', `${matches.length} piece${matches.length === 1 ? '' : 's'} would mate here — click to load one:`));
  item.append(list);
}

// ---------------------------------------------------------------- palette

function renderPalette() {
  const term = search.value.trim().toLowerCase();
  const family = familySelect.value;
  const matches = Object.entries(sockets.pieces).filter(([id, piece]) =>
    (!family || piece.family === family)
    && (!term || id.toLowerCase().includes(term) || (names.get(id) ?? '').toLowerCase().includes(term)));

  paletteCount.textContent = `${matches.length} piece${matches.length === 1 ? '' : 's'}`;
  paletteList.replaceChildren();
  for (const [id, piece] of matches.slice(0, 300)) {
    const item = element('li');
    const button = element('button', id === brush ? 'is-brush' : null);
    button.append(element('span', 'piece-name', names.get(id) ?? id));
    const colours = element('span', 'piece-colors');
    for (const color of [...new Set(piece.sockets.map((socket) => socket.color))]) colours.append(swatch(color));
    if (!piece.sockets.length) colours.append(element('span', 'piece-none', 'no sockets'));
    button.append(colours);
    button.addEventListener('click', () => { brush = brush === id ? null : id; syncToolbar(); });
    item.append(button);
    paletteList.append(item);
  }
}

// ---------------------------------------------------------------- toolbar

function syncToolbar() {
  brushLabel.textContent = brush
    ? `${names.get(brush) ?? brush}${rotation ? ` · ${rotation * 90}°` : ''}${mirrored ? ' · mirrored' : ''}`
    : 'Pick a piece to place — or click the grid to inspect';
  levelLabel.textContent = `level ${Number(level.toFixed(3))}`;
  mirrorButton.setAttribute('aria-pressed', String(mirrored));
  renderPalette();
}

export async function mount(container, catalog) {
  host = container;
  const version = document.querySelector('meta[name="catalog-version"]')?.content;
  const url = version ? `catalog/sockets.json?v=${version}` : 'catalog/sockets.json';
  sockets = await fetch(url).then((response) => {
    if (!response.ok) throw new Error(`catalog/sockets.json not found (${response.status})`);
    return response.json();
  });
  STEP = sockets.step;
  QUANT = sockets.quant ?? 256;

  names = new Map(catalog.models.map((entry) => [entry.id, entry.name]));
  families = new Map(Object.entries(catalog.facets ?? {}));
  swatches = new Map(
    (catalog.palettes?.find((palette) => palette.id === 'hidden')?.colors ?? [])
      .map((color) => [color.source, color.hex]),
  );

  // The markup lives in index.html as a template so this module never has to
  // write HTML from a string.
  const template = document.querySelector('#builder-template');
  if (!template) throw new Error('#builder-template is missing from the page');
  container.replaceChildren(template.content.cloneNode(true));
  const role = (name) => container.querySelector(`[data-role="${name}"]`);

  grid = role('grid');
  inspector = role('panel-seams');
  search = role('search');
  familySelect = role('family');
  paletteList = role('list');
  paletteCount = role('count');
  brushLabel = role('brush');
  levelLabel = role('level');
  mirrorButton = role('mirror');

  familySelect.append(new Option('All families', ''));
  for (const id of [...new Set(Object.values(sockets.pieces).map((piece) => piece.family))].filter(Boolean).sort()) {
    familySelect.append(new Option(families.get(id) ?? id, id));
  }

  role('rotate').addEventListener('click', () => { rotation = (rotation + 1) % 4; syncToolbar(); });
  mirrorButton.addEventListener('click', () => { mirrored = !mirrored; syncToolbar(); });
  role('up').addEventListener('click', () => { level += 1; syncToolbar(); });
  role('down').addEventListener('click', () => { level -= 1; syncToolbar(); });
  role('clear').addEventListener('click', () => {
    placements.length = 0;
    selected = null;
    render();
    showInspector();
  });

  sheet = {
    pieces: { tab: role('tab-pieces'), panel: role('panel-pieces') },
    seams: { tab: role('tab-seams'), panel: role('panel-seams') },
  };
  for (const name of Object.keys(sheet)) {
    sheet[name].tab.addEventListener('click', () => showSheet(name));
  }

  search.addEventListener('input', renderPalette);
  familySelect.addEventListener('change', renderPalette);

  // Shortcuts belong to this tab, not the whole catalog.
  document.addEventListener('keydown', (event) => {
    if (host.hidden || event.target.matches('input, select, textarea')) return;
    if (event.key === 'Escape') { brush = null; syncToolbar(); }
    if (event.key === 'r' || event.key === 'R') { rotation = (rotation + 1) % 4; syncToolbar(); }
    if (event.key === 'm' || event.key === 'M') { mirrored = !mirrored; syncToolbar(); }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected) { event.preventDefault(); remove(selected); }
  });

  syncToolbar();
  render();
  showInspector();
}
