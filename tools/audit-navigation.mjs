/**
 * Checks what the game's navigation actually does against what the kit means.
 *
 *     node tools/audit-navigation.mjs [--url http://127.0.0.1:8100/game/index.html]
 *
 * The scene names every mesh `<Piece>__<Material>__<submesh>__<instance>`, so
 * the piece names say what each patch of ground is *for*: a bridge deck is to
 * be walked over, a fence is to be stopped by, water is to be crossed only
 * where something spans it. This reads those names straight out of the GLB,
 * turns them into per-cell expectations, then drives the real page and asks the
 * real navmesh whether it agrees.
 *
 * It exists because fixing navigation one complaint at a time only ever finds
 * the bug the player already tripped over.
 */

import { chromium } from 'playwright';
import { readGlb, readAccessor, nodeWorldMatrices, transformPoint } from './glb.mjs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCENE = join(ROOT, 'scenes', 'Large_Island_v2_No_Ocean_No_Props.glb');

/* What each family of pieces is for. `walkable` is what the navmesh ought to
 * say about the top of that cell; null means the kit does not commit either
 * way and the audit only reports what it finds. */
const FEATURES = [
  { tag: 'water', match: /^Terrain_Water_River|^Water_Waterfall|^Water_Circle/, walkable: false,
    note: 'rivers and falls: cross them on a bridge or not at all' },
  { tag: 'bridge', match: /^Prop_Bridge|^Path_Bridge/, walkable: true,
    note: 'bridge decks: the way over the water' },
  { tag: 'dock', match: /^Docks_Decking/, walkable: true,
    note: 'dock decking: walkable platform' },
  { tag: 'steps', match: /_Steps_|^Docks_Ladder/, walkable: true,
    note: 'steps and ladders: the way between levels' },
  { tag: 'incline', match: /_Incline_/, walkable: true,
    note: 'ramps: the other way between levels' },
  { tag: 'walkway', match: /^Tiered_Walkway_Path/, walkable: true,
    note: 'stone walkways' },
  { tag: 'path', match: /^Path_Terrain/, walkable: true,
    note: 'dirt paths across the grass' },
  { tag: 'fence', match: /^Path_Fence/, walkable: false,
    note: 'fences: meant to stop you' },
  { tag: 'railing', match: /^Docks_Railing/, walkable: false,
    note: 'dock railings: meant to stop you' },
  { tag: 'wall', match: /^Wall_|^Tiered_Retaining_Wall/, walkable: false,
    note: 'walls and retaining walls: meant to stop you' },
  { tag: 'grass', match: /^Grass_/, walkable: true,
    note: 'open grass' },
  { tag: 'sand', match: /^Terrain_Sand/, walkable: true,
    note: 'the beach' },
];

const UP = 0.7;

function readFeatures() {
  const glb = readGlb(SCENE);
  const { json } = glb;
  const world = nodeWorldMatrices(json);
  const positions = new Map();
  const indices = new Map();

  // cell key -> tag -> { top, bottom }
  const cells = new Map();

  for (const [index, node] of json.nodes.entries()) {
    if (node.mesh === undefined || !world[index]) continue;
    const mesh = json.meshes[node.mesh];
    const [piece, material] = (mesh.name ?? '').split('__');
    if (/^Hidden/.test(material ?? '')) continue;

    const feature = FEATURES.find((f) => f.match.test(piece));
    if (!feature) continue;

    const matrix = world[index];
    for (const prim of mesh.primitives) {
      const key = prim.attributes.POSITION;
      if (!positions.has(key)) positions.set(key, readAccessor(glb, key));
      const pos = positions.get(key);
      let list = null;
      if (prim.indices !== undefined) {
        if (!indices.has(prim.indices)) indices.set(prim.indices, readAccessor(glb, prim.indices));
        list = indices.get(prim.indices).data;
      }
      const count = list ? list.length : pos.count;

      for (let i = 0; i + 2 < count; i += 3) {
        const p = [];
        for (let k = 0; k < 3; k++) {
          const v = list ? list[i + k] : i + k;
          p.push(transformPoint(matrix, pos.data[v * 3], pos.data[v * 3 + 1], pos.data[v * 3 + 2]));
        }
        const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
        const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz);
        if (!length) continue;
        const upward = ny / length >= UP;

        const minX = Math.floor(Math.min(p[0][0], p[1][0], p[2][0]));
        const maxX = Math.floor(Math.max(p[0][0], p[1][0], p[2][0]));
        const minZ = Math.floor(Math.min(p[0][2], p[1][2], p[2][2]));
        const maxZ = Math.floor(Math.max(p[0][2], p[1][2], p[2][2]));
        const topY = Math.max(p[0][1], p[1][1], p[2][1]);

        for (let x = minX; x <= maxX; x++) {
          for (let z = minZ; z <= maxZ; z++) {
            const cellKey = `${x},${z}`;
            let byTag = cells.get(cellKey);
            if (!byTag) { byTag = new Map(); cells.set(cellKey, byTag); }
            const record = byTag.get(feature.tag) ?? { top: -Infinity, upTop: -Infinity };
            record.top = Math.max(record.top, topY);
            if (upward) record.upTop = Math.max(record.upTop, topY);
            byTag.set(feature.tag, record);
          }
        }
      }
    }
  }

  // One probe point per (cell, tag): the cell centre at that feature's top.
  const probes = [];
  for (const [cellKey, byTag] of cells) {
    const [x, z] = cellKey.split(',').map(Number);
    for (const [tag, record] of byTag) {
      const height = record.upTop > -Infinity ? record.upTop : record.top;
      const feature = FEATURES.find((f) => f.tag === tag);
      probes.push({ tag, x: x + 0.5, z: z + 0.5, y: height, barrier: feature.walkable === false });
    }
  }
  return probes;
}

