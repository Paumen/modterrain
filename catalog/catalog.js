const number = new Intl.NumberFormat('en-US');
const unit = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

const panel = document.querySelector('#panel');
const tabBar = document.querySelector('#tab-bar');
const emptyMessage = document.querySelector('#empty');
const summary = document.querySelector('#summary');
const detail = document.querySelector('#detail');

const cards = [];
const sections = [];
const views = new Map();

let currentView = null;
let catalogData = null;

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
  viewer.setAttribute('interaction-prompt', 'none');
  viewer.setAttribute('disable-zoom', '');
  viewer.setAttribute('loading', 'eager');
  if (box.dataset.floorSrc) {
    viewer.addEventListener('load', () => swapToFloor(viewer, box.dataset.floorSrc), { once: true });
  }
  box.replaceChildren(viewer);
}

// The floored file's own "auto" camera-orbit fits the whole scene, floor
// included, which zooms out and shrinks the model — the floor is padded
// past the model's footprint and sits off-center (at its base), so even
// tight padding inflates the bounding sphere. Loading the plain model first
// and locking its real auto-resolved framing (camera-orbit's radius is in
// the same units either way) onto the floored swap keeps the model exactly
// as prominent as everywhere else, with the floor just extending into frame.
function swapToFloor(viewer, floorSrc) {
  const { theta, phi, radius } = viewer.getCameraOrbit();
  viewer.setAttribute('field-of-view', `${viewer.getFieldOfView()}deg`);
  viewer.setAttribute('camera-orbit', `${theta}rad ${phi}rad ${radius}m`);
  viewer.src = floorSrc;
}

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

function makeCard(model, view, section) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card';
  card.style.setProperty('--brand-color', section.color ?? 'currentColor');

  const box = document.createElement('div');
  box.className = 'card-viewer';
  box.dataset.src = model.file;
  // The Parts tab shows the floored variant (a real grid-plane mesh baked
  // under the piece, see tools/add-floor.mjs) when one exists; every other
  // view, and the handful of flat pieces with no footprint to floor, use
  // just the plain model. attachViewer loads dataset.src first regardless,
  // so the model's own true auto-framing can be captured and locked before
  // swapping to the floored file — see swapToFloor.
  if (view === 'parts' && model.floorFile) box.dataset.floorSrc = model.floorFile;
  box.dataset.alt = `3D model ${model.name}`;

  const text = document.createElement('div');
  text.className = 'card-text';
  const meta = span('card-meta');
  meta.append(
    span('card-brand', section.brand ?? ''),
    span('card-bytes', readableBytes(model.bytes)),
  );
  const name = span('card-name', model.name);
  if (model.incomplete) name.classList.add('is-incomplete');
  text.append(name);
  text.append(meta);

  card.append(box, text);
  card.addEventListener('click', () => showDetail(model));

  // Sibling of the card, not a child: a button can't nest in a button.
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

const counted = (facet) => (n) => {
  if (facet === 'assembly') return `${n} ${n === 1 ? 'assembly' : 'assemblies'}`;
  if (facet === 'scene') return `${n} scene${n === 1 ? '' : 's'}`;
  return `${n} model${n === 1 ? '' : 's'}`;
};

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

  const label = counted(facet);
  const countEl = span('count', label(section.models.length));
  head.append(title, countEl);

  const grid = document.createElement('div');
  grid.className = 'grid';
  element.append(head, grid);
  return { element, grid, countEl, label };
}

const detailViewer = document.querySelector('#detail-viewer');
const detailCopy = document.querySelector('#detail-copy');
let activePath = '';

const materialInfo = new Map();

const placement = (min, max) =>
  [['width', 0], ['depth', 2], ['height', 1]]
    .map(([axis, index]) => `${axis} ${unit.format(min[index])} … ${unit.format(max[index])}`)
    .join(' · ');

function pieceList(pieces) {
  const holder = document.createElement('span');
  for (const piece of pieces) {
    if (holder.childNodes.length) holder.append(', ');
    holder.append(piece.count > 1 ? `${piece.id.replace(/_/g, ' ')} × ${piece.count}` : piece.id.replace(/_/g, ' '));
  }
  return holder;
}

