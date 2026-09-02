import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const reviewPath = args.find((a) => !a.startsWith('--'));
if (!reviewPath) {
  console.error('usage: node tools/check-grid.mjs <scene_grid.review.json> [grid.json] [--tolerance 0.1]');
  process.exit(1);
}
const gridArg = args.filter((a) => !a.startsWith('--'))[1];
const tolFlag = args.indexOf('--tolerance');
const TOL = tolFlag >= 0 ? Number(args[tolFlag + 1]) : 0.1;

const review = JSON.parse(readFileSync(reviewPath, 'utf8'));
const gridPath = gridArg ?? resolve(dirname(reviewPath), review.grid);
const grid = JSON.parse(readFileSync(gridPath, 'utf8'));

const { origin, step, path: pathy } = grid.meta;
const nodes = grid.nodes.map(([c, r, y, m, dx = 0, dz = 0]) => ({
  c, r,
  p: [origin.c + c + 0.5 + dx, y, origin.r + r + 0.5 + dz],
  walk: !!pathy[m],
  n: [],
}));
for (let i = 0; i < grid.edges.length; i += 2) {
  nodes[grid.edges[i]].n.push(grid.edges[i + 1]);
  nodes[grid.edges[i + 1]].n.push(grid.edges[i]);
}

const byCell = new Map();
nodes.forEach((n, i) => {
  const k = n.c * 100000 + n.r;
  if (!byCell.has(k)) byCell.set(k, []);
  byCell.get(k).push(i);
});

function find(ref) {
  let best = -1, bestD = step;
  for (const i of byCell.get(ref.c * 100000 + ref.r) ?? []) {
    const d = Math.abs(nodes[i].p[1] - ref.y);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

const SURF = (n) => (n.walk ? 1 : 3.5);
const dist3 = (a, b) => Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]);
const cost = (a, b) => dist3(nodes[a], nodes[b]) * ((SURF(nodes[a]) + SURF(nodes[b])) / 2);

function steps(from, dest) {
  if (from === dest) return 0;
  const dist = new Float64Array(nodes.length).fill(Infinity);
  const prev = new Int32Array(nodes.length).fill(-1);
  const done = new Uint8Array(nodes.length);
  const heap = [];
  const push = (c, n) => {
    heap.push([c, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  dist[from] = 0;
  push(0, from);
  while (heap.length) {
    const [, n] = pop();
    if (done[n]) continue;
    done[n] = 1;
    if (n === dest) break;
    for (const nb of nodes[n].n) {
      const d = dist[n] + cost(n, nb);
      if (d < dist[nb]) { dist[nb] = d; prev[nb] = n; push(d, nb); }
    }
  }
  if (dist[dest] === Infinity) return null;
  let k = 0;
  for (let n = dest; n !== from && n !== -1; n = prev[n]) k++;
  return k;
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });
const at = (ref) => `${ref.c},${ref.r} @ ${ref.y}`;
const linked = (a, b) => nodes[a].n.includes(b);

const add = review.add ?? review.missing ?? { cells: [], links: [] };
const marked = review.mark ?? { cells: [], links: [] };

for (const ref of add.cells) {
  const i = find(ref);
  check(`add cell ${at(ref)}`, i >= 0, i >= 0 ? 'now walkable' : 'still not in the grid');
}
for (const ref of review.wrong.cells) {
  const i = find(ref);
  check(`wrong cell ${at(ref)}`, i < 0, i < 0 ? 'gone' : 'still walkable');
}
for (const [a, b] of add.links) {
  const i = find(a), j = find(b);
  const ok = i >= 0 && j >= 0 && linked(i, j);
  check(`add link ${at(a)} — ${at(b)}`, ok,
    i < 0 || j < 0 ? 'an end is not in the grid' : ok ? 'now linked' : 'still unlinked');
}
for (const [a, b] of review.wrong.links) {
  const i = find(a), j = find(b);
  const ok = i < 0 || j < 0 || !linked(i, j);
  check(`wrong link ${at(a)} — ${at(b)}`, ok, ok ? 'gone' : 'still linked');
}
for (const q of review.paths) {
  const i = find(q.start), j = find(q.end);
  const name = `path ${at(q.start)} → ${at(q.end)}`;
  if (i < 0 || j < 0) { check(name, false, 'an end is not in the grid'); continue; }
  const got = steps(i, j);
  if (q.reachable === false) { check(name, got === null, got === null ? 'still unreachable' : `now reachable in ${got}`); continue; }
  if (got === null) { check(name, false, `unreachable, expected ${q.steps} steps`); continue; }
  const slack = q.steps * TOL;
  check(name, Math.abs(got - q.steps) <= slack,
    `${got} steps, expected ${q.steps} ±${slack.toFixed(1)}`);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}: ${r.detail}`);
for (const ref of marked.cells) console.log(`note  marked cell ${at(ref)}: ${find(ref) >= 0 ? 'in the grid' : 'not in the grid'}`);
for (const [a, b] of marked.links) {
  const i = find(a), j = find(b);
  console.log(`note  marked link ${at(a)} — ${at(b)}: ${i >= 0 && j >= 0 && linked(i, j) ? 'linked' : 'not linked'}`);
}
for (const v of review.views ?? []) console.log(`note  pinned view: node ${v.node} cell ${v.cell?.c},${v.cell?.r} y ${v.y} step ${v.step} tilt ${v.tilt}°`);
console.log(`\n${results.length - failed.length}/${results.length} passed against ${gridPath}`);
process.exit(failed.length ? 1 : 0);
