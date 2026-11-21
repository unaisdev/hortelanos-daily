import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { dailySeedFor } from '../../../shared/daily-seed.js';
import worker from '../src/index.js';

test('Steven and Gold have separate boards with the existing submission rules', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    for (const file of ['0001_init.sql', '0002_identities.sql']) {
      sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
    }
    // Both D1 and this adapter execute the actual Worker queries against SQLite.
    const DB = {
      prepare(sql) {
        const statement = sqlite.prepare(sql.replace(/\?\d+/g, '?'));
        return {
          bind(...args) {
            return {
              first: () => statement.get(...args),
              all: () => ({ results: statement.all(...args) }),
              run: () => statement.run(...args),
            };
          },
        };
      },
    };
    const call = async (pathname, body) => {
      const response = await worker.fetch(new Request('https://ranking.test' + pathname, {
        method: body ? 'POST' : 'GET',
        body: body ? JSON.stringify(body) : undefined,
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' },
      }), { DB });
      return [response.status, await response.json()];
    };
    const date = new Date().toISOString().slice(0, 10);
    const win = { play_date: date, instagram: 'test.player', device_id: 'test-device-01' };
    const gold = { ...win, game_id: 'dailygold', seed: dailySeedFor('dailyoro:', date) };
    const steven = { ...win, game_id: 'dailysteven', seed: dailySeedFor('dailysteven:', date) };
    const [, health] = await call('/health');
    assert.deepEqual(health.games.sort(), ['dailygold', 'dailysteven']);
    assert.equal((await call('/identity', { ...win, change_date: date }))[0], 201);
    assert.equal((await call('/win', gold))[0], 201);
    assert.deepEqual(await call('/win', { ...steven, seed: gold.seed }), [400, { error: 'seed_mismatch' }]);
    assert.deepEqual(await call('/win', { ...steven, play_date: '2001-01-01' }), [400, { error: 'invalid_date' }]);
    assert.deepEqual(await call('/win', { ...steven, game_id: 'dailyred' }), [400, { error: 'invalid_game' }]);
    assert.equal((await call('/win', steven))[0], 201);
    const [duplicate, response] = await call('/win', steven);
    assert.equal(duplicate, 200);
    assert.equal(response.already, true);
    assert.deepEqual(await call('/win', { ...steven, device_id: 'other-device-01' }), [409, { error: 'instagram_taken' }]);
    assert.equal((await call('/win', { ...steven, device_id: 'other-device-02', instagram: 'another.player' }))[0], 201);
    const [, goldBoard] = await call('/ranking?game=dailygold&date=' + date);
    const [, stevenBoard] = await call('/ranking?game=dailysteven&date=' + date);
    assert.deepEqual(goldBoard.entries.map(entry => entry.instagram), ['test.player']);
    assert.deepEqual(stevenBoard.entries.map(entry => entry.instagram).sort(), ['another.player', 'test.player']);
  } finally {
    sqlite.close();
  }
});
