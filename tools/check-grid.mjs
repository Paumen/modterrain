// Checks a built grid against the scene it came from, and prints counts.
//
//   node tools/check-grid.mjs scenes/Foo.glb
//
// Nothing here reuses the builder's own tests: the builder asks whether a
// doorway rectangle is clear, this asks whether the straight walk between two
// cell centres would pass through a barrier triangle, by triangle-triangle
// overlap. Two different questions answered two different ways, so agreement
// means something.
//
// What it reports, and what each number should be:
//
//   fence crossings   0 -- a link running through a fence, railing or a shut
//                     gate is somewhere you can walk through solid timber.
//   open gates        every gate frame without a door, passable.
//   shut gates        every gate frame with a door, blocked.
//   buried floors     0 -- a walkable cell inside a cliff piece. The builder
//                     locates cliff pieces by the box the kit declares for
//                     them; this one measures the box off the vertices, so
//                     agreement is not the same arithmetic run twice.

import { readGlb } from './glb.mjs';
import { readFileSync } from 'node:fs';

const input = process.argv[2];
if (!input) { console.error('usage: node tools/check-grid.mjs <scene.glb>'); process.exit(1); }
const { json, bin } = readGlb(input);
const grid = JSON.parse(readFileSync(input.replace(/\.glb$/, '_grid.json'), 'utf8'));

const CTOR = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const data = (i) => {
  const a = json.accessors[i], bv = json.bufferViews[a.bufferView];
  return new CTOR[a.componentType](bin.buffer, bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0), a.count * NCOMP[a.type]);
};
const IDENT = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const mul = (a, b) => {
  const r = new Array(16);
  for (let c = 0; c < 4; c++) for (let o = 0; o < 4; o++)
    r[c*4+o] = a[o]*b[c*4] + a[4+o]*b[c*4+1] + a[8+o]*b[c*4+2] + a[12+o]*b[c*4+3];
  return r;
};
const local = (n) => {
  if (n.matrix) return n.matrix;
  const [tx,ty,tz] = n.translation || [0,0,0];
  const [qx,qy,qz,qw] = n.rotation || [0,0,0,1];
  const [sx,sy,sz] = n.scale || [1,1,1];
  const x2=qx+qx,y2=qy+qy,z2=qz+qz, xx=qx*x2,xy=qx*y2,xz=qx*z2, yy=qy*y2,yz=qy*z2,zz=qz*z2, wx=qw*x2,wy=qw*y2,wz=qw*z2;
  return [(1-(yy+zz))*sx,(xy+wz)*sx,(xz-wy)*sx,0, (xy-wz)*sy,(1-(xx+zz))*sy,(yz+wx)*sy,0, (xz+wy)*sz,(yz-wx)*sz,(1-(xx+yy))*sz,0, tx,ty,tz,1];
};
const put = (m,x,y,z) => [m[0]*x+m[4]*y+m[8]*z+m[12], m[1]*x+m[5]*y+m[9]*z+m[13], m[2]*x+m[6]*y+m[10]*z+m[14]];

