/**
 * Session cache for ranking data: kept as long as possible, never expires by time.
 *
 * - Lives in `sessionStorage` (mirrored in memory), so it survives the shell → runner → shell
 *   navigation (same window, same origin) and is wiped when the app is closed.
 * - Keys carry the local day, so a session left open overnight refreshes by itself.
 * - Only successful results are cached; errors are always retried.
 * - Concurrent identical requests share one network call.
 * - Invalidated by the player's own actions: winning (that ROM) or renaming (everything).
 *   Other people's wins show up after reopening the app, by design.
 */

const PREFIX = 'hortelano:rk:';

/** key → result. Also used when sessionStorage is unavailable. */
const memory = new Map();
/** key → in-flight Promise, so two views asking for the same list don't fetch twice. */
const inflight = new Map();
/** Bumped on every invalidation; a load that started before it must not write its (stale) result. */
let generation = 0;

function localDay() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `kind` = 'today' | 'all' | 'player'; `game` '' means "all ROMs" and is stored as '*'. */
export function cacheKey(kind, gameId, ...rest) {
  return `${PREFIX}${localDay()}|${kind}|${gameId || '*'}|${rest.join('|')}`;
}

function store() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null; // storage can throw (blocked / private mode)
  }
}

function read(key) {
  if (memory.has(key)) return memory.get(key);
  try {
    const raw = store()?.getItem(key);
    if (raw) {
      const value = JSON.parse(raw);
      memory.set(key, value);
      return value;
    }
  } catch { /* corrupt entry: treat as a miss */ }
  return undefined;
}

export function cachePut(key, value) {
  memory.set(key, value);
  try {
    store()?.setItem(key, JSON.stringify(value));
  } catch { /* quota exceeded: still served from memory this page load */ }
}

export function cachePeek(key) {
  return read(key);
}

/**
 * Returns the cached result for `key`, or runs `loader` once and caches it when `ok` is true.
 * @template T
 * @param {string} key
 * @param {() => Promise<T & { ok?: boolean }>} loader
 * @returns {Promise<T>}
 */
export function cached(key, loader) {
  const hit = read(key);
  if (hit !== undefined) return Promise.resolve(hit);
  if (inflight.has(key)) return inflight.get(key);
  const startedAt = generation;
  const pending = Promise.resolve()
    .then(loader)
    .then((result) => {
      if (result?.ok && startedAt === generation) cachePut(key, result);
      return result;
    })
    .finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
  inflight.set(key, pending);
  return pending;
}

function allKeys() {
  const keys = new Set(memory.keys());
  try {
    const s = store();
    for (let i = 0; s && i < s.length; i += 1) {
      const k = s.key(i);
      if (k?.startsWith(PREFIX)) keys.add(k);
    }
  } catch { /* ignore */ }
  return [...keys];
}

/**
 * Drops cached ranking data. With a `gameId`, only that ROM's lists and profiles (plus the
 * all-ROMs ones, which include it); without it, everything. Avatar versions are kept.
 */
export function invalidateRanking(gameId = '') {
  for (const key of allKeys()) {
    if (key.startsWith(`${PREFIX}avatar|`)) continue;
    const [, , game] = key.slice(PREFIX.length).split('|');
    if (gameId && game !== gameId && game !== '*') continue;
    memory.delete(key);
    try {
      store()?.removeItem(key);
    } catch { /* ignore */ }
  }
  // In-flight loads started before the change may carry stale data: don't reuse or store them.
  generation += 1;
  inflight.clear();
}

/**
 * Test helper: what a page navigation does. The in-memory mirror and in-flight loads vanish with
 * the old document; `sessionStorage` (the real cache) stays.
 */
export function dropMemoryMirror() {
  memory.clear();
  generation += 1;
  inflight.clear();
}

/** Test helper: forget everything, including the memory mirror. */
export function resetRankingCache() {
  for (const key of allKeys()) {
    try {
      store()?.removeItem(key);
    } catch { /* ignore */ }
  }
  memory.clear();
  generation += 1;
  inflight.clear();
}

/**
 * Avatar cache-buster per handle. The Worker serves photos with a short HTTP cache, so after the
 * player changes their own photo we append `?v=<token>` everywhere that handle's photo is shown.
 */
export function avatarVersion(handle) {
  const key = `${PREFIX}avatar|${handle}`;
  return read(key) || '';
}

export function bumpAvatarVersion(handle) {
  cachePut(`${PREFIX}avatar|${handle}`, String(Date.now()));
}
