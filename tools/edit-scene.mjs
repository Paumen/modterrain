import { readFileSync } from 'node:fs';
import { readGlb, writeGlb } from './glb.mjs';

const [scenePath, editsPath, outPath] = process.argv.slice(2);
if (!scenePath || !editsPath || !outPath) {
  console.error('usage: node tools/edit-scene.mjs <scene.glb> <edits.json> <out.glb>');
  process.exit(1);
}

const { json, bin } = readGlb(scenePath);
const edits = JSON.parse(readFileSync(editsPath, 'utf8'));

const BASIS = [100, 0, 0, 0, 0, 0, -100, 0, 0, 100, 0, 0, 0, 0, 0, 1];

const mul = (a, b) => {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let ro = 0; ro < 4; ro++)
      for (let k = 0; k < 4; k++) r[c * 4 + ro] += a[k * 4 + ro] * b[c * 4 + k];
  return r;
};

const placement = ({ pos = [0, 0, 0], yaw = 0, scale = [1, 1, 1] }) => {
  const a = (yaw * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const [sx, sy, sz] = scale;
  return [c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, pos[0], pos[1], pos[2], 1];
};

const clean = (m) => m.map((v) => (Math.abs(v) < 1e-9 ? 0 : +v.toFixed(6)));

const num = (v) => String(+(+v).toFixed(3));
const idOf = (node) => `${node.name.split('__')[0]}@${node.matrix.slice(12, 15).map(num).join(',')}`;
const normalize = (id) => {
  const [piece, at] = id.split('@');
  return `${piece}@${at.split(',').map(num).join(',')}`;
};

const nodesById = new Map();
const maxInstance = new Map();
for (const [index, node] of json.nodes.entries()) {
  if (node.children || !node.matrix) throw new Error(`node ${index} is not a flat matrix node; this tool assumes a flat scene`);
  const id = idOf(node);
  if (!nodesById.has(id)) nodesById.set(id, []);
  nodesById.get(id).push(index);
  const piece = node.name.split('__')[0];
  const instance = +node.name.split('__').pop();
  maxInstance.set(piece, Math.max(maxInstance.get(piece) ?? 0, instance));
}
const find = (id) => {
  const indices = nodesById.get(normalize(id));
  if (!indices) throw new Error(`nothing named ${id} in ${scenePath}`);
  return indices;
};

const removed = new Set();
for (const id of edits.remove ?? []) for (const index of find(id)) removed.add(index);

for (const move of edits.move ?? []) {
  const matrix = clean(mul(placement(move), BASIS));
  for (const index of find(move.id)) json.nodes[index].matrix = matrix;
}

const added = [];
for (const add of edits.add ?? []) {
  const template = add.from ? find(add.from) : [...nodesById.entries()].find(([id]) => id.startsWith(`${add.piece}@`))?.[1];
  if (!template) throw new Error(`no ${add.from ?? add.piece} to copy geometry from`);
  const piece = json.nodes[template[0]].name.split('__')[0];
  const instance = maxInstance.get(piece) + 1;
  maxInstance.set(piece, instance);
  const matrix = clean(mul(placement(add), BASIS));
  for (const index of template) {
    const source = json.nodes[index];
    const mesh = json.meshes[source.mesh];
    const meshName = mesh.name.split('__');
    meshName[meshName.length - 1] = String(instance);
    json.meshes.push({ ...mesh, name: meshName.join('__') });
    const nodeName = source.name.split('__');
    nodeName[nodeName.length - 1] = String(instance);
    json.nodes.push({ ...source, name: nodeName.join('__'), mesh: json.meshes.length - 1, matrix });
  }
  added.push(`${piece}@${add.pos.join(',')}`);
}

json.nodes = json.nodes.filter((_, index) => !removed.has(index));
json.scenes = [{ nodes: json.nodes.map((_, index) => index) }];
json.scene = 0;

writeGlb(outPath, json, bin);
console.log(`${scenePath} → ${outPath}`);
console.log(`  removed ${removed.size} nodes (${(edits.remove ?? []).length} pieces), moved ${(edits.move ?? []).length}, added ${added.length}: ${added.join(', ')}`);
