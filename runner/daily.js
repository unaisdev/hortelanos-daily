// Stats y semilla diaria parametrizados por manifest.client.
// En desktop se espejan a disco (app_data) para no depender solo de localStorage.

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
/** @type {{ load: () => Promise<object|null>, save: (stats: object) => Promise<void> } | null} */
let diskMirror = null;

export function configureDaily({ statsKey, seedPrefix: prefix, diskMirror: mirror = null }) {
  activeKey = statsKey;
  seedPrefix = prefix;
  memoryCopy = null;
  diskMirror = mirror;
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

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return { ...EMPTY };
  return {
    ...EMPTY,
    ...raw,
    wins: Number(raw.wins) || 0,
    losses: Number(raw.losses) || 0,
    winStreak: Number(raw.winStreak) || 0,
    dayStreak: Number(raw.dayStreak) || 0,
  };
}

function battlesOf(stats) {
  return (stats?.wins || 0) + (stats?.losses || 0);
}

/** Prefer the copy with more progress (battles), then a more recent lastPlayed. */
export function pickRicherStats(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  const leftBattles = battlesOf(left);
  const rightBattles = battlesOf(right);
  if (rightBattles > leftBattles) return right;
  if (leftBattles > rightBattles) return left;
  if (right.lastPlayed && (!left.lastPlayed || right.lastPlayed > left.lastPlayed)) return right;
  if (right.pending && !left.pending) return right;
  return left;
}

export function loadStats() {
  if (!activeKey) throw new Error('configureDaily() no se ha llamado.');
  try {
    const saved = JSON.parse(localStorage.getItem(activeKey));
    return normalize(saved);
  } catch {
    return normalize(memoryCopy);
  }
}

function saveLocal(stats) {
  memoryCopy = { ...stats };
  try {
    localStorage.setItem(activeKey, JSON.stringify(stats));
  } catch {
    /* storage blocked */
  }
}

function save(stats) {
  saveLocal(stats);
  if (diskMirror) {
    diskMirror.save({ ...stats }).catch((err) => {
      console.warn('No se pudo espejar stats a disco', err);
    });
  }
}

/**
 * Merge localStorage with durable disk copy (desktop). Writes the winner to both.
 * Call once after configureDaily() on boot.
 */
export async function hydrateStatsFromDisk() {
  const local = loadStats();
  if (!diskMirror) return local;

  let disk = null;
  try {
    disk = await diskMirror.load();
  } catch (err) {
    console.warn('No se pudo leer stats de disco', err);
  }

  const chosen = pickRicherStats(local, disk);
  saveLocal(chosen);
  try {
    await diskMirror.save({ ...chosen });
  } catch (err) {
    console.warn('No se pudo escribir stats a disco', err);
  }
  return chosen;
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
