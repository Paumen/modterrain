import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { assemble } from './assemble.mjs';
import { writeGlb, measureScene } from './glb.mjs';
import { onPivot } from './scene-cells.mjs';

const argv = process.argv.slice(2);
const option = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? null : argv[at + 1];
};
const [input, output] = argv.filter((arg, index) => !arg.startsWith('--') && !argv[index - 1]?.startsWith('--'));
if (!input || !output) {
  console.error('usage: node tools/scene-from-unity.mjs <dump.json> <scene.glb> [--skip regex]');
  process.exit(1);
}

const skip = option('skip') && new RegExp(option('skip'));
const dump = JSON.parse(readFileSync(input, 'utf8'));
const placements = dump.pieces
  .filter(({ prefab }) => !skip || !skip.test(prefab))
  .map(({ prefab, matrix }) => ({ piece: prefab, matrix: onPivot(prefab, matrix) }));
const built = assemble(placements);

if (!built.placed) {
  console.error(`${basename(input)}: none of its ${placements.length} pieces are in atoms/`);
  process.exit(1);
}

writeGlb(output, built.json, built.bin);
const measured = measureScene(built);
console.log(`${output}: ${built.placed}/${dump.pieces.length} pieces, ${measured.dwh.map((v) => Math.round(v)).join(' × ')} cells, ${measured.triangles} tris`);
if (built.missing.length) console.log(`  not in atoms/: ${built.missing.join(', ')}`);
