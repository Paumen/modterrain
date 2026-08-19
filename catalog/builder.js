import { observe } from './previews.js';

/* The builder is a tab of the catalog rather than a page of its own, so it
 * builds its own markup into whatever host the catalog hands it and reuses
 * the catalog data the page has already fetched. One instance per page, hence
 * plain module state. */

let sockets;
let STEP;
let QUANT;
let names;
let families;
let swatches;

let host;
let viewport;
let drawer;
let undoButton;
let redoButton;
let inspector;
let sheet;
let familySelect;
let paletteList;
let brushLabel;
let levelLabel;
let mirrorButton;
let removeButton;

const placements = [];
let nextId = 1;
let brush = null;
let rotation = 0;
let mirrored = false;
let level = 0;
let selected = null;
let armed = null;
let moveButtons = {};
let placeButton;

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

/* The viewport owns the three.js scene; this module only tells it what is
 * placed and how each seam came out. Seams carry their own height so the
 * overlay sits exactly where the sockets meet. */
function render() {
  if (!viewport) return;
  const sockets_ = evaluate().map((socket) => ({
    ...socket,
    height: Math.max(sockets.shapes[socket.shape]?.height ?? 0, 0.02),
  }));
  viewport.sync(placements, sockets_, selected);
}

const short = (id) => id.replace(/_/g, ' ').replace(/\s(Base|Mid|Top|Under)$/, '');

// ------------------------------------------------------------------ save

const STORAGE = 'modterrain-build';

/* A build is a list of placements and nothing else, so it saves as plain
 * JSON: small enough to keep in the browser between visits, and readable
 * enough to hand to tools/assemble.mjs or keep under version control. */
const toJson = () => JSON.stringify({
  format: 'modterrain-build/1',
  units: 'cells',
  placements: placements.map(({ id, ...rest }) => rest),
}, null, 1);

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function load(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.placements;
  if (!Array.isArray(list)) throw new Error('no placements in that file');

  placements.length = 0;
  for (const entry of list) {
    const piece = sockets.pieces[entry.piece];
    if (!piece) continue;
    placements.push({
      id: nextId++,
      piece: entry.piece,
      dir: piece.dir,
      scale: piece.scale,
      cx: Math.round(entry.cx ?? 0),
      cz: Math.round(entry.cz ?? 0),
      level: entry.level ?? 0,
      rot: ((entry.rot ?? 0) % 4 + 4) % 4,
      mirror: Boolean(entry.mirror),
    });
  }
  selected = null;
  commit();
  render();
  showInspector();
  showPick();
}

// The board survives a reload without anyone having to remember to save it.
function remember() {
  try { localStorage.setItem(STORAGE, toJson()); } catch { /* private mode, or full */ }
}

// ---------------------------------------------------------------- history

/* Undo keeps whole snapshots of the board. Placements are a handful of plain
 * numbers each, so copying the lot is cheaper than describing every edit. */
const past = [];
let at = -1;

function commit() {
  past.length = at + 1;
  past.push(JSON.stringify(placements));
  at = past.length - 1;
  syncHistory();
  remember();
}

function step(to) {
  if (to < 0 || to >= past.length) return;
  at = to;
  placements.length = 0;
  placements.push(...JSON.parse(past[at]));
  if (!placements.some((placement) => placement.id === selected)) selected = null;
  syncHistory();
  remember();
  render();
  showInspector();
  showPick();
}

function syncHistory() {
  if (!undoButton) return;
  undoButton.disabled = at <= 0;
  redoButton.disabled = at >= past.length - 1;
}

// ---------------------------------------------------------------- editing

/* Picking a piece arms it straight away, so the ghost is on the board before
 * anything is aimed: you steer it there and press Place. Nothing is ever laid
 * down by a tap, so turning the camera or thinking again about where a piece
 * goes cannot drop one by accident. */
function arm(x, z) {
  armed = { cx: x, cz: z };
  syncToolbar();
}

// The arrows read as the screen does, not as the grid does: after the camera
// has been turned, "left" still means towards the left of the view.
function nudge(dx, dz) {
  if (!armed) return;
  const { right, away } = viewport?.axes() ?? { right: [1, 0], away: [0, -1] };
  arm(armed.cx + right[0] * dx + away[0] * dz, armed.cz + right[1] * dx + away[1] * dz);
}