const sub = (a,b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a,b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

// Barrier triangles: fences, railings, bumpers, gate doors, bridge handrails.
const BARRIER = /^(Path_Fence_|Docks_Railing_|Docks_Bumper_)/;
const bars = [];               // [p0,p1,p2, family]
// Cliff pieces, as world boxes measured off their own vertices, and the cells
// a bridge crosses, which the cliff rule exempts at every height.
const CLIFF = /^(Basic_|Wall_|Cracked_)/;
const DECK = /^(Prop_Bridge_|Path_Bridge_|Docks_Decking_|Docks_Ladder_Top)/;
const cliffBoxes = [];
const deckCells = new Set();
const gates = [];              // { piece, x, z, doored }
const doors = [];
function walk(i, parent) {
  const n = json.nodes[i];
  const w = parent === IDENT && n.matrix ? n.matrix : mul(parent, local(n));
  const piece = (n.name || '').split('__')[0];
  if (n.mesh != null) {
    const bridge = /^Prop_Bridge_/.test(piece);
    if (/^Path_Fence_Gate_Frame_/.test(piece)) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const prim of json.meshes[n.mesh].primitives) {
        const pos = data(prim.attributes.POSITION);
        for (let q = 0; q < pos.length; q += 3) {
          const p = put(w, pos[q], pos[q+1], pos[q+2]);
          x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]);
        }
      }
      gates.push({ piece, x: w[12], z: w[14], spanX: x1 - x0, spanZ: z1 - z0 });
    }
    if (/^Path_Fence_Gate_Door_/.test(piece)) doors.push({ x: w[12], z: w[14] });
    if ((BARRIER.test(piece) && !/^Path_Fence_Gate_Frame_/.test(piece)) || bridge) {
      for (const prim of json.meshes[n.mesh].primitives) {
        if ((prim.mode ?? 4) !== 4 || /^Hidden/.test(json.materials?.[prim.material]?.name ?? '')) continue;
        const pos = data(prim.attributes.POSITION);
        const idx = prim.indices != null ? data(prim.indices) : null;
        const count = idx ? idx.length : pos.length / 3;
        for (let t = 0; t < count; t += 3) {
          const v = [0,1,2].map((k) => { const q = (idx ? idx[t+k] : t+k) * 3; return put(w, pos[q], pos[q+1], pos[q+2]); });
          if (bridge) {
            const ax=v[1][0]-v[0][0], ay=v[1][1]-v[0][1], az=v[1][2]-v[0][2];
            const bx=v[2][0]-v[0][0], by=v[2][1]-v[0][1], bz=v[2][2]-v[0][2];
            const ny = az*bx - ax*bz, len = Math.hypot(ay*bz-az*by, ny, ax*by-ay*bx) || 1;
            if (Math.abs(ny / len) >= 0.5) continue;   // the deck, not a rail
          }
          bars.push([...v, piece]);
        }
      }
    }
  }
  if (n.mesh != null && (CLIFF.test(piece) || DECK.test(piece))) {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const prim of json.meshes[n.mesh].primitives) {
      const pos = data(prim.attributes.POSITION);
      for (let q = 0; q < pos.length; q += 3) {
        const p = put(w, pos[q], pos[q+1], pos[q+2]);
        for (let a = 0; a < 3; a++) { if (p[a] < lo[a]) lo[a] = p[a]; if (p[a] > hi[a]) hi[a] = p[a]; }
      }
    }
    if (CLIFF.test(piece)) cliffBoxes.push([...lo, ...hi]);
    else for (let x = Math.floor(lo[0]); x <= Math.floor(hi[0]); x++)
      for (let z = Math.floor(lo[2]); z <= Math.floor(hi[2]); z++) deckCells.add(x + ',' + z);
  }
  for (const c of n.children || []) walk(c, w);
}
for (const root of json.scenes[json.scene ?? 0].nodes) walk(root, IDENT);

// --- triangle vs triangle (Moller) ---------------------------------------
function coplanarSkip() { return false; }
function triHit(A, B) {
  const nB = cross(sub(B[1],B[0]), sub(B[2],B[0])), dB = -dot(nB, B[0]);
  const dA = A.map((p) => dot(nB, p) + dB);
  if ((dA[0] > 1e-9 && dA[1] > 1e-9 && dA[2] > 1e-9) || (dA[0] < -1e-9 && dA[1] < -1e-9 && dA[2] < -1e-9)) return false;
  const nA = cross(sub(A[1],A[0]), sub(A[2],A[0])), dAo = -dot(nA, A[0]);
  const dB2 = B.map((p) => dot(nA, p) + dAo);
  if ((dB2[0] > 1e-9 && dB2[1] > 1e-9 && dB2[2] > 1e-9) || (dB2[0] < -1e-9 && dB2[1] < -1e-9 && dB2[2] < -1e-9)) return false;
  const D = cross(nA, nB);
  const axis = Math.abs(D[0]) > Math.abs(D[1]) ? (Math.abs(D[0]) > Math.abs(D[2]) ? 0 : 2) : (Math.abs(D[1]) > Math.abs(D[2]) ? 1 : 2);
  if (Math.hypot(...D) < 1e-12) return coplanarSkip();
  const span = (T, d) => {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      if ((d[i] > 0) === (d[j] > 0) && d[i] !== 0 && d[j] !== 0) continue;
      if (d[i] === d[j]) continue;
      const f = d[i] / (d[i] - d[j]);
      out.push(T[i][axis] + (T[j][axis] - T[i][axis]) * f);
    }
    return out.length >= 2 ? [Math.min(...out), Math.max(...out)] : null;
  };
  const sA = span(A, dA), sB = span(B, dB2);
  if (!sA || !sB) return false;
  return sA[0] <= sB[1] + 1e-9 && sB[0] <= sA[1] + 1e-9;
}

// --- the walk between two cells, as a quad -------------------------------
const O = grid.meta.origin;
const nodes = grid.nodes.map((n) => ({ c: O.c + n[0], r: O.r + n[1], y: n[2], n: [] }));
for (let i = 0; i < grid.edges.length; i += 2) { nodes[grid.edges[i]].n.push(grid.edges[i+1]); nodes[grid.edges[i+1]].n.push(grid.edges[i]); }

