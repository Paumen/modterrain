import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VIEWER = resolve(ROOT, 'viewer.html');
const STAMP = /const VIEWER_VERSION = '[^']*';/;

export const hash10 = (parts) => {
  const digest = createHash('sha256');
  for (const part of parts) digest.update(part);
  return digest.digest('hex').slice(0, 10);
};

export const sourceVersion = (paths) => hash10(paths.map((path) => readFileSync(path)));

export function stampViewer() {
  const html = readFileSync(VIEWER, 'utf8');
  if (!STAMP.test(html)) throw new Error('viewer.html: no VIEWER_VERSION to stamp');
  const version = hash10([html.replace(STAMP, '')]);
  writeFileSync(VIEWER, html.replace(STAMP, `const VIEWER_VERSION = '${version}';`));
  return version;
}
