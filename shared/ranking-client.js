import { getDeviceId, loadInstagram, normalizeInstagram } from './player-profile.js';
import {
  avatarVersion,
  bumpAvatarVersion,
  cacheKey,
  cachePut,
  cached,
  invalidateRanking,
} from './ranking-cache.js';

const DEFAULT_TIMEOUT_MS = 8000;
const STEVEN_HEALTH_TIMEOUT_MS = 1200;
const STEVEN_HEALTH_TTL_MS = 60_000;
const CONFIG_URL = new URL('./ranking-config.json', import.meta.url);

let cachedConfig = null;
let configPromise = null;
let stevenHealth = null;
let stevenHealthRequest = null;

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

function freshStevenHealth(entry) {
  return typeof entry?.enabled === 'boolean' && entry.expiresAt > Date.now();
}

async function stevenRankingEnabled(base) {
  const key = `hortelano:steven-ranking-health:${base}`;
  if (freshStevenHealth(stevenHealth)) return stevenHealth.enabled;
  try {
    const cached = JSON.parse(sessionStorage.getItem(key));
    if (freshStevenHealth(cached)) {
      stevenHealth = cached;
      return cached.enabled;
    }
  } catch { /* Storage is optional. */ }

  stevenHealthRequest ??= request('/health', { timeoutMs: STEVEN_HEALTH_TIMEOUT_MS, cache: 'no-store' })
    .then(({ ok, data }) => {
      const enabled = ok && data?.ok === true
        && Array.isArray(data.games) && data.games.includes('dailysteven');
      stevenHealth = { enabled, expiresAt: Date.now() + STEVEN_HEALTH_TTL_MS };
      try {
        sessionStorage.setItem(key, JSON.stringify(stevenHealth));
      } catch { /* Storage is optional. */ }
      return enabled;
    })
    .finally(() => { stevenHealthRequest = null; });
  return stevenHealthRequest;
}

export async function rankingEnabled(gameId) {
  const config = await loadConfig();
  const base = apiBase(config);
  if (!base) return false;
  const games = config?.games;
  const configured = Array.isArray(games) && games.length ? games.includes(gameId) : gameId === 'dailygold';
  if (!configured) return false;
  return gameId === 'dailysteven' ? stevenRankingEnabled(base) : true;
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
  // Cached for the whole session; only invalidated by the player's own win in this ROM.
  return cached(cacheKey('today', gameId, playDate), async () => {
    const q = new URLSearchParams({ game: gameId, date: playDate });
    const result = await request(`/ranking?${q}`);
    if (!result.ok) return { ...result, entries: [] };
    const entries = Array.isArray(result.data?.entries) ? result.data.entries : [];
    return { ok: true, entries, data: result.data };
  });
}

/** All-time ranking by number of wins (all ROMs unless `gameId` is given). */
export async function fetchAllTimeRanking(gameId = '') {
  const config = await loadConfig();
  if (!apiBase(config)) return { ok: false, disabled: true, entries: [] };
  return cached(cacheKey('all', gameId), async () => {
    const q = new URLSearchParams(gameId ? { game: gameId } : {});
    const result = await request(`/ranking/all?${q}`);
    if (!result.ok) return { ...result, entries: [] };
    const entries = Array.isArray(result.data?.entries) ? result.data.entries : [];
    return { ok: true, entries, data: result.data };
  });
}

/** Player card: wins, rank, streaks and history (newest first). */
export async function fetchPlayer(handle, gameId = '') {
  const config = await loadConfig();
  if (!apiBase(config)) return { ok: false, disabled: true, error: 'ranking_disabled' };
  const clean = normalizeInstagram(handle);
  if (!clean) return { ok: false, error: 'invalid_instagram' };
  return cached(cacheKey('player', gameId, clean), async () => {
    const q = new URLSearchParams(gameId ? { game: gameId } : {});
    const result = await request(`/player/${encodeURIComponent(clean)}?${q}`);
    if (!result.ok) return result;
    return { ok: true, player: result.data };
  });
}

