import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { assemble } from './assemble.mjs';
import { writeGlb, measureScene, UNITS_PER_CELL } from './glb.mjs';

const PIVOTS = {
  Prop_Bridge_Rope_End_Basic_1x3: [0, 0, 0.5],
  Prop_Bridge_Rope_Middle_Basic_1x1: [0, 0, 0.5],
  Prop_Bridge_Rope_Middle_Cracked_1_1x1: [0, 0, 0.5],
  Prop_Bridge_Rope_Middle_Cracked_2_1x1: [0, 0, 0.5],
};

const onPivot = (prefab, matrix) => {
  const offset = PIVOTS[prefab];
  if (!offset) return matrix;
  const out = [...matrix];
  for (let row = 0; row < 3; row++) {
    out[row * 4 + 3] += offset.reduce((sum, cell, axis) => sum + cell * matrix[row * 4 + axis], 0);
  }
  return out;
};

const argv = process.argv.slice(2);
const option = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? null : argv[at + 1];
};
const [input, output] = argv.filter((arg, index) => !arg.startsWith('--') && !argv[index - 1]?.startsWith('--'));
if (!input || !output) {
  console.error('usage: node tools/scene-from-unity.mjs <dump.json> <scene.glb> [--skip regex] [--cell-units]');
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

if (argv.includes('--cell-units')) {
  const roots = built.json.scenes[0].nodes;
  built.json.nodes.push({ name: basename(output, '.glb'), scale: [1 / UNITS_PER_CELL, 1 / UNITS_PER_CELL, 1 / UNITS_PER_CELL], children: roots });
  built.json.scenes[0].nodes = [built.json.nodes.length - 1];
}

writeGlb(output, built.json, built.bin);
const measured = measureScene(built);
console.log(`${output}: ${built.placed}/${dump.pieces.length} pieces, ${measured.dwh.map((v) => Math.round(v)).join(' × ')} cells, ${measured.triangles} tris`);
if (built.missing.length) console.log(`  not in atoms/: ${built.missing.join(', ')}`);
