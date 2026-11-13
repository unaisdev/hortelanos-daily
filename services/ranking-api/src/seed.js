/** Keep in sync with shared/daily-seed.js and runner/daily.js */

export const SEED_PREFIXES = {
  dailygold: 'dailyoro:',
};

export const ALLOWED_GAMES = Object.keys(SEED_PREFIXES);

export function dailySeedFor(prefix, date) {
  let hash = 0x811c9dc5;
  for (const ch of `${prefix}${date}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 1;
}

export function expectedSeed(gameId, playDate) {
  const prefix = SEED_PREFIXES[gameId];
  if (!prefix) return null;
  return String(dailySeedFor(prefix, playDate) >>> 0);
}