/** Photo URL for a handle (served by the Worker). `bust` forces a reload after changing it. */
export async function avatarUrl(handle, bust = '') {
  const config = await loadConfig();
  const base = apiBase(config);
  const clean = normalizeInstagram(handle);
  if (!base || !clean) return '';
  // After the player changes their own photo, every view of that handle gets a fresh URL.
  const version = bust || avatarVersion(clean);
  return `${base}/avatar/${encodeURIComponent(clean)}${version ? `?v=${encodeURIComponent(version)}` : ''}`;
}

/** Uploads this device's profile photo (a small image data URL). Needs a registered @ first. */
export async function uploadAvatar(dataUrl) {
  const config = await loadConfig();
  if (!apiBase(config)) return { ok: false, disabled: true, error: 'ranking_disabled' };
  const result = await request('/avatar', {
    method: 'POST',
    body: JSON.stringify({ device_id: getDeviceId(), image: dataUrl }),
  });
  if (!result.ok) return result;
  const mine = loadInstagram();
  if (mine) bumpAvatarVersion(mine);
  return { ok: true };
}

const IDENTITY_ERRORS = {
  rename_limit: 'Solo puedes cambiar de @ 2 veces al día. Prueba mañana.',
  handle_released: 'Ese @ está bloqueado y no se puede usar. Si crees que es un error, avísanos por Instagram para que quede constancia.',
  instagram_taken: 'Ese @ ya lo usa otra persona. Si es tuyo de verdad, avísanos por Instagram para que quede constancia.',
  invalid_instagram: 'Handle inválido (letras, números, . y _).',
  rate_limited: 'Demasiados intentos; espera un minuto.',
  invalid_image: 'Esa imagen no es válida. Prueba con un JPG o PNG.',
  image_too_large: 'La imagen es demasiado grande.',
  identity_required: 'Registra primero tu @ para poder subir la foto.',
  network: 'Sin conexión con el servidor.',
  timeout: 'El servidor no respondió a tiempo.',
};

/** Who to write to when a player's @ is blocked. `ig.me/m/<user>` opens a direct message. */
export const SUPPORT_HANDLE = 'elhortelanoo';
export const SUPPORT_DM_URL = `https://ig.me/m/${SUPPORT_HANDLE}`;

/**
 * Errors where the player should get in touch: a blocked @, or an @ someone else already uses
 * (it may be the real owner being impersonated). Both need a human to look at them.
 */
export function identityErrorNeedsContact(error) {
  return error === 'handle_released' || error === 'instagram_taken';
}

/** Spanish message for a failed `setIdentity` / `submitWin` error code. */
export function identityErrorMessage(error) {
  return IDENTITY_ERRORS[error] || 'No se pudo registrar en el servidor. Reintenta.';
}

/**
 * Register / rename Instagram for this device (max 2 renames per UTC day).
 * The server decides the day; renaming moves past wins to the new @ and burns the old one.
 */
export async function setIdentity({ instagram } = {}) {
  const config = await loadConfig();
  if (!apiBase(config)) return { ok: false, disabled: true, error: 'ranking_disabled' };

  const handle = normalizeInstagram(instagram ?? loadInstagram());
  if (!handle) return { ok: false, error: 'instagram_required' };

  const result = await request('/identity', {
    method: 'POST',
    body: JSON.stringify({
      device_id: getDeviceId(),
      instagram: handle,
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
  // A real rename moves every past win to the new @: every cached list/profile is now stale.
  if (result.data?.changed && !result.data?.created) invalidateRanking();
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
  const entries = Array.isArray(result.data?.entries) ? result.data.entries : [];
  // My own win changes this ROM's boards and my profile: drop them, then seed today's board with
  // the fresh list the server just returned so the next view needs no request at all.
  invalidateRanking(gameId);
  cachePut(cacheKey('today', gameId, playDate), {
    ok: true,
    entries,
    data: { game_id: gameId, play_date: playDate, entries, count: entries.length },
  });
  return {
    ok: true,
    data: result.data,
    entries,
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
