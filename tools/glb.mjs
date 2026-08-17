/**
 * GLB lezen en opmeten.
 *
 * De catalogus meet elk model op zoals het in de scène staat, want dat is wat
 * de bouwer ziet en wat tegen het raster van 1 unit aan moet passen. Deze kit
 * is niet geskind — alles staat als vaste geometrie onder een nodeboom — dus
 * de bounding box volgt uit de POSITION-accessors door de wereldmatrix van hun
 * node.
 *
 * Overgenomen uit de 3D-catalogus van Taaleiland (tools/glb.mjs), teruggebracht
 * tot wat deze repo gebruikt: lezen, opmeten en het driehoekenbudget.
 */

import { readFileSync } from 'node:fs';

/* -- container ------------------------------------------------------------
 * GLB: 12-byte header, daarna chunks van [lengte, type, data]. De eerste chunk
 * is de glTF-JSON, de tweede (als hij er is) de binaire buffer.
 */
export function leesGlb(pad) {
  const buf = readFileSync(pad);
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) {
    throw new Error(`geen geldige GLB: ${pad}`);
  }
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`eerste chunk is geen JSON: ${pad}`);

  const jsonLengte = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLengte).toString('utf8'));

  let bin = null;
  let offset = 20 + jsonLengte;
  while (offset + 8 <= buf.length) {
    const lengte = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    if (type === 0x004e4942) bin = buf.subarray(offset + 8, offset + 8 + lengte);
    offset += 8 + lengte;
  }

  return { json, bin, bytes: buf.length };
}

/* -- matrices -------------------------------------------------------------
 * Kolom-major, zoals glTF ze aanlevert.
 */
const EENHEIDSMATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function maalMatrix(a, b) {
  const r = new Array(16).fill(0);
  for (let kolom = 0; kolom < 4; kolom++) {
    for (let rij = 0; rij < 4; rij++) {
      let som = 0;
      for (let k = 0; k < 4; k++) som += a[k * 4 + rij] * b[kolom * 4 + k];
      r[kolom * 4 + rij] = som;
    }
  }
  return r;
}

