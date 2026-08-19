/* The shared colormap: what a colour means and where to find it.
 *
 * The image is the one the Taalei kits use (github.com/Paumen/Taalei,
 * `kits/colormap.png`), copied here as `textures/colormap.png`. It is a raster
 * of 16 × 4 cells. Each cell is one vertical colour band: horizontally it is a
 * single colour, vertically it runs from light at the top to dark at the
 * bottom. A model points a UV at a spot on a band and takes that colour; two
 * models on the same spot are the same colour by construction, which is the
 * whole point of a shared map.
 *
 * Cells that are pure black are empty, not black — nothing may land there.
 */

import { readPng, writePng } from './png.mjs';

export const COLUMNS = 16;
export const ROWS = 4;

const isEmpty = (r, g, b) => r === 0 && g === 0 && b === 0;

export const toHex = (rgb) =>
  `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

export const parseHex = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/* Redmean, the same approximation `build-catalog.mjs` uses to decide two
 * swatches are one colour. Keeping one formula keeps "close" meaning one
 * thing across the repo. */
export function colorDistance(a, b) {
  const meanRed = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(
    (2 + meanRed / 256) * dr * dr + 4 * dg * dg + (2 + (255 - meanRed) / 256) * db * db,
  );
}

export const readAtlas = (path) => readPng(path);
export const writeAtlas = (path, atlas) => writePng(path, atlas);

const pixel = (atlas, x, y) => {
  const i = (y * atlas.width + x) * 4;
  return [atlas.pixels[i], atlas.pixels[i + 1], atlas.pixels[i + 2]];
};

/* Every spot a model may land on: one per pixel row of every filled cell, with
 * the UV that points at it. Horizontally the UV sits in the middle of the cell
 * — the band is one colour across, and the middle is as far as it gets from
 * the edges where filtering would blend two cells together. */
export function atlasPoints(atlas) {
  const cellWidth = atlas.width / COLUMNS;
  const cellHeight = atlas.height / ROWS;
  const points = [];

  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      const x = Math.floor(column * cellWidth + cellWidth / 2);
      for (let i = 0; i < cellHeight; i++) {
        const y = Math.floor(row * cellHeight) + i;
        const rgb = pixel(atlas, x, y);
        if (isEmpty(...rgb)) continue;
        points.push({
          rgb,
          cell: [column, row],
          step: i,
          uv: [(x + 0.5) / atlas.width, (y + 0.5) / atlas.height],
        });
      }
    }
  }

  if (points.length === 0) throw new Error('the colormap is empty');
  return points;
}

export function filledCells(atlas) {
  return [...new Set(atlasPoints(atlas).map((point) => point.cell.join(',')))]
    .map((key) => key.split(',').map(Number));
}

/* Paints a band into a cell, light `top` to dark `bottom`, in place. Passing
 * the same colour twice gives the flat cell a pack with one flat colour wants. */
export function fillCell(atlas, [column, row], top, bottom) {
  const cellWidth = atlas.width / COLUMNS;
  const cellHeight = atlas.height / ROWS;
  const x0 = Math.round(column * cellWidth);
  const y0 = Math.round(row * cellHeight);

  for (let i = 0; i < cellHeight; i++) {
    // Centre to centre, so the top and bottom colours land exactly on the
    // first and last row of pixels instead of half outside the cell.
    const t = cellHeight === 1 ? 0 : i / (cellHeight - 1);
    const rgb = [0, 1, 2].map((k) => Math.round(top[k] + (bottom[k] - top[k]) * t));
    for (let j = 0; j < cellWidth; j++) {
      const p = ((y0 + i) * atlas.width + x0 + j) * 4;
      atlas.pixels[p] = rgb[0];
      atlas.pixels[p + 1] = rgb[1];
      atlas.pixels[p + 2] = rgb[2];
      atlas.pixels[p + 3] = 255;
    }
  }
}

export function nearestPoint(points, rgb) {
  let best = points[0];
  let distance = Infinity;
  for (const point of points) {
    const d = colorDistance(rgb, point.rgb);
    if (d < distance) {
      distance = d;
      best = point;
    }
  }
  return { ...best, distance };
}
