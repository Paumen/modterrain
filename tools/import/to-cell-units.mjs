import { readGlb, writeGlb } from '../lib/glb.mjs';

const argv = process.argv.slice(2);
const at = argv.indexOf('--factor');
const factor = at === -1 ? null : Number(argv[at + 1]);
const files = argv.filter((arg, index) => !arg.startsWith('--') && !argv[index - 1]?.startsWith('--'));

if (!files.length || !Number.isFinite(factor) || factor <= 0) {
  console.error('usage: node tools/import/to-cell-units.mjs <model.glb>... --factor <n>');
  process.exit(1);
}

const scaleRoot = (node, by) => {
  if (node.matrix) {
    const out = [...node.matrix];
    for (let column = 0; column < 4; column++) {
      for (let row = 0; row < 3; row++) out[column * 4 + row] *= by;
    }
    return { ...node, matrix: out };
  }
  return {
    ...node,
    translation: (node.translation ?? [0, 0, 0]).map((v) => v * by),
    scale: (node.scale ?? [1, 1, 1]).map((v) => v * by),
  };
};

let changed = 0;
for (const file of files) {
  const glb = readGlb(file);
  const roots = glb.json.scenes?.[glb.json.scene ?? 0]?.nodes ?? [];
  if (!roots.length) {
    console.error(`${file}: no scene roots`);
    process.exitCode = 1;
    continue;
  }
  for (const index of roots) glb.json.nodes[index] = scaleRoot(glb.json.nodes[index], factor);
  writeGlb(file, glb.json, glb.bin);
  changed++;
}
console.log(`${changed} models scaled by ${factor}`);
