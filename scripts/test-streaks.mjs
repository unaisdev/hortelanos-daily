import assert from 'node:assert/strict';
import { addDays, computeStreaks } from '../services/ranking-api/src/streaks.js';

// No wins
assert.deepEqual(computeStreaks([], '2026-11-24'), { current: 0, best: 0, breaks: [] });

// Single win today
assert.deepEqual(computeStreaks(['2026-11-24'], '2026-11-24'), { current: 1, best: 1, breaks: [] });

// Consecutive run ending today, unordered input + duplicates ignored
let s = computeStreaks(['2026-11-24', '2026-11-22', '2026-11-23', '2026-11-23'], '2026-11-24');
assert.equal(s.current, 3);
assert.equal(s.best, 3);
assert.equal(s.breaks.length, 0);

// Streak is still alive if today hasn't been played yet (last win yesterday)...
s = computeStreaks(['2026-11-22', '2026-11-23'], '2026-11-24');
assert.equal(s.current, 2);

// ...but dead once a whole day was missed
s = computeStreaks(['2026-11-21', '2026-11-22'], '2026-11-24');
assert.equal(s.current, 0);
assert.equal(s.best, 2);

// Gap: the mockup case (22, 20, 19) → broken on the 21st; best run is the older one
s = computeStreaks(['2026-11-19', '2026-11-20', '2026-11-22', '2026-11-23', '2026-11-24'], '2026-11-24');
assert.equal(s.current, 3);
assert.equal(s.best, 3);
assert.deepEqual(s.breaks, [{ after: '2026-11-20', broken_on: '2026-11-21', next_win: '2026-11-22' }]);

// Older run longer than the current one
s = computeStreaks(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-24'], '2026-11-24');
assert.equal(s.best, 4);
assert.equal(s.current, 1);

// Month / year boundaries
assert.equal(addDays('2026-12-31', 1), '2027-01-01');
assert.equal(addDays('2028-02-28', 1), '2028-02-29');
s = computeStreaks(['2026-12-30', '2026-12-31', '2027-01-01'], '2027-01-01');
assert.equal(s.current, 3);

console.log('streaks ok');
