import assert from 'node:assert/strict';
import { test } from 'node:test';

// --- browser globals the shared modules rely on -------------------------------------------------
function fakeStorage() {
  const data = new Map();
  return {
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
  };
}
const session = fakeStorage();
Object.defineProperty(globalThis, 'sessionStorage', { value: session, configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage(), configurable: true });

// --- fake Worker: counts network calls per path -------------------------------------------------
const calls = [];
const GAMES = ['dailygold', 'dailysteven'];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith('ranking-config.json')) {
    return Response.json({ apiUrl: 'https://api.test', games: GAMES, seedPrefixes: {} });
  }
  calls.push(`${init.method || 'GET'} ${url.pathname}${url.search}`);
  if (url.pathname === '/health') return Response.json({ ok: true, games: GAMES });
  if (url.pathname === '/ranking') {
    const game = url.searchParams.get('game');
    return Response.json({ entries: [{ rank: 1, instagram: `today.${game}` }] });
  }
  if (url.pathname === '/ranking/all') {
    const game = url.searchParams.get('game') || '*';
    return Response.json({ entries: [{ rank: 1, instagram: `all.${game}`, wins: 3 }] });
  }
  if (url.pathname.startsWith('/player/')) {
    return Response.json({ instagram: url.pathname.split('/')[2], wins: 1, history: [] });
  }
  if (url.pathname === '/win') {
    return Response.json({ ok: true, rank: 1, entries: [{ rank: 1, instagram: 'me.player' }] }, { status: 201 });
  }
  if (url.pathname === '/identity') {
    return Response.json({ ok: true, instagram: JSON.parse(init.body).instagram, changed: true, created: false });
  }
  if (url.pathname === '/avatar') return Response.json({ ok: true });
  return Response.json({ error: 'not_found' }, { status: 404 });
};
const network = (prefix) => calls.filter((c) => c.includes(prefix)).length;

// ONE module instance: the client imports './ranking-cache.js' itself, so the test must use that
// same instance. A page navigation is simulated with dropMemoryMirror() (sessionStorage stays).
const cache = await import('../shared/ranking-cache.js');
const client = await import('../shared/ranking-client.js');
async function loadClient() {
  return { cache, client };
}

test('cached(): one load per key, in-flight dedupe, errors are never cached', async () => {
  const { cache } = await loadClient();
  cache.resetRankingCache();
  let loads = 0;
  const key = cache.cacheKey('today', 'dailygold', '2026-11-24');
  const [a, b] = await Promise.all([
    cache.cached(key, async () => { loads += 1; return { ok: true, v: 1 }; }),
    cache.cached(key, async () => { loads += 1; return { ok: true, v: 2 }; }),
  ]);
  assert.equal(loads, 1, 'two simultaneous requests share one load');
  assert.deepEqual(a, b);
  await cache.cached(key, async () => { loads += 1; return { ok: true, v: 3 }; });
  assert.equal(loads, 1, 'later reads hit the cache');

  let attempts = 0;
  const failing = cache.cacheKey('all', 'dailygold');
  await cache.cached(failing, async () => { attempts += 1; return { ok: false, error: 'network' }; });
  await cache.cached(failing, async () => { attempts += 1; return { ok: true }; });
  assert.equal(attempts, 2, 'a failed load is retried, not cached');
});

test('invalidateRanking(game) only drops that ROM; avatar versions survive', async () => {
  const { cache } = await loadClient();
  cache.resetRankingCache();
  const gold = cache.cacheKey('all', 'dailygold');
  const steven = cache.cacheKey('all', 'dailysteven');
  cache.cachePut(gold, { ok: true });
  cache.cachePut(steven, { ok: true });
  cache.bumpAvatarVersion('me.player');
  cache.invalidateRanking('dailygold');
  assert.equal(cache.cachePeek(gold), undefined);
  assert.deepEqual(cache.cachePeek(steven), { ok: true });
  assert.ok(cache.avatarVersion('me.player'));
  cache.invalidateRanking();
  assert.equal(cache.cachePeek(steven), undefined);
  assert.ok(cache.avatarVersion('me.player'), 'photo version is not a ranking list');
});

test('a load that started before an invalidation does not write stale data', async () => {
  const { cache } = await loadClient();
  cache.resetRankingCache();
  const key = cache.cacheKey('today', 'dailygold', '2026-11-24');
  let release;
  const slow = cache.cached(key, () => new Promise((resolve) => { release = () => resolve({ ok: true, stale: true }); }));
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the load actually start
  cache.invalidateRanking('dailygold'); // e.g. I just won while the old request was in flight
  release();
  await slow;
  assert.equal(cache.cachePeek(key), undefined);
});

