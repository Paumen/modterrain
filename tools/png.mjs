import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  const chunks = [];
  let offset = 8;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    chunks.push({ type, data: buf.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

function unfilter(raw, width, height, samplesPerPixel) {
  const stride = width * samplesPerPixel;
  const out = new Uint8Array(height * stride);
  let prevRow = new Uint8Array(stride);
  let offset = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[offset]; offset += 1;
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const byte = raw[offset + x];
      const a = x >= samplesPerPixel ? row[x - samplesPerPixel] : 0;
      const b = prevRow[x];
      const c = x >= samplesPerPixel ? prevRow[x - samplesPerPixel] : 0;
      let value;
      if (filter === 0) value = byte;
      else if (filter === 1) value = byte + a;
      else if (filter === 2) value = byte + b;
      else if (filter === 3) value = byte + Math.floor((a + b) / 2);
      else if (filter === 4) value = byte + paeth(a, b, c);
      else throw new Error(`unknown PNG filter type ${filter}`);
      row[x] = value;
    }
    out.set(row, y * stride);
    offset += stride;
    prevRow = row;
  }
  return out;
}

export const readPng = (path) => decodePng(readFileSync(path), path);

export function decodePng(buf, path = 'buffer') {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr.readUInt8(8);
  const colorType = ihdr.readUInt8(9);
  const interlace = ihdr.readUInt8(12);
  if (bitDepth !== 8) throw new Error(`${path}: only 8-bit PNGs are supported`);
  if (interlace !== 0) throw new Error(`${path}: interlaced PNGs are not supported`);

  const samplesPerPixel = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!samplesPerPixel) throw new Error(`${path}: unsupported PNG color type ${colorType}`);

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const samples = unfilter(inflateSync(idat), width, height, samplesPerPixel);

  const pixelCount = width * height;
  const pixels = new Uint8Array(pixelCount * 4);

  if (colorType === 3) {
    const plte = chunks.find((c) => c.type === 'PLTE').data;
    const trns = chunks.find((c) => c.type === 'tRNS')?.data;
    for (let i = 0; i < pixelCount; i++) {
      const index = samples[i];
      pixels[i * 4] = plte[index * 3];
      pixels[i * 4 + 1] = plte[index * 3 + 1];
      pixels[i * 4 + 2] = plte[index * 3 + 2];
      pixels[i * 4 + 3] = trns && index < trns.length ? trns[index] : 255;
    }
  } else {
    for (let i = 0; i < pixelCount; i++) {
      const s = i * samplesPerPixel;
      const [r, g, b, a] =
        samplesPerPixel === 1 ? [samples[s], samples[s], samples[s], 255]
        : samplesPerPixel === 2 ? [samples[s], samples[s], samples[s], samples[s + 1]]
        : samplesPerPixel === 3 ? [samples[s], samples[s + 1], samples[s + 2], 255]
        : [samples[s], samples[s + 1], samples[s + 2], samples[s + 3]];
      pixels[i * 4] = r; pixels[i * 4 + 1] = g; pixels[i * 4 + 2] = b; pixels[i * 4 + 3] = a;
    }
  }

  return { width, height, pixels };
}

export function averageColor(path) {
  const { pixels } = readPng(path);
  let r = 0, g = 0, b = 0, weight = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3] / 255;
    r += pixels[i] * a;
    g += pixels[i + 1] * a;
    b += pixels[i + 2] * a;
    weight += a;
  }
  if (weight === 0) weight = 1;
  const hex = (v) => Math.round(v / weight).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/* 8-bit RGBA, no interlacing, one filter chosen per row — the same five the
 * reader above undoes. Choosing matters here: the colormap is flat vertical
 * bands, which Sub flattens to runs of zeroes, and writing every row unfiltered
 * would double the file for nothing. The choice is the usual one, the filter
 * whose output has the smallest absolute sum. */
export function writePng(path, { width, height, pixels }) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  const candidate = Buffer.alloc(stride);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const row = Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride);
    let bestFilter = 0;
    let bestScore = Infinity;
    let best = null;

    for (let filter = 0; filter <= 4; filter++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? row[x - 4] : 0;
        const b = previous[x];
        const c = x >= 4 ? previous[x - 4] : 0;
        const value =
          filter === 0 ? row[x]
          : filter === 1 ? row[x] - a
          : filter === 2 ? row[x] - b
          : filter === 3 ? row[x] - Math.floor((a + b) / 2)
          : row[x] - paeth(a, b, c);
        candidate[x] = value & 0xff;
        score += Math.min(candidate[x], 256 - candidate[x]);
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
        best = Buffer.from(candidate);
      }
    }

    raw[y * (stride + 1)] = bestFilter;
    best.copy(raw, y * (stride + 1) + 1);
    previous = row;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);

  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };

  writeFileSync(path, Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
