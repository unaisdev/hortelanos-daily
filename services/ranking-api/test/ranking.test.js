import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { dailySeedFor } from '../../../shared/daily-seed.js';
import worker from '../src/index.js';

/** Runs the real Worker against in-memory SQLite (same queries as D1). */
function createHarness() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_init.sql', '0002_identities.sql', '0003_profiles.sql', '0004_avatars.sql']) {
    sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const DB = {
    // D1 batches are atomic; mirror that with a transaction.
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    prepare(sql) {
      // D1 uses numbered params (?1, ?2, a number may repeat); SQLite's driver here is positional,
      // so expand the arguments in order of appearance.
      const order = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]) - 1);
      const statement = sqlite.prepare(sql.replace(/\?\d+/g, '?'));
      return {
        bind(...args) {
          const positional = order.map((i) => args[i]);
          return {
            first: () => statement.get(...positional),
            all: () => ({ results: statement.all(...positional) }),
            run: () => statement.run(...positional),
          };
        },
      };
    },
  };
  let ip = 0;
  const call = async (pathname, body) => {
    // A fresh IP per call: these tests are about rules, not about the soft rate limiter.
    ip += 1;
    const response = await worker.fetch(new Request('https://ranking.test' + pathname, {
      method: body ? 'POST' : 'GET',
      body: body ? JSON.stringify(body) : undefined,
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': `192.0.2.${ip % 250}` },
    }), { DB });
    return [response.status, await response.json()];
  };
  // Raw response (for binary endpoints like /avatar/<handle>).
  const raw = (pathname) => worker.fetch(new Request('https://ranking.test' + pathname, {
    headers: { 'cf-connecting-ip': '198.51.100.7' },
  }), { DB });
  // Seed rows the API can't create (wins on past days).
  const exec = (sql) => sqlite.exec(sql);
  return { call, raw, exec, close: () => sqlite.close() };
}

test('Steven and Gold have separate boards with the existing submission rules', async () => {
  const { call, close } = createHarness();
  try {
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
    close();
  }
});

test('renaming moves past wins, burns the old @ and is limited to 2 per day', async () => {
  const { call, close } = createHarness();
  try {
    const date = new Date().toISOString().slice(0, 10);
    const device = 'device-owner-01';
    const gold = { game_id: 'dailygold', play_date: date, seed: dailySeedFor('dailyoro:', date), device_id: device };

    assert.equal((await call('/identity', { device_id: device, instagram: 'first.name' }))[0], 201);
    assert.equal((await call('/win', { ...gold, instagram: 'first.name' }))[0], 201);

    // Rename #1: the win follows the player and the board shows the new @.
    const [renamed, r1] = await call('/identity', { device_id: device, instagram: 'second.name' });
    assert.equal(renamed, 200);
    assert.equal(r1.renames_left, 1);
    const [, all] = await call('/ranking/all');
    assert.deepEqual(all.entries.map((e) => [e.instagram, e.wins]), [['second.name', 1]]);
    const [, daily] = await call('/ranking?game=dailygold&date=' + date);
    assert.deepEqual(daily.entries.map((e) => e.instagram), ['second.name']);
    assert.equal((await call('/player/first.name'))[0], 404);
    const [, player] = await call('/player/second.name');
    assert.equal(player.wins, 1);
    assert.equal(player.history[0].play_date, date);

    // The abandoned @ is burned for EVERYONE, including its previous owner.
    assert.deepEqual((await call('/identity', { device_id: 'device-other-01', instagram: 'first.name' }))[1].error, 'handle_released');
    // Rename #2 works, #3 hits the daily limit; a client-sent date can't reset it.
    assert.equal((await call('/identity', { device_id: device, instagram: 'third.name' }))[0], 200);
    const [limited, body] = await call('/identity', { device_id: device, instagram: 'fourth.name', change_date: '2001-01-01' });
    assert.equal(limited, 429);
    assert.equal(body.error, 'rename_limit');
    const [, again] = await call('/identity', { device_id: device, instagram: 'first.name' });
    assert.ok(['handle_released', 'rename_limit'].includes(again.error));

    // Another device can't take an active @.
    assert.equal((await call('/identity', { device_id: 'device-other-02', instagram: 'third.name' }))[1].error, 'instagram_taken');
  } finally {
    close();
  }
});