test('lists are cached per ROM and fetched with that ROM only', async () => {
  const { cache, client } = await loadClient();
  cache.resetRankingCache();
  calls.length = 0;

  await client.fetchRanking('dailygold', '2026-11-24');
  await client.fetchRanking('dailygold', '2026-11-24');
  assert.equal(network('/ranking?game=dailygold'), 1, 'second read of the same ROM/day is free');

  const steven = await client.fetchRanking('dailysteven', '2026-11-24');
  assert.equal(steven.entries[0].instagram, 'today.dailysteven');
  assert.equal(network('/ranking?game=dailysteven'), 1, 'each ROM has its own list');

  const goldAll = await client.fetchAllTimeRanking('dailygold');
  const stevenAll = await client.fetchAllTimeRanking('dailysteven');
  assert.equal(goldAll.entries[0].instagram, 'all.dailygold');
  assert.equal(stevenAll.entries[0].instagram, 'all.dailysteven');
  await client.fetchAllTimeRanking('dailygold');
  assert.equal(network('/ranking/all'), 2, 'all-time board: one request per ROM, then cached');

  await client.fetchPlayer('Some.Body', 'dailygold');
  await client.fetchPlayer('@some.body', 'dailygold');
  await client.fetchPlayer('some.body', 'dailysteven');
  assert.equal(network('/player/'), 2, 'profile cached per ROM and handle (normalized)');
  assert.ok(calls.some((c) => c.includes('/player/some.body?game=dailygold')));
});

test('the cache survives a page navigation (shell → runner → shell) but not an app close', async () => {
  const { cache, client } = await loadClient();
  cache.resetRankingCache();
  calls.length = 0;
  await client.fetchRanking('dailygold', '2026-11-24');
  await client.fetchAllTimeRanking('dailygold');
  const before = calls.length;

  cache.dropMemoryMirror(); // navigating to the runner and back: memory is gone, sessionStorage stays
  await client.fetchRanking('dailygold', '2026-11-24');
  await client.fetchAllTimeRanking('dailygold');
  assert.equal(calls.length, before, 'no requests after a page navigation');

  cache.dropMemoryMirror();
  session.clear(); // closing the app wipes sessionStorage
  await client.fetchRanking('dailygold', '2026-11-24');
  assert.equal(calls.length, before + 1, 'a new app session starts cold');
});

test('winning invalidates only that ROM, and seeds today\'s board with the fresh list', async () => {
  const { cache, client } = await loadClient();
  cache.resetRankingCache();
  await client.fetchRanking('dailygold', '2026-11-24');
  await client.fetchAllTimeRanking('dailygold');
  await client.fetchPlayer('me.player', 'dailygold');
  await client.fetchAllTimeRanking('dailysteven');
  calls.length = 0;

  const win = await client.submitWin({ gameId: 'dailygold', playDate: '2026-11-24', seed: 1, instagram: 'me.player' });
  assert.equal(win.ok, true);

  const today = await client.fetchRanking('dailygold', '2026-11-24');
  assert.equal(today.entries[0].instagram, 'me.player', "today's board comes straight from the win response");
  assert.equal(network('/ranking?game=dailygold'), 0, 'no extra request for the board that was seeded');

  await client.fetchAllTimeRanking('dailygold');
  await client.fetchPlayer('me.player', 'dailygold');
  assert.equal(network('/ranking/all'), 1, 'my ROM\'s all-time board is refetched');
  assert.equal(network('/player/'), 1, 'my profile is refetched');

  await client.fetchAllTimeRanking('dailysteven');
  assert.equal(network('/ranking/all'), 1, "the other ROM's cache is untouched");
});

test('renaming invalidates every cached list; changing the photo bumps the avatar URL', async () => {
  const { cache, client } = await loadClient();
  cache.resetRankingCache();
  await client.fetchAllTimeRanking('dailygold');
  await client.fetchAllTimeRanking('dailysteven');
  calls.length = 0;

  const renamed = await client.setIdentity({ instagram: 'new.name' });
  assert.equal(renamed.ok, true);
  await client.fetchAllTimeRanking('dailygold');
  await client.fetchAllTimeRanking('dailysteven');
  assert.equal(network('/ranking/all'), 2, 'both ROMs refetched after a rename');

  const { saveInstagram } = await import('../shared/player-profile.js');
  saveInstagram('new.name');
  const before = await client.avatarUrl('new.name');
  assert.ok(!before.includes('?v='));
  await client.uploadAvatar('data:image/jpeg;base64,AAAA');
  const after = await client.avatarUrl('new.name');
  assert.match(after, /\/avatar\/new\.name\?v=\d+/);
  assert.ok(!(await client.avatarUrl('someone.else')).includes('?v='), 'only my photo is versioned');
});

test('only errors that need a human carry the Instagram contact link', () => {
  const { identityErrorNeedsContact, identityErrorMessage, SUPPORT_DM_URL, SUPPORT_HANDLE } = client;
  assert.equal(SUPPORT_DM_URL, 'https://ig.me/m/elhortelanoo');
  assert.equal(SUPPORT_HANDLE, 'elhortelanoo');
  for (const error of ['handle_released', 'instagram_taken']) {
    assert.equal(identityErrorNeedsContact(error), true, error);
    assert.match(identityErrorMessage(error), /constancia/, `${error} explains why to write`);
  }
  for (const error of ['rename_limit', 'invalid_instagram', 'rate_limited', 'network', 'timeout', 'invalid_image', undefined]) {
    assert.equal(identityErrorNeedsContact(error), false, String(error));
  }
});
