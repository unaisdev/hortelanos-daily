#!/usr/bin/env node
/**
 * Unit tests for runner/daily.js persistence (localStorage + disk mirror).
 * Run: node scripts/test-daily-stats.mjs
 */

import assert from 'node:assert/strict';

// Minimal localStorage for Node.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const {
  configureDaily,
  loadStats,
  hydrateStatsFromDisk,
  pickRicherStats,
  recordResult,
  markBattleStarted,
  settleAbandonedGame,
  resultFor,
  today,
} = await import('../runner/daily.js');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  store.clear();
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err?.stack || err}`);
  }
}

function memoryMirror(initial = null) {
  let disk = initial ? { ...initial } : null;
  const saves = [];
  return {
    mirror: {
      load: async () => (disk ? { ...disk } : null),
      save: async (stats) => {
        disk = { ...stats };
        saves.push({ ...stats });
      },
    },
    get disk() { return disk; },
    get saves() { return saves; },
  };
}

await test('pickRicherStats prefers more battles', () => {
  const richer = pickRicherStats(
    { wins: 1, losses: 0 },
    { wins: 2, losses: 3, lastPlayed: '2026-11-01' },
  );
  assert.equal(richer.wins, 2);
  assert.equal(richer.losses, 3);
});

await test('pickRicherStats prefers newer lastPlayed when battles tie', () => {
  const richer = pickRicherStats(
    { wins: 1, losses: 1, lastPlayed: '2026-11-01' },
    { wins: 1, losses: 1, lastPlayed: '2026-11-04' },
  );
  assert.equal(richer.lastPlayed, '2026-11-04');
});

await test('hydrate restores disk when localStorage empty', async () => {
  const bag = memoryMirror({
    wins: 7,
    losses: 2,
    winStreak: 3,
    dayStreak: 5,
    lastPlayed: '2026-11-04',
    lastResult: 'won',
    pending: null,
  });
  configureDaily({
    statsKey: 'hortelano:dailyred:stats',
    seedPrefix: 'dailyred:',
    diskMirror: bag.mirror,
  });
  assert.equal(loadStats().wins, 0);
  const hydrated = await hydrateStatsFromDisk();
  assert.equal(hydrated.wins, 7);
  assert.equal(hydrated.losses, 2);
  assert.equal(loadStats().wins, 7);
  assert.equal(bag.disk.wins, 7);
});

await test('hydrate keeps local when it has more battles than disk', async () => {
  store.set('hortelano:dailygold:stats', JSON.stringify({
    wins: 4,
    losses: 1,
    lastPlayed: '2026-11-03',
    lastResult: 'won',
  }));
  const bag = memoryMirror({ wins: 1, losses: 0 });
  configureDaily({
    statsKey: 'hortelano:dailygold:stats',
    seedPrefix: 'dailyoro:',
    diskMirror: bag.mirror,
  });
  const hydrated = await hydrateStatsFromDisk();
  assert.equal(hydrated.wins, 4);
  assert.equal(bag.disk.wins, 4, 'winner must be written back to disk');
});

await test('hydrate seeds disk from localStorage on first desktop run', async () => {
  store.set('hortelano:dailyred:stats', JSON.stringify({
    wins: 2,
    losses: 1,
    lastPlayed: '2026-11-02',
    lastResult: 'lost',
  }));
  const bag = memoryMirror(null);
  configureDaily({
    statsKey: 'hortelano:dailyred:stats',
    seedPrefix: 'dailyred:',
    diskMirror: bag.mirror,
  });
  await hydrateStatsFromDisk();
  assert.equal(bag.disk.wins, 2);
  assert.ok(bag.saves.length >= 1);
});

await test('recordResult mirrors to disk', async () => {
  const bag = memoryMirror(null);
  configureDaily({
    statsKey: 'hortelano:dailyred:stats',
    seedPrefix: 'dailyred:',
    diskMirror: bag.mirror,
  });
  const stats = loadStats();
  recordResult(stats, '2026-11-05', true);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(bag.saves.length >= 1);
  const last = bag.saves.at(-1);
  assert.equal(last.wins, 1);
  assert.equal(last.lastResult, 'won');
  assert.equal(JSON.parse(store.get('hortelano:dailyred:stats')).wins, 1);
});

await test('different ROM keys stay isolated', async () => {
  const red = memoryMirror(null);
  const gold = memoryMirror(null);

  configureDaily({
    statsKey: 'hortelano:dailyred:stats',
    seedPrefix: 'dailyred:',
    diskMirror: red.mirror,
  });
  recordResult(loadStats(), '2026-11-05', true);
  await new Promise((r) => setTimeout(r, 20));

  configureDaily({
    statsKey: 'hortelano:dailygold:stats',
    seedPrefix: 'dailyoro:',
    diskMirror: gold.mirror,
  });
  assert.equal(loadStats().wins, 0);
  const goldHydrated = await hydrateStatsFromDisk();
  assert.equal(goldHydrated.wins, 0);
  assert.equal(red.disk.wins, 1);
  assert.equal(gold.disk.wins, 0);
  assert.notEqual(red.disk.wins, gold.disk.wins);
});

await test('settleAbandonedGame records loss and mirrors', async () => {
  const bag = memoryMirror(null);
  configureDaily({
    statsKey: 'hortelano:dailyred:stats',
    seedPrefix: 'dailyred:',
    diskMirror: bag.mirror,
  });
  const stats = loadStats();
  markBattleStarted(stats, '2026-11-05');
  settleAbandonedGame(stats);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stats.losses, 1);
  assert.equal(resultFor(stats, '2026-11-05'), 'lost');
  assert.ok(bag.saves.some((s) => s.losses === 1));
});

await test('without diskMirror hydrate is a no-op over localStorage', async () => {
  store.set('hortelano:dailyred:stats', JSON.stringify({ wins: 9, losses: 0 }));
  configureDaily({
    statsKey: 'hortelano:dailyred:stats',
    seedPrefix: 'dailyred:',
  });
  const hydrated = await hydrateStatsFromDisk();
  assert.equal(hydrated.wins, 9);
});

await test('today() returns YYYY-MM-DD', () => {
  assert.match(today(new Date('2026-11-05T15:00:00')), /^2026-11-05$/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
