import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

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

export function readPng(path) {
  const chunks = readChunks(readFileSync(path));
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
