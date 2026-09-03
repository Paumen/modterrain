/* Just enough ZIP to read `modular_terrain_2_0_textures.zip` without unpacking
 * it first: the central directory, and stored or deflated entries. The pack's
 * own textures are the source of every colour in `textures/colormap.png`, so
 * the tool that derives them reads the archive the repo already ships rather
 * than a folder someone has to produce by hand.
 */

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;

/** @returns {Map<string, () => Buffer>} entry name → its bytes, read on demand */
export function readZip(path) {
  const buf = readFileSync(path);

  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== END_OF_DIRECTORY) end--;
  if (end < 0) throw new Error(`${path}: no end-of-directory record`);

  const count = buf.readUInt16LE(end + 10);
  let offset = buf.readUInt32LE(end + 16);
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== DIRECTORY_ENTRY) throw new Error(`${path}: bad directory entry`);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.set(name, () => {
      // The local header repeats the name and carries its own extra field,
      // which is not the same length as the one in the directory.
      const localName = buf.readUInt16LE(localOffset + 26);
      const localExtra = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localName + localExtra;
      const data = buf.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`${name}: unsupported compression method ${method}`);
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
