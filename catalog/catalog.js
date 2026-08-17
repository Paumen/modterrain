/**
 * Modular Terrain — 3D catalog.
 *
 * The pack ships with no metadata at all, so the entire classification comes
 * from filenames (tools/taxonomy.mjs → catalog/catalog.json).
 *
 * One model appears in multiple tabs — the same piece is an inner curve, a
 * mid layer, AND a 3 × 3 — so one model produces multiple cards. Anything
 * that hangs off the model rather than the card (selection) is therefore
 * keyed by file path.
 */

/**
 * Triangles above which a model is heavy in absolute terms, regardless of
 * size. This pack's largest sand slopes cover 12 × 12 grid cells; they're
 * allowed more triangles than a 1 × 1 post, and the per-unit budget below
 * handles that. This limit catches the other case: a piece that in absolute
 * terms no longer fits a scene with a hundred of them.
 */
const HEAVY_FROM = 500;

/**
 * Triangles per 1×1×1 grid cell above which a model is out of step with the
 * rest of the pack. The limit itself lives in tools/glb.mjs and travels here
 * via catalog.json; the number here is only the fallback for a catalog built
 * before that field existed.
 */
let budgetPerUnit = 250;

const number = new Intl.NumberFormat('en-US');
const unit = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

const panel = document.querySelector('#panel');
const tabBar = document.querySelector('#tab-bar');
const jumpList = document.querySelector('#jump-list');
const emptyMessage = document.querySelector('#empty');
const summary = document.querySelector('#summary');
const detail = document.querySelector('#detail');

const cards = [];
const sections = [];
const views = new Map();

let currentView = null;

/**
 * Selection is keyed by file path, not by card. One model has multiple
 * cards — the same inner curve appears in Parts, Shapes, Layers, AND Sizes —
 * and they all need to show the same checkbox state. This also dedupes:
 * checking the same model in two tabs still yields the path once on the
 * clipboard.
 */
const selectedPaths = new Set();
const cardsByPath = new Map();

let lastPicked = null;

const selectedMaterials = new Set();
const swatches = [];

