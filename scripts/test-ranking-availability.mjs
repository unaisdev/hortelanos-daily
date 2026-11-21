import assert from 'node:assert/strict';
import { test } from 'node:test';

let moduleId = 0;
const date = '2026-11-21';
const win = { playDate: date, seed: 12345, instagram: 'test.local' };

function fixture(t, initialHealth) {
  const calls = [];
  const values = new Map();
  let health = initialHealth;
  let now = 1000;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    else delete globalThis.sessionStorage;
  });
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const { pathname, search } = new URL(input);
    if (pathname.endsWith('/ranking-config.json')) {
      return Response.json({ apiUrl: 'https://ranking.test', games: ['dailygold', 'dailysteven'] });
    }
    calls.push({ pathname, search, method: options.method ?? 'GET' });
    if (pathname === '/health') return health(options);
    return Response.json({ ok: true, entries: [] });
  });
  return {
    calls,
    advance: () => { now += 60_001; },
    changeHealth: (next) => { health = next; },
    load: () => import(new URL('../shared/ranking-client.js?test=' + (++moduleId), import.meta.url)),
  };
}

const goldOnly = () => Response.json({ ok: true, games: ['dailygold'] });
const bothGames = () => Response.json({ ok: true, games: ['dailygold', 'dailysteven'] });

test('Gold keeps its original availability and Steven never reads or posts to a Gold-only Worker', async (t) => {
  const mock = fixture(t, goldOnly);
  const client = await mock.load();
  assert.equal((await client.fetchRanking('dailygold', date)).ok, true);
  assert.equal((await client.submitWin({ ...win, gameId: 'dailygold' })).ok, true);
  assert.deepEqual(mock.calls.map(({ pathname }) => pathname), ['/ranking', '/win']);
  assert.equal(await client.rankingEnabled('dailyred'), false);
  const checks = await Promise.all([
    client.rankingEnabled('dailysteven'),
    client.fetchRanking('dailysteven', date),
    client.submitWin({ ...win, gameId: 'dailysteven' }),
  ]);
  assert.equal(checks[0], false);
  assert.equal(checks[1].disabled, true);
  assert.equal(checks[2].disabled, true);
  assert.deepEqual(mock.calls.map(({ pathname }) => pathname), ['/ranking', '/win', '/health']);
});

test('the session cache is reused after navigation and expires so Steven can activate automatically', async (t) => {
  const mock = fixture(t, goldOnly);
  assert.equal(await (await mock.load()).rankingEnabled('dailysteven'), false);
  mock.changeHealth(bothGames);
  const nextPage = await mock.load();
  assert.equal(await nextPage.rankingEnabled('dailysteven'), false);
  assert.equal(mock.calls.length, 1);
  mock.advance();
  assert.equal(await nextPage.rankingEnabled('dailysteven'), true);
  assert.equal((await nextPage.fetchRanking('dailysteven', date)).ok, true);
  assert.equal((await nextPage.submitWin({ ...win, gameId: 'dailysteven' })).ok, true);
  assert.deepEqual(mock.calls.map(({ pathname }) => pathname), ['/health', '/health', '/ranking', '/win']);
  assert.match(mock.calls[2].search, /game=dailysteven/);
});

test('an unconfirmed or unavailable health response disables only Steven', async (t) => {
  const mock = fixture(t, () => Response.json({ ok: false, games: ['dailysteven'] }));
  const client = await mock.load();
  assert.equal(await client.rankingEnabled('dailysteven'), false);
  mock.advance();
  mock.changeHealth(() => { throw new TypeError('offline'); });
  assert.equal(await client.rankingEnabled('dailysteven'), false);
  mock.advance();
  mock.changeHealth(({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  assert.equal(await client.rankingEnabled('dailysteven'), false);
  assert.equal(await client.rankingEnabled('dailygold'), true);
  assert.deepEqual(mock.calls.map(({ pathname }) => pathname), ['/health', '/health', '/health']);
});
