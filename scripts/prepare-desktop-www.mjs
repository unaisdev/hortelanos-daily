// Copia el frontend estático a desktop-www/ para frontendDist de Tauri.
// El runtime real sirve desde resource_dir (bundle.resources) vía HTTP local.
import { cp, mkdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, 'desktop-www');

const entries = ['shell', 'runner', 'shared', 'catalog', 'games', 'docs', 'index.html'];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

function allow(src) {
  const name = basename(src);
  if (name === '.DS_Store') return false;
  if (name.endsWith('.gba') && !name.endsWith('.gba.gz')) return false;
  return true;
}

for (const name of entries) {
  await cp(join(root, name), join(out, name), { recursive: true, filter: allow });
}

console.log(`prepare-desktop-www → ${out}`);