const readableBytes = (bytes) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} kB`;

const readableDimensions = (dwh) =>
  Array.isArray(dwh) ? `${dwh.map((v) => unit.format(v)).join(' × ')} cells` : '—';

function span(className, text = '') {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

/**
 * Restores this pack's material colors to what the author set.
 *
 * The FBX export wrote sRGB colors from the source straight into
 * `baseColorFactor`, and the glTF spec calls that field linear. A viewer
 * that follows the spec — this one does — applies gamma correction on top of
 * that, so the beige cliff color #bfb9ae shows up as #e0ddd7 and the grass
 * green #63ba2e as a pastel #a7de76. With two-thirds of the pack's pieces
 * made of that one beige material, that turns the catalog into a grid of
 * white blocks.
 *
 * This is the mirror of that mistake, applied only at display time: the
 * .glb files on disk and behind the download button stay untouched. Anyone
 * who wants to see the pack uncorrected can drop the calls in
 * `attachViewer` and `showDetail`.
 */
const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

function restoreColorSpace(viewer) {
  for (const material of viewer.model?.materials ?? []) {
    const factor = material.pbrMetallicRoughness?.baseColorFactor;
    if (!factor) continue;
    material.pbrMetallicRoughness.setBaseColorFactor([
      srgbToLinear(factor[0]),
      srgbToLinear(factor[1]),
      srgbToLinear(factor[2]),
      factor[3],
    ]);
  }
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const { target, isIntersecting } of entries) {
      if (isIntersecting) attachViewer(target);
      else detachViewer(target);
    }
  },
  { rootMargin: '800px 0px' },
);

function attachViewer(box) {
  if (box.querySelector('model-viewer')) return;

  const viewer = document.createElement('model-viewer');
  viewer.src = box.dataset.src;
  viewer.alt = box.dataset.alt;
  viewer.setAttribute('camera-orbit', '35deg 68deg auto');
  viewer.setAttribute('environment-image', 'neutral');
  viewer.setAttribute('shadow-intensity', '0.6');
  viewer.setAttribute('shadow-softness', '0.9');
  // The pack is flat-shaded with no textures; at the neutral environment's
  // default exposure the light cliffs blow out to white. Pulling it back
  // gives the beige its color back and the faces their contrast.
  viewer.setAttribute('exposure', '0.85');
  viewer.setAttribute('interaction-prompt', 'none');
  viewer.setAttribute('disable-zoom', '');
  viewer.setAttribute('loading', 'eager');
  viewer.addEventListener('load', () => restoreColorSpace(viewer), { once: true });
  box.replaceChildren(viewer);
}

/**
 * Once out of view, the render loop stops, but the picture stays: a single
 * snapshot as webp, taken the moment the card scrolls away. Without that the
 * grid would go blank on every scroll — with hundreds of tiles per tab,
 * that's the difference between browsing and waiting.
 */
function detachViewer(box) {
  const viewer = box.querySelector('model-viewer');
  if (!viewer) return;

  if (viewer.loaded && !box.dataset.snapshot) {
    try {
      box.dataset.snapshot = viewer.toDataURL('image/webp', 0.72);
    } catch {}
  }

  if (box.dataset.snapshot) {
    const image = document.createElement('img');
    image.src = box.dataset.snapshot;
    image.alt = box.dataset.alt;
    image.loading = 'lazy';
    box.replaceChildren(image);
  } else {
    box.replaceChildren();
  }
}

/* ---------- cards ---------- */

function makeCard(model, view, section) {
  const density = Number.isFinite(model.trianglesPerUnit) ? model.trianglesPerUnit : null;
  const overBudget = density !== null && density > budgetPerUnit;
  // One red label for two reasons: a lot of triangles, or a lot of triangles
  // packed into little space. What exactly is going on shows in the tooltip
  // and the detail panel; on the card it's enough that it stands out.
  const heavy = model.triangles >= HEAVY_FROM || overBudget;

  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card';
  card.style.setProperty('--brand-color', section.color ?? 'currentColor');

  const box = document.createElement('div');
  box.className = 'card-viewer';
  box.dataset.src = model.file;
  box.dataset.alt = `3D model ${model.name}`;

  const text = document.createElement('div');
  text.className = 'card-text';
  const meta = span('card-meta');
  const tri = span(`card-tri${heavy ? ' heavy' : ''}`, `${number.format(model.triangles)} tri`);
  if (density !== null) {
    tri.title = `${number.format(density)} triangles per unit${overBudget ? ` — above the budget of ${number.format(budgetPerUnit)}` : ''}`;
  }
  meta.append(
    span('card-brand', section.brand ?? ''),
    tri,
    span('card-bytes', readableBytes(model.bytes)),
  );
  text.append(span('card-name', model.name));
  // Its own row rather than an overlay on the thumbnail: a badge sitting on
  // top of the model made the corner of the preview harder to read and
  // competed with the selection checkbox for the same corner.
  if (model.size) text.append(span('card-size', model.size));
  text.append(meta);

  card.append(box, text);
  card.addEventListener('click', () => showDetail(model));

  // The checkbox is a sibling of the card, not a child: a button inside a
  // button isn't allowed, and this way the card itself stays fully clickable
  // toward the detail view.
  const pick = document.createElement('label');
  pick.className = 'card-pick';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selectedPaths.has(model.file);
  checkbox.setAttribute('aria-label', `Select ${model.name}`);
  pick.append(checkbox);

  const holder = document.createElement('div');
  holder.className = 'card-holder';
  holder.append(card, pick);

  const item = {
    element: holder,
    checkbox,
    path: model.file,
    view,
    materials: model.materials,
  };
  cards.push(item);

  const siblings = cardsByPath.get(model.file);
  if (siblings) siblings.push(item);
  else cardsByPath.set(model.file, [item]);

  checkbox.addEventListener('click', (e) => {
    if (e.shiftKey && lastPicked && lastPicked !== item) pickRange(item, checkbox.checked);
    else setSelection([model.file], checkbox.checked);
    lastPicked = item;
  });

  observer.observe(box);
  return item;
}

function makeSection(view, section, facet) {
  const element = document.createElement('section');
  element.className = 'section';
  element.id = section.id;
  element.dataset.view = view.id;
  element.dataset.facet = facet;
  if (section.color) element.style.setProperty('--section-color', section.color);

  const head = document.createElement('div');
  head.className = 'section-head';

  const title = document.createElement('h2');
  title.textContent = section.name;

  const countEl = span('count', `${section.models.length} models`);
  head.append(title, countEl);

  const grid = document.createElement('div');
  grid.className = 'grid';
  element.append(head, grid);
  return { element, grid, countEl };
}

function makeJumpItem(section, name, count, color) {
  const link = document.createElement('a');
  link.href = `#${section.id}`;
  link.dataset.view = section.dataset.view;
  const dot = span('dot');
  if (color) dot.style.background = color;
  link.append(dot, document.createTextNode(`${name} `), span('badge', String(count)));
  jumpList.append(link);
  return link;
}

