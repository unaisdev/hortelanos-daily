/**
 * Win-streak maths (pure, no I/O). Dates are UTC calendar days `YYYY-MM-DD`.
 * A streak is a run of consecutive calendar days with a win in the same ROM.
 */

const DAY_MS = 86_400_000;

function dayIndex(isoDate) {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS);
}

export function addDays(isoDate, days) {
  return new Date((dayIndex(isoDate) + days) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * @param {string[]} dates win days for ONE ROM (any order, duplicates ignored)
 * @param {string} today UTC day used to decide whether the current streak is alive
 * @returns {{
 *   current: number,
 *   best: number,
 *   breaks: { after: string, broken_on: string, next_win: string }[]
 * }}
 *   - current: length of the latest run, 0 if its last win is older than yesterday
 *     (a streak is still alive while today's game has not been played yet)
 *   - breaks: one entry per gap between two wins; `broken_on` is the first missed day
 */
export function computeStreaks(dates, today) {
  const sorted = [...new Set(dates)].sort();
  if (sorted.length === 0) return { current: 0, best: 0, breaks: [] };

  let best = 1;
  let run = 1;
  const breaks = [];
  for (let i = 1; i < sorted.length; i += 1) {
    if (dayIndex(sorted[i]) - dayIndex(sorted[i - 1]) === 1) {
      run += 1;
    } else {
      breaks.push({
        after: sorted[i - 1],
        broken_on: addDays(sorted[i - 1], 1),
        next_win: sorted[i],
      });
      run = 1;
    }
    if (run > best) best = run;
  }

  const last = sorted[sorted.length - 1];
  const alive = dayIndex(today) - dayIndex(last) <= 1;
  return { current: alive ? run : 0, best, breaks };
}
