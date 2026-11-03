// Stats y semilla diaria parametrizados por manifest.client.

const EMPTY = {
  wins: 0,
  losses: 0,
  winStreak: 0,
  dayStreak: 0,
  lastPlayed: null,
  lastResult: null,
  pending: null,
};

let memoryCopy = null;
let activeKey = null;
let seedPrefix = 'daily:';

export function configureDaily({ statsKey, seedPrefix: prefix }) {
  activeKey = statsKey;
  seedPrefix = prefix;
  memoryCopy = null;
}

export function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(date, days) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return today(d);
}

export function dailySeed(date) {
  let hash = 0x811c9dc5;
  for (const ch of `${seedPrefix}${date}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 1;
}

export function msUntilTomorrow(now = new Date()) {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight - now;
}

export function loadStats() {
  if (!activeKey) throw new Error('configureDaily() no se ha llamado.');
  try {
    const saved = JSON.parse(localStorage.getItem(activeKey));
    return { ...EMPTY, ...saved };
  } catch {
    return { ...EMPTY, ...memoryCopy };
  }
}

function save(stats) {
  memoryCopy = { ...stats };
  try {
    localStorage.setItem(activeKey, JSON.stringify(stats));
  } catch {
    /* storage blocked */
  }
}

export function resultFor(stats, date) {
  return stats.lastPlayed === date ? stats.lastResult : null;
}

export function currentStreaks(stats, date) {
  const alive = stats.lastPlayed === date || stats.lastPlayed === addDays(date, -1);
  return { winStreak: alive ? stats.winStreak : 0, dayStreak: alive ? stats.dayStreak : 0 };
}

export function markBattleStarted(stats, date) {
  if (stats.pending === date || resultFor(stats, date)) return;
  stats.pending = date;
  save(stats);
}

export function recordResult(stats, date, won) {
  if (stats.lastPlayed === date) return;
  const consecutive = stats.lastPlayed === addDays(date, -1);
  stats.dayStreak = consecutive ? stats.dayStreak + 1 : 1;
  if (won) {
    stats.wins++;
    stats.winStreak = consecutive && stats.lastResult === 'won' ? stats.winStreak + 1 : 1;
  } else {
    stats.losses++;
    stats.winStreak = 0;
  }
  stats.lastPlayed = date;
  stats.lastResult = won ? 'won' : 'lost';
  stats.pending = null;
  save(stats);
}

export function settleAbandonedGame(stats) {
  if (stats.pending && stats.pending !== stats.lastPlayed) {
    recordResult(stats, stats.pending, false);
  } else if (stats.pending) {
    stats.pending = null;
    save(stats);
  }
  return stats;
}