/* ---------- detail view ---------- */

const detailViewer = document.querySelector('#detail-viewer');
const detailCopy = document.querySelector('#detail-copy');
let activePath = '';

/** material key → { name, hex }, filled in by buildFilterBar(). */
const materialInfo = new Map();

/**
 * A model's position relative to its grid cell. This pack is deliberately
 * not centered on the origin — a piece's origin IS its grid cell — so
 * "-0.5 to 0.5" means centered and "0 to 1" means the piece sits up and to
 * the right of its origin. Anyone placing the kit on a grid in an engine
 * needs exactly that.
 */
const placement = (min, max) =>
  [['width', 0], ['depth', 2], ['height', 1]]
    .map(([axis, index]) => `${axis} ${unit.format(min[index])} … ${unit.format(max[index])}`)
    .join(' · ');

function showDetail(model) {
  activePath = model.file;
  document.querySelector('#detail-name').textContent = model.name;
  document.querySelector('#detail-origin').textContent =
    [model.familyName, model.shapeName, model.layerName].filter(Boolean).join(' · ');

  const traits = document.querySelector('#detail-traits');
  traits.replaceChildren(...model.traits.map((t) => span('', t)));

  const materialList = document.createElement('span');
  for (const key of model.materials) {
    const info = materialInfo.get(key);
    const chip = span('detail-material', info?.name ?? key);
    if (info) chip.style.setProperty('--material-color', info.hex);
    if (materialList.childNodes.length) materialList.append(', ');
    materialList.append(chip);
  }

  const rows = [
    ['File', model.file],
    ['Grid footprint', model.size ? `${model.size} cells` : '—'],
    ['Dimensions (w × d × h)', readableDimensions(model.dwh)],
    ['Position relative to origin', placement(model.min, model.max)],
    ['Triangles', `${number.format(model.triangles)}${model.triangles >= HEAVY_FROM ? ' (heavy)' : ''}`],
    // The budget: every axis counts for at least one unit, so a model that
    // stays within one grid cell isn't penalized for being small
    // (tools/glb.mjs).
    [
      'Triangles per unit',
      !Number.isFinite(model.trianglesPerUnit)
        ? '—'
        : `${number.format(model.trianglesPerUnit)}${model.trianglesPerUnit > budgetPerUnit ? ` (above budget of ${number.format(budgetPerUnit)})` : ''}`,
    ],
    ['Draw calls', model.calls === undefined ? '—' : number.format(model.calls)],
    [`Materials (${model.materials.length})`, materialList],
    // Only for the models it applies to; the rest have nothing to say here.
    // The viewer still shows them, just in the flat material color.
    ...(model.missingTextures?.length
      ? [['Missing texture', `${model.missingTextures.join(', ')} — not in the pack`]]
      : []),
    ...(model.variant !== null ? [['Variant', `number ${model.variant}`]] : []),
    ['Size', readableBytes(model.bytes)],
  ];

  const data = document.querySelector('#detail-data');
  data.replaceChildren();
  for (const [key, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = key;
    const description = document.createElement('dd');
    if (value instanceof Node) description.append(value);
    else description.textContent = value;
    data.append(term, description);
  }

  const download = document.querySelector('#detail-download');
  download.href = model.file;
  download.setAttribute('download', `${model.id}.glb`);

  const viewer = document.createElement('model-viewer');
  viewer.src = model.file;
  viewer.alt = `3D model ${model.name}`;
  viewer.setAttribute('camera-controls', '');
  viewer.setAttribute('camera-orbit', '35deg 68deg auto');
  viewer.setAttribute('environment-image', 'neutral');
  viewer.setAttribute('shadow-intensity', '0.7');
  viewer.setAttribute('shadow-softness', '0.9');
  viewer.setAttribute('exposure', '0.85');
  // Nothing in this pack is animated, so the auto-rotate is the only way to
  // see the back without dragging — and on a modular piece the back is
  // exactly the side that meets the neighboring tile.
  viewer.setAttribute('auto-rotate', '');
  viewer.setAttribute('rotation-per-second', '18deg');
  viewer.addEventListener('load', () => restoreColorSpace(viewer), { once: true });

  detailViewer.replaceChildren(viewer);

  detail.showModal();
  updateSelectionBar();
}

detail.addEventListener('close', () => detailViewer.replaceChildren());
document.querySelector('#detail-close').addEventListener('click', () => detail.close());
detail.addEventListener('click', (e) => { if (e.target === detail) detail.close(); });

detailCopy.addEventListener('click', async () => {
  const ok = await toClipboard(activePath);
  detailCopy.textContent = ok ? 'Copied' : activePath;
  setTimeout(() => { detailCopy.textContent = 'Copy path'; }, 1600);
});

/* ---------- selection ---------- */

const selectionBar = document.querySelector('#selection-bar');
const selectionCount = document.querySelector('#selection-count');
const selectionCopy = document.querySelector('#selection-copy');
const detailSelect = document.querySelector('#detail-select');

const visibleCards = () =>
  cards.filter((c) => c.view === currentView && !c.element.hidden);

function setSelection(paths, on) {
  for (const path of paths) {
    if (on) selectedPaths.add(path);
    else selectedPaths.delete(path);
    for (const sibling of cardsByPath.get(path) ?? []) sibling.checkbox.checked = on;
  }
  updateSelectionBar();
}

/**
 * Shift-click extends the selection from the previous click to this one,
 * across whatever cards are currently visible. So after filtering to "curve"
 * shift picks exactly the curves, not everything that sat between them in
 * the unfiltered catalog.
 */
function pickRange(to, on) {
  const list = visibleCards();
  const from = list.indexOf(lastPicked);
  const target = list.indexOf(to);
  if (from === -1 || target === -1) return setSelection([to.path], on);
  const range = list.slice(Math.min(from, target), Math.max(from, target) + 1);
  setSelection(range.map((c) => c.path), on);
}

function updateSelectionBar() {
  const count = selectedPaths.size;
  selectionBar.hidden = count === 0;
  selectionCount.textContent = `${count} selected`;
  if (detail.open) {
    const on = selectedPaths.has(activePath);
    detailSelect.textContent = on ? 'Remove from selection' : 'Add to selection';
    detailSelect.setAttribute('aria-pressed', String(on));
  }
}

/**
 * Without clipboard permission — a page not served over https, for
 * instance, straight from the filesystem — the browser falls back to a
 * field you clear with ctrl-C. That still fits in the button label for one
 * path, not for seventy.
 */
async function toClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}

  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;top:0;left:-9999px';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