test('avatars: only the @ owner uploads, only real small images, and they follow a rename', async () => {
  const { call, raw, close } = createHarness();
  try {
    // 1x1 JPEG (valid magic bytes).
    const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');
    const image = `data:image/jpeg;base64,${jpeg}`;
    assert.equal((await call('/avatar', { device_id: 'device-photo-01', image }))[1].error, 'identity_required');
    assert.equal((await call('/identity', { device_id: 'device-photo-01', instagram: 'photo.one' }))[0], 201);
    assert.equal((await call('/avatar', { device_id: 'device-photo-01', image }))[0], 200);
    assert.equal((await call('/avatar', { device_id: 'device-photo-01', image: `data:image/jpeg;base64,${Buffer.from('not a jpeg').toString('base64')}` }))[1].error, 'invalid_image');
    assert.equal((await call('/avatar', { device_id: 'device-photo-01', image: 'data:image/svg+xml;base64,PHN2Zz4=' }))[1].error, 'invalid_image');

    // The photo is stored per device, so it follows the @ after a rename.
    assert.equal((await call('/identity', { device_id: 'device-photo-01', instagram: 'photo.two' }))[0], 200);
    const served = await raw('/avatar/photo.two');
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/jpeg');
    assert.equal(Buffer.from(await served.arrayBuffer()).toString('base64'), jpeg);
    assert.equal((await raw('/avatar/photo.one')).status, 404); // burned @ has no photo
    assert.equal((await raw('/avatar/nobody.here')).status, 404);
  } finally {
    close();
  }
});

test('all-time board and profile are scoped to one ROM, with independent streaks', async () => {
  const { call, exec, close } = createHarness();
  try {
    const day = (offset) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - offset);
      return d.toISOString().slice(0, 10);
    };
    const today = day(0);
    const seeds = { dailygold: dailySeedFor('dailyoro:', today), dailysteven: dailySeedFor('dailysteven:', today) };
    const win = (game, device, instagram) =>
      call('/win', { game_id: game, play_date: today, seed: seeds[game], device_id: device, instagram });

    // Ana wins Gold and Steven today; Beto wins only Steven.
    assert.equal((await win('dailygold', 'device-ana-0001', 'ana'))[0], 201);
    assert.equal((await win('dailysteven', 'device-ana-0001', 'ana'))[0], 201);
    assert.equal((await win('dailysteven', 'device-beto-001', 'beto'))[0], 201);
    // Ana's past: Gold yesterday + the day before (3-day Gold streak), Steven two days ago (a gap).
    const past = (id, game, offset) =>
      `('${id}','${game}','${day(offset)}','x','ana','device-ana-0001','${day(offset)}T10:00:00Z')`;
    exec(`INSERT INTO daily_wins (id, game_id, play_date, seed, instagram, device_id, won_at) VALUES
      ${past('g1', 'dailygold', 1)}, ${past('g2', 'dailygold', 2)}, ${past('s1', 'dailysteven', 3)}`);

    const board = async (query) => (await call('/ranking/all' + query))[1].entries.map((e) => [e.instagram, e.wins]);
    assert.deepEqual(await board('?game=dailygold'), [['ana', 3]], 'Gold board has only Gold wins');
    assert.deepEqual((await board('?game=dailysteven')).sort(), [['ana', 2], ['beto', 1]], 'Steven board is separate');
    assert.deepEqual(await board(''), [['ana', 5], ['beto', 1]], 'no game = all ROMs summed');
    const [, goldBoard] = await call('/ranking/all?game=dailygold');
    assert.equal(goldBoard.entries[0].current_streak, 3, 'Gold streak counts Gold days only');

    const [, goldAna] = await call('/player/ana?game=dailygold');
    assert.equal(goldAna.wins, 3);
    assert.equal(goldAna.rank, 1);
    assert.equal(goldAna.current_streak, 3);
    assert.ok(goldAna.history.every((h) => h.game_id === 'dailygold'));

    const [, stevenAna] = await call('/player/ana?game=dailysteven');
    assert.equal(stevenAna.wins, 2);
    assert.equal(stevenAna.current_streak, 1, "Steven's gap breaks the streak: today only");
    assert.ok(stevenAna.history.every((h) => h.game_id === 'dailysteven'));

    assert.equal((await call('/player/beto?game=dailygold'))[0], 404, 'Beto never won Gold');
    assert.equal((await call('/ranking/all?game=dailyred'))[0], 400);
  } finally {
    close();
  }
});