const nearLast = () => {
  const last = placements[placements.length - 1];
  return last ? { cx: last.cx, cz: last.cz } : { cx: 0, cz: 0 };
};

function commitArmed() {
  if (!armed) return;
  addAt(armed.cx, armed.cz);
  // The ghost stays where it was laid, so a row of the same piece is a nudge
  // and a press each time rather than a fresh aim.
  syncToolbar();
}

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
  addPiece(brush, { cx: x, cz: z, level, rot: rotation, mirror: mirrored });
}

function addPiece(pieceId, { cx, cz, level: at, rot, mirror }) {
  const piece = sockets.pieces[pieceId];
  if (!piece) return;
  const id = nextId++;
  placements.push({ id, piece: pieceId, dir: piece.dir, scale: piece.scale, cx, cz, level: at, rot, mirror });
  selected = id;
  render();
  showInspector();

  commit();
  showPick();

  // Keep the piece list up while building — the seam report only takes the
  // drawer over when the placement actually went wrong.
  if (evaluate().some((socket) => socket.owner === id && socket.verdict === 'clash')) {
    showSheet('seams');
    openDrawer(true);
  }
  return id;
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
  armed = null;
  selected = id;
  render();
  showInspector();
  showPick();
}

function remove(id) {
  const index = placements.findIndex((placement) => placement.id === id);
  if (index < 0) return;
  placements.splice(index, 1);
  selected = null;
  commit();
  render();
  showInspector();
  showPick();
}

function showPick() {
  if (removeButton) removeButton.disabled = !placements.some((entry) => entry.id === selected);
}

/* Shut, part-open, open. The chevron walks up through them and back down
 * from the top, so one control covers every height. */
const HEIGHTS = ['shut', 'half', 'full'];

function setDrawer(height) {
  if (!drawer) return;
  drawer.root.dataset.height = height;
  measureDrawer();
}

function openDrawer(open) {
  if (!drawer) return;
  if (!open) return setDrawer('shut');
  if (drawer.root.dataset.height === 'shut') setDrawer('half');
}

/* Whatever floats over the view has to clear the drawer, and the drawer's
 * visible height changes as it slides, so it is measured rather than assumed.
 * The camera is told the same numbers: it frames the build into the band the
 * panels leave clear, and the picker is open for most of a build. */
function measureDrawer() {
  if (!drawer || !host) return;
  const view = host.getBoundingClientRect();
  const sheetTop = drawer.root.getBoundingClientRect().top;
  const covered = Math.max(0, Math.round(view.bottom - sheetTop));
  host.style.setProperty('--drawer', `${covered}px`);

  const rect = (selector) => host.querySelector(selector)?.getBoundingClientRect();
  const bar = rect('.hud-top');
  const cameras = rect('.hud-views');
  viewport?.setInsets({
    top: bar ? Math.max(0, Math.round(bar.bottom - view.top)) : 0,
    right: cameras ? Math.max(0, Math.round(view.right - cameras.left)) : 0,
    bottom: covered,
  });
}

// -------------------------------------------------------------- inspector

const pct = (value) => `${Math.round(value * 100)}%`;