selectionCopy.addEventListener('click', async () => {
  const count = selectedPaths.size;
  // A Set preserves insertion order: paths come out in the order they were
  // checked, and with "Select all visible" that's the order on screen.
  const ok = await toClipboard([...selectedPaths].join('\n'));
  selectionCopy.textContent = ok
    ? `${count} path${count === 1 ? '' : 's'} copied`
    : 'Copy failed';
  setTimeout(() => { selectionCopy.textContent = 'Copy paths'; }, 1600);
});

document.querySelector('#select-visible').addEventListener('click', () => {
  setSelection(visibleCards().map((c) => c.path), true);
});

document.querySelector('#select-clear').addEventListener('click', () => {
  setSelection([...selectedPaths], false);
  lastPicked = null;
});

detailSelect.addEventListener('click', () => {
  setSelection([activePath], !selectedPaths.has(activePath));
});

/* ---------- material filter ---------- */

function checkColor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? '#2b2a26' : '#ffffff';
}

function buildFilterBar(palettes) {
  const holder = document.querySelector('#filter-swatches');
  const clearButton = document.querySelector('#filter-clear');

  for (const palette of palettes) {
    if (palette.colors.length === 0) continue;

    const group = document.createElement('div');
    group.className = 'filter-group';

    const label = span('filter-group-label', palette.name);

    const buttons = document.createElement('div');
    buttons.className = 'filter-group-swatches';
    buttons.setAttribute('role', 'group');
    buttons.setAttribute('aria-label', `Filter by material — ${palette.name}`);

    for (const color of palette.colors) {
      materialInfo.set(color.key, color);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = palette.style === 'chip' ? 'swatch chip' : 'swatch';
      button.dataset.key = color.key;
      button.style.setProperty('--swatch-color', color.hex);
      button.style.setProperty('--check', checkColor(color.hex));
      button.setAttribute('aria-pressed', 'false');
      button.title = `${color.name} ${color.hex} — ${color.count} models · material "${color.source}"`;
      button.setAttribute('aria-label', `${color.name}, ${color.count} models`);
      if (palette.style === 'chip') button.append(color.name);

      button.addEventListener('click', () => {
        const on = !selectedMaterials.has(color.key);
        if (on) selectedMaterials.add(color.key);
        else selectedMaterials.delete(color.key);
        button.setAttribute('aria-pressed', String(on));
        clearButton.hidden = selectedMaterials.size === 0;
        filter();
      });

      buttons.append(button);
      swatches.push({ key: color.key, element: button });
    }

    group.append(label, buttons);
    holder.append(group);
  }

  clearButton.addEventListener('click', () => {
    selectedMaterials.clear();
    for (const swatch of swatches) swatch.element.setAttribute('aria-pressed', 'false');
    clearButton.hidden = true;
    filter();
  });
}

