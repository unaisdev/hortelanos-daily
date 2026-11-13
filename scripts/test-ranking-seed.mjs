import { dailySeedFor } from '../shared/daily-seed.js';
import { expectedSeed, dailySeedFor as workerSeed } from '../services/ranking-api/src/seed.js';

const date = '2026-11-13';
const prefix = 'dailyoro:';
const a = dailySeedFor(prefix, date);
const b = workerSeed(prefix, date);
const c = expectedSeed('dailygold', date);

if (a !== b) {
  console.error('shared vs worker seed mismatch', a, b);
  process.exit(1);
}
if (String(a >>> 0) !== c) {
  console.error('expectedSeed mismatch', a, c);
  process.exit(1);
}
console.log('ranking seed ok', c);
