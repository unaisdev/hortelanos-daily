import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dailySeedFor } from '../shared/daily-seed.js';
import { configureDaily, dailySeed } from '../runner/daily.js';
import { expectedSeed, dailySeedFor as workerSeed } from '../services/ranking-api/src/seed.js';

const config = JSON.parse(readFileSync(new URL('../shared/ranking-config.json', import.meta.url)));
for (const game of ['dailygold', 'dailysteven']) {
  const prefix = config.seedPrefixes[game];
  configureDaily({ statsKey: 'ranking-test', seedPrefix: prefix });
  for (const date of ['2000-02-29', '2026-11-13', '2026-12-31', '2027-01-01']) {
    const shared = dailySeedFor(prefix, date);
    assert.equal(dailySeed(date), shared);
    assert.equal(workerSeed(prefix, date), shared);
    assert.equal(expectedSeed(game, date), String(shared));
  }
  console.log('ranking seed ok', game);
}