/* ---------- view & filter ---------- */

function switchView(id) {
  currentView = id;
  for (const button of tabBar.children) {
    button.setAttribute('aria-selected', String(button.dataset.view === id));
  }
  panel.setAttribute('aria-labelledby', `tab-${id}`);

  // A swatch that touches no model in this tab is a button that filters
  // everything away. Hide it, and clear its selection — otherwise a hidden
  // button would empty the whole page.
  const present = new Set(
    cards.filter((c) => c.view === id).flatMap((c) => c.materials),
  );
  for (const swatch of swatches) {
    swatch.element.hidden = !present.has(swatch.key);
    if (!swatch.element.hidden) continue;
    selectedMaterials.delete(swatch.key);
    swatch.element.setAttribute('aria-pressed', 'false');
  }
  document.querySelector('#filter-clear').hidden = selectedMaterials.size === 0;

  filter();
}

function filter() {
  let visible = 0;

  for (const card of cards) {
    const match =
      selectedMaterials.size === 0 || card.materials.some((m) => selectedMaterials.has(m));
    card.element.hidden = !match;
    if (match && card.view === currentView) visible++;
  }

  for (const section of sections) {
    const inView = section.element.dataset.view === currentView;
    const count = section.cards.filter((c) => !c.element.hidden).length;

    section.element.hidden = !inView || count === 0;
    section.jumpItem.hidden = section.element.hidden;
    section.countEl.textContent = `${count} model${count === 1 ? '' : 's'}`;
    section.jumpItem.querySelector('.badge').textContent = count;
  }

  emptyMessage.hidden = visible > 0;
}

/* ---------- startup ---------- */

async function start() {
  const version = document.querySelector('meta[name="catalog-version"]')?.content;
  const response = await fetch(version ? `catalog/catalog.json?v=${version}` : 'catalog/catalog.json');
  if (!response.ok) throw new Error(`catalog/catalog.json not found (${response.status})`);
  const data = await response.json();

  if (Number.isFinite(data.budgetPerUnit)) budgetPerUnit = data.budgetPerUnit;

  /* A model carries its family, shape, and layer only as an id; `facets`
   * says what those ids mean. Resolved here once so the detail view and
   * cards can show them. */
  const names = new Map(Object.entries(data.facets ?? {}));
  const nameOf = (id) => names.get(id) ?? id;

  for (const model of data.models) {
    model.familyName = nameOf(model.family);
    model.shapeName = nameOf(model.shape);
    model.layerName = model.layer === 'layer-none' ? null : nameOf(model.layer);
  }

  buildFilterBar(data.palettes ?? []);

  for (const view of data.views) {
    views.set(view.id, view);

    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'tab';
    button.id = `tab-${view.id}`;
    button.dataset.view = view.id;
    button.setAttribute('aria-controls', 'panel');
    button.setAttribute('aria-selected', 'false');
    button.textContent = view.label;
    button.addEventListener('click', () => {
      switchView(view.id);
      history.replaceState(null, '', `#${view.id}`);
      window.scrollTo({ top: 0 });
    });
    tabBar.append(button);

    for (const section of view.sections) {
      const parts = makeSection(view, section, view.facet);
      const own = [];

      for (const index of section.models) {
        const model = data.models[index];
        const item = makeCard(model, view.id, {
          color: section.color,
          brand: model.familyName,
        });
        parts.grid.append(item.element);
        own.push(item);
      }

      panel.append(parts.element);
      sections.push({
        element: parts.element,
        cards: own,
        countEl: parts.countEl,
        jumpItem: makeJumpItem(parts.element, section.name, section.models.length, section.color),
      });
    }
  }

  const anchor = location.hash.slice(1);
  const targetSection = anchor ? document.getElementById(anchor) : null;
  switchView(targetSection?.dataset.view ?? (views.has(anchor) ? anchor : data.views[0].id));
  targetSection?.scrollIntoView();
}

start().catch((error) => {
  summary.hidden = false;
  summary.textContent = `Failed to load catalog: ${error.message}`;
  console.error(error);
});
