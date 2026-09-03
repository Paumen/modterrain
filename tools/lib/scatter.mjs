export const GRASS_PIECES = [
  'grass-1-a', 'grass-1-b', 'grass-1-c', 'grass-1-d',
  'grass-2-a', 'grass-2-b', 'grass-2-c', 'grass-2-d',
];

/* The 'a' variant of each family is a single blade and is never used: grass
 * reads as clumps. b is 132 triangles, c and d are 396 to 528, and everything
 * is baked into one buffer, so this mix is what the scene costs. */
export const PIECE_WEIGHTS = [0, 0.9, 0.08, 0.02];

export const BANDS = ['type 1', 'type 2', 'mixed'];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Column-major, glTF order. The local +y ends up along the surface normal the
 * tuft grew from, so a tuft on a hillside leans with the hill. */
export function instanceMatrix([, x, y, z, yaw, s, h, nx, nz]) {
  const ny = Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz));
  const ux = nz, uz = -nx;
  const len = Math.hypot(ux, uz);
  let r;
  if (len < 1e-6) {
    r = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  } else {
    const ax = ux / len, az = uz / len, t = 1 - ny;
    r = [
      t * ax * ax + ny, -len * az, t * ax * az,
      len * az, ny, -len * ax,
      t * ax * az, len * ax, t * az * az + ny,
    ];
  }
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const yr = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const m = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      m[i * 3 + j] = r[i * 3] * yr[j] + r[i * 3 + 1] * yr[3 + j] + r[i * 3 + 2] * yr[6 + j];
  const sc = [s, h, s];
  return [
    m[0] * sc[0], m[3] * sc[0], m[6] * sc[0], 0,
    m[1] * sc[1], m[4] * sc[1], m[7] * sc[1], 0,
    m[2] * sc[2], m[5] * sc[2], m[8] * sc[2], 0,
    x, y, z, 1,
  ];
}
