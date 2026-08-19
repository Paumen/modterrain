import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNITS_PER_CELL } from './glb.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'catalog', 'pieces.json');

/* A piece's origin is the centre of its anchor cell, so cell i covers
 * [i - 0.5, i + 0.5]. Shells that overhang their cell (most cliff faces do)
 * must not claim the neighbouring one, hence rounding inwards.
 *
 * This rounds the wrong way where a bound lands on a cell centre rather than a
 * cell boundary, and for sub-cell props and flat sheets: 16 pieces name a cell
 * their mesh never reaches, and 52 leave out a cell they more than half fill.
 * Carried over unchanged so this is a removal and nothing else.
 */
function cells(min, max) {
  if (!min || !max) return [[0, 0]];
  const range = (lo, hi) => {
    const first = Math.round(lo + 0.5);
    const last = Math.max(first, Math.round(hi - 0.5));
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  };
  return range(min[0], max[0]).flatMap((x) => range(min[2], max[2]).map((z) => [x, z]));
}

const catalog = JSON.parse(readFileSync(join(ROOT, 'catalog', 'catalog.json'), 'utf8'));
const meta = new Map(catalog.models.map((entry) => [entry.id, entry]));

/* Assemblies are placeable too, and so are whole scenes. Scenes are authored
 * at one unit per cell where everything else uses a hundred, so they carry the
 * factor for the viewport to apply — and catalog.json measures them in their
 * own units, so its bounds for them need the same factor.
 */
const SOURCES = [
  { dir: 'atoms', scale: 1 },
  { dir: 'assemblies', scale: 1 },
  { dir: 'scenes', scale: UNITS_PER_CELL },
];

const pieces = {};
for (const { dir, scale } of SOURCES) {
  for (const file of readdirSync(join(ROOT, dir)).filter((name) => name.endsWith('.glb')).sort()) {
    const id = file.replace(/\.glb$/, '');
    const entry = meta.get(id);

    const grow = (v) => (Array.isArray(v) ? v.map((n) => Math.round(n * scale * 512) / 512) : v);
    const min = grow(entry?.min);
    const max = grow(entry?.max);

    pieces[id] = {
      dir,
      scale,
      family: entry?.family ?? null,
      layer: entry?.layer ?? null,
      size: entry?.size ?? null,
      dwh: grow(entry?.dwh),
      min,
      max,
      cells: cells(min, max),
    };
  }
}

writeFileSync(OUT, JSON.stringify({ generated: 'node tools/build-pieces.mjs', pieces }));
const perDir = SOURCES.map(({ dir }) =>
  `${Object.values(pieces).filter((piece) => piece.dir === dir).length} ${dir}`).join(', ');
console.log(`${perDir} → catalog/pieces.json`);