async function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--url');
  const url = at === -1 ? 'http://127.0.0.1:8100/game/index.html' : argv[at + 1];

  console.log('reading the scene …');
  const probes = readFeatures();
  const byTag = new Map();
  for (const probe of probes) byTag.set(probe.tag, (byTag.get(probe.tag) ?? 0) + 1);
  console.log(`${probes.length} probe points over ${byTag.size} kinds of thing`);

  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.log('[page error]', error.message));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('loader')?.hasAttribute('hidden'), null, { timeout: 120000 });
  await page.waitForTimeout(400);

  const findings = await page.evaluate((input) => {
    const { navigation, grid, character } = window.island;
    const V3 = character.root.position.constructor;
    const home = navigation.nearestPoint(character.root.position, 6);

    const out = {};
    for (const probe of input) {
      const bucket = out[probe.tag] ?? (out[probe.tag] = { total: 0, onMesh: 0, reachable: 0, crossed: 0, tested: 0 });
      bucket.total++;

      /* Is there navmesh at this exact spot? A generous snap would find the
       * path running alongside a fence and call the fence walkable, so the
       * tolerance is well under one cell. */
      const found = navigation.nearestPoint(new V3(probe.x, probe.y, probe.z), 1.2);
      if (found
        && Math.hypot(found.x - probe.x, found.z - probe.z) < 0.45
        && Math.abs(found.y - probe.y) < 0.8) {
        bucket.onMesh++;
        if (home && navigation.reaches(home, found)) bucket.reachable++;
      }

      if (!probe.barrier) continue;

      /* The real question for a fence is not whether it occupies a cell — it
       * sits on a cell edge and the ground beside it is meant to be walkable —
       * but whether you can step straight through it. So: stand on both sides
       * and see whether the route between them goes through or around. */
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const aY = grid.groundAt(probe.x - dx * 1.1, probe.z - dz * 1.1);
        const bY = grid.groundAt(probe.x + dx * 1.1, probe.z + dz * 1.1);
        if (aY === null || bY === null) continue;
        const a = navigation.nearestPoint(new V3(probe.x - dx * 1.1, aY, probe.z - dz * 1.1), 0.8);
        const b = navigation.nearestPoint(new V3(probe.x + dx * 1.1, bY, probe.z + dz * 1.1), 0.8);
        if (!a || !b) continue;

        bucket.tested++;
        const path = navigation.computePath(a, b);
        if (!path?.length) continue;
        const end = path[path.length - 1];
        if (Math.hypot(end.x - b.x, end.z - b.z) > 1.5) continue; // no route: blocked

        /* Going the long way round is the barrier working, so what counts is
         * whether the route passes through the barrier itself. Measure the
         * path's closest approach to the barrier's own cell centre rather than
         * its length, which cannot tell "through" from "around a short corner". */
        let closest = Infinity;
        for (let k = 1; k < path.length; k++) {
          const ax = path[k - 1].x, az = path[k - 1].z;
          const bx = path[k].x, bz = path[k].z;
          const ex = bx - ax, ez = bz - az;
          const span = ex * ex + ez * ez;
          const t = span ? Math.max(0, Math.min(1, ((probe.x - ax) * ex + (probe.z - az) * ez) / span)) : 0;
          closest = Math.min(closest, Math.hypot(ax + ex * t - probe.x, az + ez * t - probe.z));
        }
        if (closest < 0.55) bucket.crossed++;
      }
    }
    return out;
  }, probes);

  await browser.close();

  console.log('\nwhat the kit means      cells   walkable   reachable   crossable   verdict');
  let failures = 0;
  for (const feature of FEATURES) {
    const result = findings[feature.tag];
    if (!result) continue;
    const onMesh = (result.onMesh / result.total) * 100;
    const reachable = (result.reachable / result.total) * 100;
    const crossable = result.tested ? (result.crossed / result.tested) * 100 : null;

    let verdict = 'ok';
    if (feature.walkable === true && onMesh < 70) { verdict = 'SHOULD BE WALKABLE'; failures++; }
    else if (feature.walkable === true && reachable < 60) { verdict = 'WALKABLE BUT CUT OFF'; failures++; }
    else if (feature.walkable === false && crossable !== null && crossable > 20) { verdict = 'YOU CAN WALK THROUGH IT'; failures++; }

    console.log(
      `${feature.tag.padEnd(9)} ${(feature.walkable ? 'walk' : 'block').padEnd(6)}`
      + ` ${String(result.total).padStart(6)}   ${onMesh.toFixed(0).padStart(7)}%   ${reachable.toFixed(0).padStart(8)}%`
      + `   ${(crossable === null ? '—' : `${crossable.toFixed(0)}%`).padStart(9)}   ${verdict}`,
    );
  }
  console.log(`\n${failures} of ${FEATURES.length} kinds of thing behave wrongly`);
  process.exitCode = failures ? 1 : 0;
}

main();
