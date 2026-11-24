#!/usr/bin/env node
/**
 * Admin helper for burned Instagram handles (table `released_handles`).
 *
 *   npm run admin:list-released                     # remote D1 (production)
 *   npm run admin:release-handle -- <handle>        # frees it so anyone can claim it again
 *   npm run admin:release-handle -- <handle> --local  # same against the local dev D1
 *
 * Needs `wrangler login` (or CLOUDFLARE_API_TOKEN). Runs from services/ranking-api.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_NAME = 'hortelanos-daily-ranking';
const HANDLE_RE = /^[a-z0-9._]{1,30}$/;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const [command, ...rest] = process.argv.slice(2);
const local = rest.includes('--local');
const args = rest.filter((a) => a !== '--local');

function normalize(raw) {
  const value = String(raw || '').trim().replace(/^@/, '').toLowerCase();
  return HANDLE_RE.test(value) ? value : null;
}

function d1(sql) {
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB_NAME, local ? '--local' : '--remote', '--command', sql],
    { cwd: root, stdio: 'inherit' },
  );
}

if (command === 'list') {
  d1('SELECT instagram, released_by_device, released_at FROM released_handles ORDER BY released_at DESC');
} else if (command === 'release') {
  const handle = normalize(args[0]);
  if (!handle) {
    console.error('Uso: npm run admin:release-handle -- <handle> [--local]');
    process.exit(1);
  }
  // `handle` is validated against HANDLE_RE, so interpolating it into SQL is safe.
  d1(`DELETE FROM released_handles WHERE instagram = '${handle}'`);
  console.log(`\n@${handle} liberado: ya se puede volver a reclamar.`);
} else {
  console.error('Comandos: list | release <handle>  [--local]');
  process.exit(1);
}