const BIN = new Map();
const key = (x, z) => `${Math.floor(x)},${Math.floor(z)}`;
bars.forEach((b, i) => {
  const xs = [b[0][0], b[1][0], b[2][0]], zs = [b[0][2], b[1][2], b[2][2]];
  for (let x = Math.floor(Math.min(...xs)); x <= Math.floor(Math.max(...xs)); x++)
    for (let z = Math.floor(Math.min(...zs)); z <= Math.floor(Math.max(...zs)); z++) {
      const k = `${x},${z}`; if (!BIN.has(k)) BIN.set(k, []); BIN.get(k).push(i);
    }
});
// Two bands: what a walk would have to climb over, and what it merely steps
// over. A bridge's front lip and a kerb live in the low band; a fence rail,
// a railing and a gate's door reach into the high one.
const KNEE = 0.5, HIGH = 1.8, LOW = 0.05;
function crossesBarrier(a, b, low) {
  const A = [a.c + 0.5, a.y, a.r + 0.5], B = [b.c + 0.5, b.y, b.r + 0.5];
  const quad = [
    [[A[0], A[1]+low, A[2]], [B[0], B[1]+low, B[2]], [B[0], B[1]+HIGH, B[2]]],
    [[A[0], A[1]+low, A[2]], [B[0], B[1]+HIGH, B[2]], [A[0], A[1]+HIGH, A[2]]],
  ];
  const seen = new Set();
  for (const [x, z] of [[a.c, a.r], [b.c, b.r], [(a.c+b.c)/2, (a.r+b.r)/2]])
    for (const i of BIN.get(key(x + 0.5, z + 0.5)) || []) seen.add(i);
  for (const i of seen) {
    const t = bars[i];
    for (const q of quad) if (triHit([t[0], t[1], t[2]], q)) return t[3];
  }
  return null;
}

const tally = new Map();
let crossings = 0, stepped = 0;
const examples = [];
for (let e = 0; e < grid.edges.length; e += 2) {
  const a = nodes[grid.edges[e]], b = nodes[grid.edges[e+1]];
  const fam = crossesBarrier(a, b, KNEE);
  if (!fam) { if (crossesBarrier(a, b, LOW)) stepped++; continue; }
  crossings++;
  tally.set(fam, (tally.get(fam) || 0) + 1);
  if (examples.length < 8) examples.push(`${fam}: (${a.c},${a.r},${a.y.toFixed(2)}) -> (${b.c},${b.r},${b.y.toFixed(2)})`);
}
if (process.argv.includes('--where')) console.log(examples.join('\n'));

// One piece arrives as one node per material, so the same gate is here
// several times over; keep one of each position.
const oneEach = (list) => [...new Map(list.map((g) => [`${g.x.toFixed(2)},${g.z.toFixed(2)}`, g])).values()];
// Gates: a frame is passable when some link crosses its cell in the direction
// you walk through it, which is across the frame's width.
const at = new Map();
nodes.forEach((n, i) => { const k = `${n.c},${n.r}`; if (!at.has(k)) at.set(k, []); at.get(k).push(i); });
let openOk = 0, openTotal = 0;
for (const g of oneEach(gates)) {
  const c = Math.floor(g.x), r = Math.floor(g.z);
  const doored = doors.some((d) => Math.floor(d.x) === c && Math.floor(d.z) === r);
  // You walk through a gateway across its width, so the pass direction is
  // whichever horizontal axis the frame is narrower in.
  const dir = g.spanX > g.spanZ ? [0, 1] : [1, 0];
  let through = false;
  for (const i of at.get(`${c},${r}`) || []) for (const j of nodes[i].n) {
    const d = [nodes[j].c - nodes[i].c, nodes[j].r - nodes[i].r];
    if (Math.abs(d[0]) === Math.abs(dir[0]) && Math.abs(d[1]) === Math.abs(dir[1])) through = true;
  }
  if (doored) continue;   // a shut gate blocks by having its door across the way, which is a crossing
  openTotal++; if (through) openOk++;
}

console.log(`links: ${grid.edges.length / 2}`);
console.log(`links stepping over something knee-high or lower: ${stepped}`);
console.log(`fence crossings: ${crossings}${crossings ? '\n  ' + [...tally].sort((a,b)=>b[1]-a[1]).map(([k,v]) => `${String(v).padStart(4)} ${k}`).join('\n  ') : ''}`);
let buried = 0;
for (const n of nodes) {
  const x = n.c + 0.5, z = n.r + 0.5;
  if (deckCells.has(`${n.c},${n.r}`)) continue;
  if (cliffBoxes.some((d) => x >= d[0] && x <= d[3] && z >= d[2] && z <= d[5]
      && n.y > d[1] + 0.05 && n.y < d[4] - 0.05)) buried++;
}
console.log(`open gates passable: ${openOk}/${openTotal}`);
console.log(`walkable cells buried inside a cliff piece: ${buried}`);
