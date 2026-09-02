import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { assemble } from './assemble.mjs';
import { writeGlb, measureScene } from './glb.mjs';

const argv = process.argv.slice(2);
const [input, output] = argv.filter((arg) => !arg.startsWith('--'));
if (!input || !output) {
  console.error('usage: node tools/scene-from-unity.mjs <dump.json> <scene.glb>');
  process.exit(1);
}

const dump = JSON.parse(readFileSync(input, 'utf8'));
const placements = dump.pieces.map(({ prefab, matrix }) => ({ piece: prefab, matrix }));
const built = assemble(placements);

if (!built.placed) {
  console.error(`${basename(input)}: none of its ${placements.length} pieces are in atoms/`);
  process.exit(1);
}

writeGlb(output, built.json, built.bin);
const measured = measureScene(built);
console.log(`${output}: ${built.placed}/${placements.length} pieces, ${measured.dwh.map((v) => Math.round(v)).join(' × ')} cells, ${measured.triangles} tris`);
if (built.missing.length) console.log(`  not in atoms/: ${built.missing.join(', ')}`);