function showDetail(model) {
  activePath = model.file;
  const heading = document.querySelector('#detail-name');
  heading.textContent = model.name;
  heading.classList.toggle('is-incomplete', Boolean(model.incomplete));
  document.querySelector('#detail-origin').textContent =
    [model.familyName, model.groupName, model.shapeName, model.layerName].filter(Boolean).join(' · ');

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
    ...(model.pieces
      ? [
        ['Built from', `${model.placed} pieces, ${model.pieces.length} distinct`],
        [`Pieces (${model.pieces.length})`, pieceList(model.pieces)],
        ...(model.missingPieces?.length
          ? [[
            'Not in this repo',
            `${model.missingPieces.join(', ')} — built without ${model.missingPieces.length === 1 ? 'it' : 'them'}`,
          ]]
          : []),
      ]
      : [['Grid footprint', model.size ? `${model.size} cells` : '—']]),
    ['Dimensions (w × d × h)', readableDimensions(model.dwh)],
    ['Position relative to origin', placement(model.min, model.max)],
    ['Triangles', number.format(model.triangles)],
    [
      'Triangles per unit',
      Number.isFinite(model.trianglesPerUnit) ? number.format(model.trianglesPerUnit) : '—',
    ],
    ['Draw calls', model.calls === undefined ? '—' : number.format(model.calls)],
    [`Materials (${model.materials.length})`, materialList],
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
  const floorSrc = currentView === 'parts' && model.floorFile;
  if (floorSrc) viewer.addEventListener('load', () => swapToFloor(viewer, floorSrc), { once: true });
  viewer.setAttribute('environment-image', 'neutral');
  viewer.setAttribute('shadow-intensity', '0.7');
  viewer.setAttribute('shadow-softness', '0.9');
  viewer.setAttribute('auto-rotate', '');
  viewer.setAttribute('rotation-per-second', '18deg');

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

/* The builder is a tool rather than a facet of the models, so it has no
 * sections to filter and takes over the panel wholesale. Its module is pulled
 * in the first time the tab is opened, keeping it off the catalog's own load. */
const builderHost = document.querySelector('#builder');
const assetVersion = document.querySelector('meta[name="catalog-version"]')?.content;
let builderLoaded = null;

function showBuilder(data) {
  builderHost.hidden = false;
  panel.hidden = true;
  document.querySelector('#filter-bar').hidden = true;
  emptyMessage.hidden = true;

  builderLoaded ??= import(assetVersion ? `./builder.js?v=${assetVersion}` : './builder.js')
    .then((module) => module.mount(builderHost, data))
    .catch((error) => {
      builderHost.textContent = `Failed to load the builder: ${error.message}`;
      console.error(error);
    });
}

function switchView(id) {
  currentView = id;
  for (const button of tabBar.children) {
    button.setAttribute('aria-selected', String(button.dataset.view === id));
  }
  panel.setAttribute('aria-labelledby', `tab-${id}`);

  if (id === 'builder') return showBuilder(catalogData);
  builderHost.hidden = true;
  panel.hidden = false;
  document.querySelector('#filter-bar').hidden = false;

  // A hidden swatch must also lose its selection, or it filters everything away.
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
    section.countEl.textContent = section.label(count);
  }

  emptyMessage.hidden = visible > 0;
}

async function start() {
  const response = await fetch(assetVersion ? `catalog/catalog.json?v=${assetVersion}` : 'catalog/catalog.json');
  if (!response.ok) throw new Error(`catalog/catalog.json not found (${response.status})`);
  const data = await response.json();
  catalogData = data;

  const names = new Map(Object.entries(data.facets ?? {}));
  const nameOf = (id) => names.get(id) ?? id;

  for (const model of data.models) {
    model.familyName = nameOf(model.family);
    model.groupName = model.group ? nameOf(model.group) : null;
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
          brand: model.pieces ? `${model.placed} pieces` : model.familyName,
        });
        parts.grid.append(item.element);
        own.push(item);
      }

      panel.append(parts.element);
      sections.push({
        element: parts.element,
        cards: own,
        countEl: parts.countEl,
        label: parts.label,
      });
    }
  }

  const builderTab = document.createElement('button');
  builderTab.type = 'button';
  builderTab.role = 'tab';
  builderTab.id = 'tab-builder';
  builderTab.dataset.view = 'builder';
  builderTab.setAttribute('aria-controls', 'panel');
  builderTab.setAttribute('aria-selected', 'false');
  builderTab.textContent = 'Builder';
  builderTab.addEventListener('click', () => {
    switchView('builder');
    history.replaceState(null, '', '#builder');
    window.scrollTo({ top: 0 });
  });
  tabBar.append(builderTab);
  views.set('builder', { id: 'builder', label: 'Builder' });

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
