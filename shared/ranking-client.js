import { getDeviceId, loadInstagram, normalizeInstagram } from './player-profile.js';

const DEFAULT_TIMEOUT_MS = 8000;
const CONFIG_URL = new URL('./ranking-config.json', import.meta.url);

let cachedConfig = null;
let configPromise = null;

async function loadConfig() {
  if (cachedConfig) return cachedConfig;
  if (configPromise) return configPromise;
  configPromise = (async () => {
    try {
      const res = await fetch(CONFIG_URL.href, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`config_${res.status}`);
      cachedConfig = await res.json();
    } catch {
      cachedConfig = { apiUrl: '', games: ['dailygold'], seedPrefixes: { dailygold: 'dailyoro:' } };
    }
    return cachedConfig;
  })();
  return configPromise;
}

function apiBase(config) {
  return String(config?.apiUrl || '').trim().replace(/\/$/, '');
}

export async function rankingEnabled(gameId) {
  const config = await loadConfig();
  if (!apiBase(config)) return false;
  const games = config?.games;
  if (Array.isArray(games) && games.length) return games.includes(gameId);
  return gameId === 'dailygold';
}

export async function seedPrefixFor(gameId) {
  const config = await loadConfig();
  return config?.seedPrefixes?.[gameId] || '';
}

async function request(path, options = {}) {
  const config = await loadConfig();
  const base = apiBase(config);
  if (!base) {
    return { ok: false, disabled: true, error: 'ranking_disabled' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      ...options,
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: data?.error || `http_${res.status}`,
        data,
      };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return { ok: false, error: aborted ? 'timeout' : 'network', detail: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchRanking(gameId, playDate) {
  if (!(await rankingEnabled(gameId))) return { ok: false, disabled: true, entries: [] };
  const q = new URLSearchParams({ game: gameId, date: playDate });
  const result = await request(`/ranking?${q}`);
  if (!result.ok) return { ...result, entries: [] };
  const entries = Array.isArray(result.data?.entries) ? result.data.entries : [];
  return { ok: true, entries, data: result.data };
}

/**
 * Register / rename Instagram for this device (max 2 renames per UTC day).
 */
export async function setIdentity({ instagram, changeDate } = {}) {
  const config = await loadConfig();
  if (!apiBase(config)) return { ok: false, disabled: true, error: 'ranking_disabled' };

  const handle = normalizeInstagram(instagram ?? loadInstagram());
  if (!handle) return { ok: false, error: 'instagram_required' };

  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const day = changeDate || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const result = await request('/identity', {
    method: 'POST',
    body: JSON.stringify({
      device_id: getDeviceId(),
      instagram: handle,
      change_date: day,
    }),
  });

  if (!result.ok) {
    return {
      ...result,
      instagram: result.data?.instagram || null,
      renames_today: result.data?.renames_today ?? null,
      renames_left: result.data?.renames_left ?? null,
    };
  }
  return {
    ok: true,
    instagram: result.data?.instagram || handle,
    renames_today: result.data?.renames_today ?? 0,
    renames_left: result.data?.renames_left ?? 0,
    changed: Boolean(result.data?.changed),
    data: result.data,
  };
}

/**
 * Submit a win. Soft-fails if API is down — never throws for network.
 */
export async function submitWin({ gameId, playDate, seed, instagram }) {
  if (!(await rankingEnabled(gameId))) return { ok: false, disabled: true };

  const handle = normalizeInstagram(instagram ?? loadInstagram());
  if (!handle) return { ok: false, error: 'instagram_required' };

  const deviceId = getDeviceId();
  const body = {
    game_id: gameId,
    play_date: playDate,
    seed: String(seed >>> 0),
    instagram: handle,
    device_id: deviceId,
  };

  const result = await request('/win', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!result.ok) return result;
  return {
    ok: true,
    data: result.data,
    entries: Array.isArray(result.data?.entries) ? result.data.entries : [],
    rank: result.data?.rank ?? null,
  };
}

export {
  loadInstagram,
  saveInstagram,
  clearInstagram,
  loadInstagramDeclined,
  setInstagramDeclined,
  formatInstagram,
  normalizeInstagram,
  getDeviceId,
} from './player-profile.js';
