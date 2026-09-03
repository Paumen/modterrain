import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const tool = (rel) => join(ROOT, 'tools', rel);

const run = (script, args) => {
  try {
    return { out: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
  } catch (e) {
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
};

export function verify(cells, { ocean = null, png = null, azimuth = -140, elevation = 30, width = 900, height = 600 } = {}) {
  const scene = JSON.parse(readFileSync(cells, 'utf8'));
  const lowest = Math.min(...scene.pieces.filter((p) => p.at).map((p) => p.at[1]));
  const sea = ocean ?? lowest - 0.5;
  const dir = mkdtempSync(join(tmpdir(), 'modterrain-verify-'));
  try {
    const tableReport = join(dir, 'table.json');
    const table = run(tool('check/check-sockets.mjs'), [cells, '--json', tableReport]);
    const lintReport = join(dir, 'lint.json');
    const lint = run(tool('check/lint-sockets.mjs'), [cells, '--ocean', String(sea), '--json', lintReport, '--verbose']);
    const result = { scene: basename(cells), ocean: sea, pieces: scene.pieces.length, table: null, lint: null, rendered: null, missing: [] };
    if (table.code > 1 || !readable(tableReport)) throw new Error(`check-sockets failed:\n${table.out}`);
    if (lint.code > 1 || !readable(lintReport)) throw new Error(`lint-sockets failed:\n${lint.out}`);
    const t = JSON.parse(readFileSync(tableReport, 'utf8'));
    const l = JSON.parse(readFileSync(lintReport, 'utf8'));
    result.missing = [...new Set([...t.missing, ...l.missing])];
    const totals = Object.values(t.materials).reduce((a, s) => ({ n: a.n + s.n, paired: a.paired + s.paired, open: a.open + s.open, wrong: a.wrong + s.wrong }), { n: 0, paired: 0, open: 0, wrong: 0 });
    result.table = { sockets: totals.n, paired: totals.paired, open: totals.open, wrong: totals.wrong };
    const exposed = l.exposed.filter((f) => !f.edge);
    result.lint = { wrong: l.wrongColour.length, exposed: exposed.length, atEdge: l.atEdge, cracks: l.cracked, exposedFaces: exposed, wrongSockets: l.wrongColour };
    if (png) {
      const dump = join(dir, 'dump.json');
      const glb = join(dir, 'scene.glb');
      for (const [script, args] of [
        ['scene/scene-cells.mjs', [cells, '--to-dump', '--out', dump]],
        ['scene/scene-from-unity.mjs', [dump, glb]],
        ['render.mjs', [glb, '--out', png, '--azimuth', String(azimuth), '--elevation', String(elevation), '--width', String(width), '--height', String(height)]],
      ]) {
        const r = run(tool(script), args);
        if (r.code) throw new Error(`${script} failed:\n${r.out}`);
      }
      result.rendered = png;
    }
    result.ok = result.missing.length === 0 && result.table.wrong === 0 && result.lint.wrong === 0 && result.lint.exposed === 0;
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const readable = (path) => { try { readFileSync(path); return true; } catch { return false; } };

export function describe(r) {
  const lines = [];
  lines.push(`${r.scene}: ${r.pieces} pieces, ocean ${r.ocean}`);
  if (r.missing.length) lines.push(`  not in the kit: ${r.missing.join(', ')}`);
  lines.push(`  table: ${r.table.sockets} sockets, ${r.table.paired} paired, ${r.table.open} open, ${r.table.wrong} wrong`);
  lines.push(`  mesh:  ${r.lint.wrong} wrong colour, ${r.lint.exposed} exposed (${r.lint.atEdge} more at the scene edge), ${r.lint.cracks} hairline cracks`);
  for (const f of r.lint.exposedFaces) lines.push(`    exposed: #${f.placement} ${f.piece} at ${f.at.join(',')} ${f.material} near ${f.near.join(',')}`);
  for (const s of r.lint.wrongSockets) lines.push(`    wrong: #${s.placement} ${s.piece} at ${s.at.join(',')} ${s.material} covered by ${s.partner}`);
  if (r.rendered) lines.push(`  rendered: ${r.rendered}`);
  lines.push(r.ok ? '  OK' : '  FAIL');
  return lines.join('\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const option = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
  const taken = new Set(['ocean', 'png', 'azimuth', 'elevation'].map((n) => option(n, null)).filter(Boolean));
  const input = argv.find((a) => !a.startsWith('--') && !taken.has(a));
  if (!input) {
    console.error('usage: node tools/check/verify-scene.mjs <cells.json> [--ocean y] [--png out.png] [--azimuth deg] [--elevation deg]');
    process.exit(1);
  }
  const r = verify(input, {
    ocean: option('ocean', null) === null ? null : Number(option('ocean')),
    png: option('png', null),
    azimuth: Number(option('azimuth', -140)),
    elevation: Number(option('elevation', 30)),
  });
  console.log(describe(r));
  process.exit(r.ok ? 0 : 1);
}