/** Node-transform als matrix; `matrix` wint van losse translation/rotation/scale. */
function nodeMatrix(node) {
  if (node.matrix) return node.matrix;

  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** Punt door een kolom-major matrix. */
const maalPunt = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

/* -- accessors ------------------------------------------------------------ */

const COMPONENT = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const ONDERDELEN = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/**
 * Leest een accessor uit als vlakke Float64Array. Sparse accessors komen in
 * deze kit niet voor; als er ooit een opduikt is een harde fout beter dan
 * stilletjes de verkeerde punten meten.
 */
export function leesAccessor({ json, bin }, index) {
  const accessor = json.accessors[index];
  if (accessor.sparse) throw new Error('sparse accessor wordt niet ondersteund');

  const Soort = COMPONENT[accessor.componentType];
  const breedte = ONDERDELEN[accessor.type];
  const bufferView = json.bufferViews[accessor.bufferView];
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stap = bufferView.byteStride ?? breedte * Soort.BYTES_PER_ELEMENT;

  const uit = new Float64Array(accessor.count * breedte);
  for (let i = 0; i < accessor.count; i++) {
    const rij = new Soort(bin.buffer, bin.byteOffset + start + i * stap, breedte);
    for (let k = 0; k < breedte; k++) uit[i * breedte + k] = rij[k];
  }
  return { data: uit, breedte, count: accessor.count };
}

/* -- opmeten -------------------------------------------------------------- */

/**
 * Eén rastervak van deze pack, in de eenheden waarin de bestanden staan.
 *
 * Niet aangenomen maar nagemeten: elk stuk dat `1x1` heet is 100 breed of diep,
 * `12x12` is 1200 en `7x7` is 700. De hoogte volgt hetzelfde raster — een
 * basisblok van één laag is 100 hoog, een wandstuk van twee lagen 200. De
 * catalogus rekent daarom alles om naar rastervakken: "0,5 × 1 × 1" zegt in één
 * oogopslag dat het een halve cel diepe wand van één laag hoog is, en
 * "50 × 100 × 100" zegt dat alleen als je het deelrekensommetje meeneemt.
 *
 * De build controleert deze aanname bij elke run tegen de maat in de naam.
 */
export const EENHEDEN_PER_CEL = 100;

/**
 * Meet de scène op: afmetingen, hoekpunten, driehoeken en tekenopdrachten.
 *
 * - `wdh`: breedte × diepte × hoogte (X × Z × Y) in rastervakken.
 * - `min`/`max`: de bounding box zelf. Deze kit staat bewust níét op de
 *   oorsprong — de oorsprong van elk stuk ís zijn rastervak — dus de box zegt
 *   ook waar het model ten opzichte van dat vak ligt.
 * - `driehoeken`: zoals de scène ze tekent — een mesh die door drie nodes wordt
 *   hergebruikt telt drie keer, want dat is wat de GPU doet.
 * - `calls`: elke primitive is één tekenopdracht.
 */
export function meetScene(glb) {
  const { json } = glb;
  const nodes = json.nodes ?? [];
  const scene = json.scenes?.[json.scene ?? 0];

  const wereld = new Array(nodes.length).fill(null);
  const zetWereld = (index, ouder) => {
    if (wereld[index]) return; // cyclus-beveiliging
    const node = nodes[index];
    if (!node) return;
    wereld[index] = maalMatrix(ouder, nodeMatrix(node));
    for (const kind of node.children ?? []) zetWereld(kind, wereld[index]);
  };
  for (const index of scene?.nodes ?? []) zetWereld(index, EENHEIDSMATRIX);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const pak = (p) => {
    for (let as = 0; as < 3; as++) {
      if (p[as] < min[as]) min[as] = p[as];
      if (p[as] > max[as]) max[as] = p[as];
    }
  };

  let driehoeken = 0;
  let calls = 0;
  const materialen = new Set();

  nodes.forEach((node, index) => {
    if (node.mesh === undefined || !wereld[index]) return;

    for (const prim of json.meshes[node.mesh].primitives ?? []) {
      calls++;
      if (prim.material !== undefined) materialen.add(prim.material);

      const telling = prim.indices !== undefined
        ? json.accessors[prim.indices]
        : json.accessors[prim.attributes.POSITION];
      if ((prim.mode ?? 4) === 4) driehoeken += Math.floor((telling?.count ?? 0) / 3);

      const positie = leesAccessor(glb, prim.attributes.POSITION);
      for (let v = 0; v < positie.count; v++) {
        pak(maalPunt(wereld[index], positie.data[v * 3], positie.data[v * 3 + 1], positie.data[v * 3 + 2]));
      }
    }
  });

  // Alles in rastervakken, op drie decimalen. Zonder afronden zet de
  // float-rekenarij hier 1.0000000298023224 in de catalogus; drie decimalen is
  // ruim genoeg voor een pack die op 1/16 cel is gemodelleerd.
  const rond = (v) => Math.round((v / EENHEDEN_PER_CEL) * 1000) / 1000;
  const meet = (as) => (min[as] === Infinity ? 0 : rond(max[as] - min[as]));

  return {
    wdh: [meet(0), meet(2), meet(1)],
    min: min.map((v) => (Number.isFinite(v) ? rond(v) : 0)),
    max: max.map((v) => (Number.isFinite(v) ? rond(v) : 0)),
    driehoeken,
    calls,
    materiaalIndexen: [...materialen],
  };
}

/**
 * Het tekenbudget in driehoeken per rastervak van 1 × 1 × 1. Hier en nergens
 * anders: build-catalog.mjs schrijft hem mee in catalog.json en de catalogus in
 * de browser leest hem daaruit, zodat één wijziging hier overal doorwerkt.
 *
 * De pack is uitgesproken zuinig — de helft van de stukken haalt de vijftig
 * driehoeken niet — dus deze grens ligt veel lager dan bij een propkit. Hij is
 * gezet op ruim boven de gewone stukken en onder de handvol modellen die er
 * echt uit springen: de touwbruggen en de rondgeslepen watercirkels.
 */
export const BUDGET_PER_UNIT = 250;

/**
 * Driehoeken per bezette rastercel — afgezet tegen BUDGET_PER_UNIT hierboven.
 *
 * De noemer is het aantal cellen dat het model bezet, met één cel als
 * ondergrens: max(1, b × d) × max(1, h). Zonder die ondergrens groeit de
 * dichtheid met 1/maat³ en kan geen enkel klein voorwerp ooit slagen — een
 * railingpaaltje van 0,1 × 0,1 × 0,4 zou op minder dan één driehoek moeten
 * uitkomen. Een vloertegel van 2 × 2 wordt nog steeds op vier cellen
 * afgerekend en een paaltje kleiner dan één cel krijgt geen korting omdat het
 * klein is: zijn budget is precies dat van één cel.
 *
 * Een vlak model blijft `null`: het heeft geen volume, en met een handvol
 * driehoeken staat het toch al buiten elke discussie over budget.
 *
 * @param {number} driehoeken  telling uit meetScene()
 * @param {number[]} wdh       breedte × diepte × hoogte in rastereenheden
 * @returns {number|null} driehoeken per bezette cel, afgerond; null bij een plat model
 */
export function driehoekenPerUnit(driehoeken, wdh) {
  if (wdh.some((maat) => maat === 0)) return null;
  const cellen = Math.max(1, wdh[0] * wdh[1]) * Math.max(1, wdh[2]);
  return Math.round(driehoeken / cellen);
}
