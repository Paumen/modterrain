import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLevels, compile, picture, CELLS_FORMAT } from '../scene/levels-to-cells.mjs';
import { verify, describe } from './verify-scene.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LEVELS = join(ROOT, 'models', 'levels');

const argv = process.argv.slice(2);
const option = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const outDir = option('out', null);
const only = argv.filter((a) => !a.startsWith('--') && a !== outDir);
if (outDir) mkdirSync(outDir, { recursive: true });

const files = readdirSync(LEVELS).filter((f) => f.endsWith('.json') && (!only.length || only.includes(f) || only.includes(f.replace(/\.json$/, '')))).sort();
const tmp = mkdtempSync(join(tmpdir(), 'modterrain-levels-'));
let failed = 0;
try {
  for (const file of files) {
    const path = join(LEVELS, file);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    let cells = path;
    if (data.format !== CELLS_FORMAT) {
      const map = parseLevels(data);
      const { pieces, errors, symbols } = compile(map);
      console.log(`${file}: ${map.cells.size} cells -> ${pieces.length} pieces`);
      console.log(picture(map, symbols).replace(/^/gm, '    '));
      if (errors.length) {
        for (const e of errors) console.log(`  ${e}`);
        console.log('  FAIL (did not compile)\n');
        failed++;
        continue;
      }
      cells = join(outDir ?? tmp, `${basename(file, '.json')}.cells.json`);
      writeFileSync(cells, `${JSON.stringify({ format: CELLS_FORMAT, source: `${file} via levels-to-cells`, pieces }, null, 1)}\n`);
    }
    const r = verify(cells, { png: outDir ? join(outDir, `${basename(file, '.json')}.png`) : null });
    console.log(describe(r).replace(/^/gm, '  '));
    console.log();
    if (!r.ok) failed++;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`${files.length - failed}/${files.length} clean`);
process.exit(failed ? 1 : 0);
