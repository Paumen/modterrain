const clamp = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);

export function buildIndex(tris, cell = 1) {
  const n = tris.length / 9;
  const box = new Float64Array(n * 6);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let t = 0; t < n; t++) {
    const a = t * 9, b = t * 6;
    box[b] = Math.min(tris[a], tris[a + 3], tris[a + 6]);
    box[b + 1] = Math.min(tris[a + 1], tris[a + 4], tris[a + 7]);
    box[b + 2] = Math.min(tris[a + 2], tris[a + 5], tris[a + 8]);
    box[b + 3] = Math.max(tris[a], tris[a + 3], tris[a + 6]);
    box[b + 4] = Math.max(tris[a + 1], tris[a + 4], tris[a + 7]);
    box[b + 5] = Math.max(tris[a + 2], tris[a + 5], tris[a + 8]);
    if (box[b] < minX) minX = box[b];
    if (box[b + 3] > maxX) maxX = box[b + 3];
    if (box[b + 2] < minZ) minZ = box[b + 2];
    if (box[b + 5] > maxZ) maxZ = box[b + 5];
  }
  const minBinX = Math.floor(minX / cell) * cell - cell;
  const minBinZ = Math.floor(minZ / cell) * cell - cell;
  const cols = Math.ceil((maxX - minBinX) / cell) + 1;
  const rows = Math.ceil((maxZ - minBinZ) / cell) + 1;

  const index = {
    tris, box, cell, cols, rows, minX: minBinX, minZ: minBinZ,
    bins: Array.from({ length: cols * rows }, () => []),
    seen: new Int32Array(n),
    stamp: 0,
    bx: (x) => clamp(Math.floor((x - minBinX) / cell), cols - 1),
    bz: (z) => clamp(Math.floor((z - minBinZ) / cell), rows - 1),
  };
  for (let t = 0; t < n; t++) {
    const b = t * 6;
    for (let iz = index.bz(box[b + 2]); iz <= index.bz(box[b + 5]); iz++)
      for (let ix = index.bx(box[b]); ix <= index.bx(box[b + 3]); ix++)
        index.bins[iz * cols + ix].push(t);
  }
  return index;
}

export function raycast(index, ox, oy, oz, dx, dy, dz, tMax, tMin = 0.001) {
  const { tris, bins, cols, rows, cell, minX, minZ, seen } = index;
  const stamp = ++index.stamp;
  let best = Infinity;
  let cx = index.bx(ox), cz = index.bz(oz);
  const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  let tX = dx !== 0 ? (minX + (cx + (dx > 0 ? 1 : 0)) * cell - ox) / dx : Infinity;
  let tZ = dz !== 0 ? (minZ + (cz + (dz > 0 ? 1 : 0)) * cell - oz) / dz : Infinity;
  const dX = dx !== 0 ? Math.abs(cell / dx) : Infinity;
  const dZ = dz !== 0 ? Math.abs(cell / dz) : Infinity;
  let t = 0;
  for (let i = 0; i < cols + rows && t <= tMax && t < best; i++) {
    if (cx >= 0 && cx < cols && cz >= 0 && cz < rows) {
      for (const tri of bins[cz * cols + cx]) {
        if (seen[tri] === stamp) continue;
        seen[tri] = stamp;
        const a = tri * 9;
        const e1x = tris[a + 3] - tris[a], e1y = tris[a + 4] - tris[a + 1], e1z = tris[a + 5] - tris[a + 2];
        const e2x = tris[a + 6] - tris[a], e2y = tris[a + 7] - tris[a + 1], e2z = tris[a + 8] - tris[a + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const sx = ox - tris[a], sy = oy - tris[a + 1], sz = oz - tris[a + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (hit > tMin && hit < tMax && hit < best) best = hit;
      }
    }
    if (tX < tZ) { t = tX; tX += dX; cx += stepX; } else { t = tZ; tZ += dZ; cz += stepZ; }
  }
  return best;
}
