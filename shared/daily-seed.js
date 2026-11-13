/** Same FNV-1a seed as runner/daily.js — keep in sync. */

export function dailySeedFor(prefix, date) {
  let hash = 0x811c9dc5;
  for (const ch of `${prefix}${date}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 1;
}

export function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