function openAdvice(shapeId) {
  const shape = sockets.shapes[shapeId];
  const seen = (shape?.open ?? 0) + (shape?.mated ?? 0);
  if (!seen) return { tone: 'unknown', text: 'never seen in the scenes' };
  const share = shape.open / seen;
  if (share >= 0.6) return { tone: 'fine', text: `usually left open (${pct(share)} of ${seen})` };
  if (share >= 0.2) return { tone: 'mixed', text: `open either way (${pct(share)} of ${seen})` };
  return { tone: 'wants', text: `usually wants a neighbour (open ${pct(share)} of ${seen})` };
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
          found.push({ piece, rot, mirror, cx, cz, level: trial.level, agree: result.agree, of: steps(socket) });
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

  /* One line a seam: the colour, where it is, and how it came out. The detail
   * only appears where there is something to say about it. */
  const list = element('ul', 'seam-list');
  for (const socket of mine) {
    const tone = socket.verdict === 'open' && socket.abuts ? 'abut' : socket.verdict;
    const item = element('li', `seam-item ${tone}`);

    const head = element('div', 'seam-head');
    head.append(swatch(socket.color));
    head.append(element('span', 'seam-where', `${socket.axis} ${socket.at}`));
    head.append(element('span', `seam-verdict ${tone}`, verdictLabel(socket)));
    item.append(head);

    if (socket.verdict === 'clash') {
      const other = placementById(socket.partners[0].socket.owner);
      item.append(element('p', 'seam-note', `against ${short(other.piece)}`));
    } else if (socket.verdict === 'partial') {
      item.append(element('p', 'seam-note', `${pct(socket.covered)} of it mates`));
    } else if (socket.verdict === 'open') {
      const advice = openAdvice(socket.shape);
      item.append(element('p', `seam-note ${advice.tone}`, advice.text));
      const button = element('button', 'seam-fits', 'What fits?');
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
        familySelect.value = `atoms:${entry.family}`;
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
  if (socket.verdict === 'clash') return 'clashes';
  return socket.abuts ? 'abuts' : 'open';
}

function swatch(color) {
  const node = element('i', 'socket-dot');
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
  /* The same tile as the piece list, and choosing one puts it on the board:
   * the cell, the turn and the mirror are all already known — that is what
   * made it a candidate. */
  const list = element('ul', 'fits-list palette-list');
  for (const match of matches.slice(0, 12)) {
    const piece = sockets.pieces[match.piece];
    const name = names.get(match.piece) ?? match.piece;
    const entry = element('li');
    const tile = element('button', 'tile');
    tile.title = `${name}${match.rot ? ` · ${match.rot * 90}°` : ''}${match.mirror ? ' · mirrored' : ''}`
      + `${match.agree < match.of ? ` · covers ${pct(match.agree / match.of)}` : ''}`;

    const box = element('span', 'tile-view');
    box.dataset.src = `${piece.dir}/${match.piece}.glb`;
    box.dataset.alt = `3D model ${name}`;
    tile.append(box);
    if (match.agree < match.of) tile.append(element('span', 'tile-part', pct(match.agree / match.of)));
    tile.append(element('span', 'tile-name', name));

    tile.addEventListener('click', () => {
      addPiece(match.piece, { cx: match.cx, cz: match.cz, level: match.level, rot: match.rot, mirror: match.mirror });
      showSheet('seams');
    });
    entry.append(tile);
    list.append(entry);
    observe(box);
  }
  item.append(element('p', 'seam-note', `${matches.length} would mate — tap to attach:`));
  item.append(list);
}

// ---------------------------------------------------------------- palette

function renderPalette() {
  const [dir, family] = familySelect.value.split(':');
  const matches = Object.entries(sockets.pieces).filter(([, piece]) =>
    (!dir || piece.dir === dir) && (!family || piece.family === family));

  paletteList.replaceChildren();

  /* The same lazy 3D preview the catalog grid uses: you pick a piece by
   * looking at it, not by reading its name. */
  for (const [id, piece] of matches) {
    const name = names.get(id) ?? id;
    const item = element('li');
    const button = element('button', `tile${id === brush ? ' is-brush' : ''}`);
    button.dataset.piece = id;
    button.title = name;

    const box = element('span', 'tile-view');
    box.dataset.src = `${piece.dir}/${id}.glb`;
    box.dataset.alt = `3D model ${name}`;
    button.append(box);

    const colours = element('span', 'tile-colors');
    for (const color of [...new Set(piece.sockets.map((socket) => socket.color))]) colours.append(swatch(color));
    button.append(colours);
    button.append(element('span', 'tile-name', name));

    button.addEventListener('click', () => {
      brush = brush === id ? null : id;
      // The ghost appears where you were last building, not at the origin:
      // after opening a saved build, the middle of the board is nowhere near
      // what is on it.
      armed = brush ? (armed ?? nearLast()) : null;
      syncToolbar();
    });
    item.append(button);
    paletteList.append(item);
    observe(box);
  }
}

/* Turning, mirroring or nudging a piece changes nothing about the list of
 * pieces, so the list is left alone and only the highlight moves. Rebuilding
 * it threw away every preview in it, and each one then loaded its model over
 * again — the whole picker flickering through its thumbnails on every press
 * of an arrow. */
function markBrush() {
  if (!paletteList) return;
  for (const tile of paletteList.querySelectorAll('.tile')) {
    tile.classList.toggle('is-brush', tile.dataset.piece === brush);
  }
}

// ---------------------------------------------------------------- toolbar

function showGhost(x, z) {
  const piece = sockets.pieces[brush];
  if (!piece) return viewport?.ghost(null);
  viewport?.ghost({
    piece: brush, dir: piece.dir, scale: piece.scale, cx: x, cz: z, level, rot: rotation, mirror: mirrored,
  });
}

function syncToolbar() {
  const name = brush ? (names.get(brush) ?? brush) : null;
  brushLabel.textContent = !name ? 'Pick a piece — steer it with the arrows, then press Place'
    : `${name}${rotation ? ` · ${rotation * 90}°` : ''}${mirrored ? ' · mirrored' : ''}`;
  levelLabel.textContent = String(Number(level.toFixed(3)));
  mirrorButton.setAttribute('aria-pressed', String(mirrored));
  const aiming = Boolean(brush && armed);
  if (placeButton) placeButton.disabled = !aiming;
  for (const button of Object.values(moveButtons)) button.disabled = !aiming;
  if (host) host.dataset.aim = aiming ? `${armed.cx},${armed.cz}` : '';

  viewport?.setLevel(level);
  if (aiming) showGhost(armed.cx, armed.cz);
  else viewport?.ghost(null);
  markBrush();
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

  inspector = role('panel-seams');
  familySelect = role('family');
  paletteList = role('list');
  brushLabel = role('brush');
  levelLabel = role('level');
  mirrorButton = role('mirror');

  familySelect.append(new Option('Everything', ''));
  for (const id of [...new Set(Object.values(sockets.pieces)
    .filter((piece) => piece.dir === 'atoms').map((piece) => piece.family))].filter(Boolean).sort()) {
    familySelect.append(new Option(families.get(id) ?? id, `atoms:${id}`));
  }
  familySelect.append(new Option('Assemblies', 'assemblies:'));
  familySelect.append(new Option('Scenes', 'scenes:'));

  role('rotate').addEventListener('click', () => { rotation = (rotation + 1) % 4; syncToolbar(); });
  mirrorButton.addEventListener('click', () => { mirrored = !mirrored; syncToolbar(); });
  role('up').addEventListener('click', () => { level += 1; syncToolbar(); });
  role('down').addEventListener('click', () => { level -= 1; syncToolbar(); });

  undoButton = role('undo');
  redoButton = role('redo');
  undoButton.addEventListener('click', () => step(at - 1));
  redoButton.addEventListener('click', () => step(at + 1));
  role('clear').addEventListener('click', () => {
    if (!placements.length) return;
    placements.length = 0;
    selected = null;
    commit();
    render();
    showInspector();
    showPick();
  });

  for (const name of ['top', 'iso', 'front']) {
    role(`view-${name}`).addEventListener('click', () => viewport.setView(name));
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  role('save-json').addEventListener('click', () =>
    download(`build-${stamp()}.json`, new Blob([toJson()], { type: 'application/json' })));
  role('save-glb').addEventListener('click', async () =>
    download(`build-${stamp()}.glb`, await viewport.exportGlb()));

  const opener = role('open');
  opener.addEventListener('change', async () => {
    const file = opener.files?.[0];
    opener.value = '';
    if (!file) return;
    try { load(await file.text()); } catch (error) { alert(`Could not open that build: ${error.message}`); }
  });

  const socketsButton = role('sockets');
  socketsButton.addEventListener('click', () => {
    const show = socketsButton.getAttribute('aria-pressed') !== 'true';
    socketsButton.setAttribute('aria-pressed', String(show));
    viewport.setSockets(show);
  });

  role('orbit-left').addEventListener('click', () => viewport.orbit(-Math.PI / 8));
  role('orbit-right').addEventListener('click', () => viewport.orbit(Math.PI / 8));
  const stepZoom = (direction) => {
    const distance = viewport.zoom(direction);
    if (host) host.dataset.zoom = distance.toFixed(2);
  };
  role('zoom-in').addEventListener('click', () => stepZoom(-1));
  role('zoom-out').addEventListener('click', () => stepZoom(1));

  removeButton = role('remove');
  removeButton.addEventListener('click', () => remove(selected));

  placeButton = role('place');
  placeButton.addEventListener('click', commitArmed);

  moveButtons = {
    left: role('move-left'), right: role('move-right'), away: role('move-away'), near: role('move-near'),
  };
  moveButtons.left.addEventListener('click', () => nudge(-1, 0));
  moveButtons.right.addEventListener('click', () => nudge(1, 0));
  moveButtons.away.addEventListener('click', () => nudge(0, 1));
  moveButtons.near.addEventListener('click', () => nudge(0, -1));

  drawer = { root: role('drawer') };
  drawer.root.addEventListener('transitionend', measureDrawer);
  new ResizeObserver(measureDrawer).observe(drawer.root);

  role('drawer-size').addEventListener('click', () => {
    const at = HEIGHTS.indexOf(drawer.root.dataset.height);
    setDrawer(HEIGHTS[at >= HEIGHTS.length - 1 ? 0 : at + 1]);
  });

  const save = role('save');
  role('save-toggle').addEventListener('click', () => {
    const open = save.dataset.open !== 'true';
    save.dataset.open = String(open);
    role('save-toggle').setAttribute('aria-expanded', String(open));
  });

  sheet = {
    pieces: { tab: role('tab-pieces'), panel: role('panel-pieces') },
    seams: { tab: role('tab-seams'), panel: role('panel-seams') },
  };

  /* Swiping across the drawer moves between its tabs, since reaching for a
   * tab is the one thing a thumb on a phone cannot do comfortably. */
  const order = Object.keys(sheet);
  const body = container.querySelector('.drawer-body');
  let swipe = null;
  body.addEventListener('pointerdown', (event) => { swipe = { x: event.clientX, y: event.clientY }; });
  body.addEventListener('pointerup', (event) => {
    if (!swipe) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const current = order.findIndex((name) => sheet[name].tab.getAttribute('aria-selected') === 'true');
    showSheet(order[Math.min(order.length - 1, Math.max(0, current + (dx < 0 ? 1 : -1)))]);
  });
  for (const name of Object.keys(sheet)) {
    sheet[name].tab.addEventListener('click', () => {
      const shut = drawer.root.dataset.height === 'shut';
      const already = sheet[name].tab.getAttribute('aria-selected') === 'true';
      showSheet(name);
      openDrawer(shut || !already);
    });
  }

  familySelect.addEventListener('change', renderPalette);
  renderPalette();

  // Shortcuts belong to this tab, not the whole catalog.
  document.addEventListener('keydown', (event) => {
    if (host.hidden || event.target.matches('input, select, textarea')) return;
    const undoKey = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z';
    if (undoKey) { event.preventDefault(); step(event.shiftKey ? at + 1 : at - 1); return; }
    if (event.key === 'Escape') { armed = null; brush = null; syncToolbar(); }
    if (event.key === 'Enter' && armed) { event.preventDefault(); commitArmed(); }
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
    if (step && brush) { event.preventDefault(); nudge(...step); }
    if (event.key === 'r' || event.key === 'R') { rotation = (rotation + 1) % 4; syncToolbar(); }
    if (event.key === 'm' || event.key === 'M') { mirrored = !mirrored; syncToolbar(); }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected) { event.preventDefault(); remove(selected); }
  });

  // Versioned like the rest of the catalog's assets, or a browser that has
  // been here before keeps yesterday's camera.
  const { createViewport } = await import(version ? `./viewport.js?v=${version}` : './viewport.js');
  viewport = createViewport(role('view'), {
    colorOf: (name) => swatches.get(name),
    onTap: ({ id, x, z }) => {
      if (brush && x !== null) return arm(x, z);
      select(id ?? (x === null ? null : topmostAt(x, z)));
    },
  });

  // The tab is as tall as what is left of the window, so it has to know how
  // much of it the catalog's own header takes.
  const chrome = () => container.style.setProperty(
    '--chrome', `${Math.round(document.querySelector('.head')?.getBoundingClientRect().height ?? 64)}px`,
  );
  chrome();
  addEventListener('resize', chrome);

  measureDrawer();

  const saved = (() => { try { return localStorage.getItem(STORAGE); } catch { return null; } })();
  if (saved) { try { load(saved); } catch { /* a stale or hand-edited save */ } }
  if (!past.length) commit();

  syncToolbar();
  render();
  showInspector();
  showPick();
}
