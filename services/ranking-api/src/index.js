/**
 * Hortelanos Daily ranking API (Cloudflare Worker + D1).
 * Designed for Workers Free: hard caps, fail closed — never auto-upgrade to paid.
 *
 * Honest limit: clients report wins; we validate shape/seed/rate, not ROM proof.
 */

import { ALLOWED_GAMES, expectedSeed } from './seed.js';
import { computeStreaks } from './streaks.js';

const MAX_BODY_BYTES = 2048;
const MAX_ENTRIES = 100;
const MAX_WINS_PER_DAY = 5000;
/** Renames allowed per UTC day after the first handle set (initial set is free). */
const MAX_RENAMES_PER_DAY = 2;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HANDLE_RE = /^[a-z0-9._]{1,30}$/;
const DEVICE_RE = /^[A-Za-z0-9._:-]{8,64}$/;
const GAME_RE = /^[a-z0-9_-]{1,32}$/;

/** Soft rate limit per isolate (best-effort on Free; enough to blunt spam). */
const rateBuckets = new Map();
const RATE = {
  postPerIp: { limit: 10, windowMs: 60_000 },
  getPerIp: { limit: 60, windowMs: 60_000 },
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 && !extraHeaders['cache-control']
        ? 'public, max-age=30'
        : 'no-store',
      ...extraHeaders,
    },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowList = String(env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let allowOrigin = '*';
  if (!(allowList.length === 1 && allowList[0] === '*')) {
    allowOrigin = allowList.includes(origin) ? origin : allowList[0] || 'null';
  } else if (origin) {
    allowOrigin = origin;
  }
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, accept',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request, env))) {
    headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, headers });
}

function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

function rateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (now > v.resetAt) rateBuckets.delete(k);
    }
  }
  return bucket.count <= limit;
}

function normalizeInstagram(raw) {
  if (raw == null) return null;
  let value = String(raw).trim();
  if (value.startsWith('@')) value = value.slice(1);
  value = value.trim().toLowerCase();
  if (!HANDLE_RE.test(value)) return null;
  return value;
}

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

function addUtcDays(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isAllowedPlayDate(playDate) {
  if (!DATE_RE.test(playDate)) return false;
  const today = utcToday();
  // Accept today and yesterday (timezone skew) — reject future and older history spam.
  const yesterday = addUtcDays(today, -1);
  const tomorrow = addUtcDays(today, 1);
  return playDate === today || playDate === yesterday || playDate === tomorrow;
}

function newId() {
  return crypto.randomUUID();
}

async function listEntries(db, gameId, playDate) {
  const { results } = await db
    .prepare(
      `SELECT instagram, won_at, alive_count, turns
       FROM daily_wins
       WHERE game_id = ?1 AND play_date = ?2
       ORDER BY won_at ASC
       LIMIT ?3`,
    )
    .bind(gameId, playDate, MAX_ENTRIES)
    .all();
  return (results || []).map((row, index) => ({
    rank: index + 1,
    instagram: row.instagram,
    display: `@${row.instagram}`,
    won_at: row.won_at,
    alive_count: row.alive_count ?? null,
    turns: row.turns ?? null,
  }));
}

async function handleRanking(request, env) {
  const ip = clientIp(request);
  if (!rateLimit(`get:${ip}`, RATE.getPerIp)) {
    return json({ error: 'rate_limited' }, 429, { 'cache-control': 'no-store' });
  }

  const url = new URL(request.url);
  const gameId = (url.searchParams.get('game') || '').trim();
  const playDate = (url.searchParams.get('date') || '').trim();

  if (!GAME_RE.test(gameId) || !ALLOWED_GAMES.includes(gameId)) {
    return json({ error: 'invalid_game' }, 400, { 'cache-control': 'no-store' });
  }
  if (!DATE_RE.test(playDate)) {
    return json({ error: 'invalid_date' }, 400, { 'cache-control': 'no-store' });
  }
  // Read allows any past date (archive UX later); still block far-future.
  if (playDate > addUtcDays(utcToday(), 1)) {
    return json({ error: 'invalid_date' }, 400, { 'cache-control': 'no-store' });
  }

  try {
    const entries = await listEntries(env.DB, gameId, playDate);
    return json(
      { game_id: gameId, play_date: playDate, entries, count: entries.length },
      200,
      { 'cache-control': 'public, max-age=30' },
    );
  } catch (err) {
    console.error('ranking_get_failed', err);
    return json({ error: 'db_unavailable' }, 503, { 'cache-control': 'no-store' });
  }
}

async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) return { error: 'body_too_large' };
  const text = await request.text();
  if (text.length > maxBytes) return { error: 'body_too_large' };
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { error: 'invalid_json' };
  }
}

/** HTTP status for a failed claimIdentity result. */
const IDENTITY_ERROR_STATUS = {
  rename_limit: 429,
  instagram_taken: 409,
  handle_released: 409,
};

function identityErrorResponse(result) {
  return json(
    {
      error: result.error,
      renames_today: result.renames_today,
      renames_left: result.renames_left,
      instagram: result.instagram,
    },
    IDENTITY_ERROR_STATUS[result.error] || 400,
    { 'cache-control': 'no-store' },
  );
}

/**
 * Bind / rename Instagram for a device.
 * The first handle is free; after that, up to MAX_RENAMES_PER_DAY renames per UTC day.
 * `day` is always the SERVER's UTC day (never client-supplied), so the limit can't be dodged.
 *
 * Rules:
 *  - a handle held by another device is `instagram_taken`;
 *  - a handle someone abandoned is burned in `released_handles` → `handle_released`
 *    (also for its previous owner) until an admin releases it;
 *  - a real rename moves every past win to the new handle and burns the old one,
 *    all in a single atomic batch.
 * @returns {{ ok: true, instagram, renames_today, renames_left, changed: boolean, created: boolean }
 *   | { ok: false, error: string, renames_today?: number, renames_left?: number, instagram?: string }}
 */
async function claimIdentity(db, { deviceId, instagram, day }) {
  const nowIso = new Date().toISOString();
  const row = await db
    .prepare(
      `SELECT instagram, change_date, renames_today FROM device_identities WHERE device_id = ?1`,
    )
    .bind(deviceId)
    .first();

  if (!row || row.instagram !== instagram) {
    const burned = await db
      .prepare(`SELECT 1 AS x FROM released_handles WHERE instagram = ?1`)
      .bind(instagram)
      .first();
    if (burned) {
      return { ok: false, error: 'handle_released', instagram: row?.instagram };
    }
    // Held by another device — also covers legacy wins made before identities existed.
    const heldByOther = await db
      .prepare(
        `SELECT 1 AS x FROM device_identities WHERE instagram = ?1 AND device_id != ?2
         UNION ALL
         SELECT 1 AS x FROM daily_wins WHERE instagram = ?1 AND device_id != ?2
         LIMIT 1`,
      )
      .bind(instagram, deviceId)
      .first();
    if (heldByOther) {
      return { ok: false, error: 'instagram_taken', instagram: row?.instagram };
    }
  }

  if (!row) {
    await db
      .prepare(
        `INSERT INTO device_identities (device_id, instagram, change_date, renames_today, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4)`,
      )
      .bind(deviceId, instagram, day, nowIso)
      .run();
    return {
      ok: true,
      instagram,
      renames_today: 0,
      renames_left: MAX_RENAMES_PER_DAY,
      changed: true,
      created: true,
    };
  }

  if (row.instagram === instagram) {
    const renamesToday = row.change_date === day ? Number(row.renames_today) || 0 : 0;
    return {
      ok: true,
      instagram,
      renames_today: renamesToday,
      renames_left: Math.max(0, MAX_RENAMES_PER_DAY - renamesToday),
      changed: false,
      created: false,
    };
  }

  let renamesToday = row.change_date === day ? Number(row.renames_today) || 0 : 0;
  if (renamesToday >= MAX_RENAMES_PER_DAY) {
    return {
      ok: false,
      error: 'rename_limit',
      renames_today: renamesToday,
      renames_left: 0,
      instagram: row.instagram,
    };
  }

  renamesToday += 1;
  await db.batch([
    // Past wins follow the player to the new handle (ranking reflects the rename).
    db.prepare(`UPDATE daily_wins SET instagram = ?1 WHERE device_id = ?2`).bind(instagram, deviceId),
    // Burn the abandoned handle for everyone.
    db
      .prepare(
        `INSERT OR IGNORE INTO released_handles (instagram, released_by_device, released_at)
         VALUES (?1, ?2, ?3)`,
      )
      .bind(row.instagram, deviceId, nowIso),
    db
      .prepare(
        `UPDATE device_identities
         SET instagram = ?1, change_date = ?2, renames_today = ?3, updated_at = ?4
         WHERE device_id = ?5`,
      )
      .bind(instagram, day, renamesToday, nowIso, deviceId),
  ]);

  return {
    ok: true,
    instagram,
    renames_today: renamesToday,
    renames_left: Math.max(0, MAX_RENAMES_PER_DAY - renamesToday),
    changed: true,
    created: false,
  };
}

async function handleIdentity(request, env) {
  const ip = clientIp(request);
  if (!rateLimit(`post:${ip}`, RATE.postPerIp)) {
    return json({ error: 'rate_limited' }, 429, { 'cache-control': 'no-store' });
  }

  const parsed = await readJsonBody(request);
  if (parsed.error) {
    return json({ error: parsed.error }, 400, { 'cache-control': 'no-store' });
  }
  const body = parsed.data || {};
  const deviceId = String(body.device_id || '').trim();
  const instagram = normalizeInstagram(body.instagram);
  // Server day only: a client-supplied change_date used to let people reset the rename limit.
  const day = utcToday();

  if (!DEVICE_RE.test(deviceId)) {
    return json({ error: 'invalid_device' }, 400, { 'cache-control': 'no-store' });
  }
  if (!instagram) {
    return json({ error: 'invalid_instagram' }, 400, { 'cache-control': 'no-store' });
  }

  try {
    const result = await claimIdentity(env.DB, { deviceId, instagram, day });
    if (!result.ok) return identityErrorResponse(result);
    return json(
      {
        ok: true,
        instagram: result.instagram,
        renames_today: result.renames_today,
        renames_left: result.renames_left,
        changed: result.changed,
        created: result.created,
      },
      result.created ? 201 : 200,
      { 'cache-control': 'no-store' },
    );
  } catch (err) {
    // Two devices racing for the same handle: the unique index picks the winner.
    if (/UNIQUE|constraint/i.test(String(err?.message || err))) {
      return json({ error: 'instagram_taken' }, 409, { 'cache-control': 'no-store' });
    }
    console.error('identity_failed', err);
    return json({ error: 'db_unavailable' }, 503, { 'cache-control': 'no-store' });
  }
}

async function handleWin(request, env) {
  const ip = clientIp(request);
  if (!rateLimit(`post:${ip}`, RATE.postPerIp)) {
    return json({ error: 'rate_limited' }, 429, { 'cache-control': 'no-store' });
  }

  // Optional shared secret (set later with wrangler secret). Empty = open community mode.
  const secret = env.SUBMIT_SECRET;
  if (secret) {
    const got = request.headers.get('x-hortelano-submit') || '';
    if (got !== secret) {
      return json({ error: 'unauthorized' }, 401, { 'cache-control': 'no-store' });
    }
  }

  const parsed = await readJsonBody(request);
  if (parsed.error) {
    return json({ error: parsed.error }, 400, { 'cache-control': 'no-store' });
  }
  const body = parsed.data || {};

  const gameId = String(body.game_id || '').trim();
  const playDate = String(body.play_date || '').trim();
  const seed = String(body.seed ?? '').trim();
  const deviceId = String(body.device_id || '').trim();
  const instagram = normalizeInstagram(body.instagram);

  if (!GAME_RE.test(gameId) || !ALLOWED_GAMES.includes(gameId)) {
    return json({ error: 'invalid_game' }, 400, { 'cache-control': 'no-store' });
  }
  if (!isAllowedPlayDate(playDate)) {
    return json({ error: 'invalid_date' }, 400, { 'cache-control': 'no-store' });
  }
  if (!instagram) {
    return json({ error: 'invalid_instagram' }, 400, { 'cache-control': 'no-store' });
  }
  if (!DEVICE_RE.test(deviceId)) {
    return json({ error: 'invalid_device' }, 400, { 'cache-control': 'no-store' });
  }

  const expect = expectedSeed(gameId, playDate);
  if (!expect || seed !== expect) {
    return json({ error: 'seed_mismatch' }, 400, { 'cache-control': 'no-store' });
  }

  try {
    const existingDevice = await env.DB.prepare(
      `SELECT id, instagram FROM daily_wins
       WHERE game_id = ?1 AND play_date = ?2 AND device_id = ?3`,
    )
      .bind(gameId, playDate, deviceId)
      .first();

    if (existingDevice) {
      // Idempotent: same device already submitted — return board, do not rewrite metrics.
      const entries = await listEntries(env.DB, gameId, playDate);
      const rank = entries.findIndex((e) => e.instagram === existingDevice.instagram) + 1;
      return json(
        {
          ok: true,
          already: true,
          rank: rank || null,
          entries,
          count: entries.length,
        },
        200,
        { 'cache-control': 'no-store' },
      );
    }

    const identity = await claimIdentity(env.DB, {
      deviceId,
      instagram,
      day: utcToday(),
    });
    if (!identity.ok) return identityErrorResponse(identity);

    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM daily_wins WHERE game_id = ?1 AND play_date = ?2`,
    )
      .bind(gameId, playDate)
      .first();
    const dayCount = Number(countRow?.n || 0);

    if (dayCount >= MAX_WINS_PER_DAY) {
      return json({ error: 'day_full' }, 503, { 'cache-control': 'no-store' });
    }

    const existingIg = await env.DB.prepare(
      `SELECT device_id FROM daily_wins
       WHERE game_id = ?1 AND play_date = ?2 AND instagram = ?3`,
    )
      .bind(gameId, playDate, instagram)
      .first();

    if (existingIg && existingIg.device_id !== deviceId) {
      return json({ error: 'instagram_taken' }, 409, { 'cache-control': 'no-store' });
    }

    const wonAt = new Date().toISOString();
    const id = newId();

    await env.DB.prepare(
      `INSERT INTO daily_wins
        (id, game_id, play_date, seed, instagram, device_id, won_at, alive_count, turns)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL)`,
    )
      .bind(id, gameId, playDate, seed, instagram, deviceId, wonAt)
      .run();

    const entries = await listEntries(env.DB, gameId, playDate);
    const rank = entries.findIndex((e) => e.instagram === instagram) + 1;
    return json(
      { ok: true, already: false, rank: rank || null, entries, count: entries.length },
      201,
      { 'cache-control': 'no-store' },
    );
  } catch (err) {
    const msg = String(err?.message || err);
    // Unique constraint race
    if (msg.includes('UNIQUE') || msg.includes('constraint')) {
      return json({ error: 'conflict' }, 409, { 'cache-control': 'no-store' });
    }
    console.error('ranking_post_failed', err);
    return json({ error: 'db_unavailable' }, 503, { 'cache-control': 'no-store' });
  }
}

/** Optional `?game=` filter; empty = all ROMs. Returns undefined when invalid. */
function parseGameFilter(url) {
  const gameId = (url.searchParams.get('game') || '').trim();
  if (!gameId) return null;
  if (!GAME_RE.test(gameId) || !ALLOWED_GAMES.includes(gameId)) return undefined;
  return gameId;
}

/** Per-ROM streaks → overall best/current (max across ROMs) + per-game detail. */
function streaksByGame(rows, today) {
  const byGame = new Map();
  for (const r of rows) {
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, []);
    byGame.get(r.game_id).push(r.play_date);
  }
  let current = 0;
  let best = 0;
  const perGame = {};
  for (const [gameId, dates] of byGame) {
    const s = computeStreaks(dates, today);
    perGame[gameId] = s;
    current = Math.max(current, s.current);
    best = Math.max(best, s.best);
  }
  return { current, best, perGame };
}

/** All-time ranking: most wins first (ties: who won first), summed across ROMs. */
async function handleRankingAll(request, env) {
  const ip = clientIp(request);
  if (!rateLimit(`get:${ip}`, RATE.getPerIp)) {
    return json({ error: 'rate_limited' }, 429, { 'cache-control': 'no-store' });
  }
  const gameId = parseGameFilter(new URL(request.url));
  if (gameId === undefined) {
    return json({ error: 'invalid_game' }, 400, { 'cache-control': 'no-store' });
  }

  try {
    const top = `SELECT instagram, COUNT(*) AS wins, MIN(won_at) AS first_win
                 FROM daily_wins WHERE (?1 IS NULL OR game_id = ?1)
                 GROUP BY instagram ORDER BY wins DESC, first_win ASC LIMIT ?2`;
    const { results: ranked } = await env.DB.prepare(top).bind(gameId, MAX_ENTRIES).all();
    const { results: wins } = await env.DB.prepare(
      `SELECT instagram, game_id, play_date FROM daily_wins
       WHERE (?1 IS NULL OR game_id = ?1)
         AND instagram IN (SELECT instagram FROM (${top}))`,
    )
      .bind(gameId, MAX_ENTRIES)
      .all();

    const byPlayer = new Map();
    for (const w of wins || []) {
      if (!byPlayer.has(w.instagram)) byPlayer.set(w.instagram, []);
      byPlayer.get(w.instagram).push(w);
    }
    const today = utcToday();
    const entries = (ranked || []).map((row, index) => ({
      rank: index + 1,
      instagram: row.instagram,
      display: `@${row.instagram}`,
      wins: row.wins,
      current_streak: streaksByGame(byPlayer.get(row.instagram) || [], today).current,
    }));
    return json({ game_id: gameId, entries, count: entries.length }, 200, {
      'cache-control': 'public, max-age=60',
    });
  } catch (err) {
    console.error('ranking_all_failed', err);
    return json({ error: 'db_unavailable' }, 503, { 'cache-control': 'no-store' });
  }
}

/** Player card: totals, rank, streaks and the full win history (newest first). */
async function handlePlayer(request, env, rawHandle) {
  const ip = clientIp(request);
  if (!rateLimit(`get:${ip}`, RATE.getPerIp)) {
    return json({ error: 'rate_limited' }, 429, { 'cache-control': 'no-store' });
  }
  const handle = normalizeInstagram(decodeURIComponent(rawHandle || ''));
  if (!handle) return json({ error: 'invalid_instagram' }, 400, { 'cache-control': 'no-store' });
  const gameId = parseGameFilter(new URL(request.url));
  if (gameId === undefined) {
    return json({ error: 'invalid_game' }, 400, { 'cache-control': 'no-store' });
  }

  try {
    const { results } = await env.DB.prepare(
      `SELECT game_id, play_date, won_at FROM daily_wins
       WHERE instagram = ?1 AND (?2 IS NULL OR game_id = ?2)
       ORDER BY play_date DESC, game_id ASC LIMIT 1000`,
    )
      .bind(handle, gameId)
      .all();
    const rows = results || [];
    if (rows.length === 0) {
      return json({ error: 'player_not_found' }, 404, { 'cache-control': 'no-store' });
    }

    const today = utcToday();
    const streaks = streaksByGame(rows, today);
    // Mark the win right after a broken streak so the UI can show "racha rota: <día>".
    const brokenOn = new Map();
    for (const [g, s] of Object.entries(streaks.perGame)) {
      for (const b of s.breaks) brokenOn.set(`${g}|${b.after}`, b.broken_on);
    }
    const history = rows.map((r) => ({
      game_id: r.game_id,
      play_date: r.play_date,
      won_at: r.won_at,
      broken_on: brokenOn.get(`${r.game_id}|${r.play_date}`) || null,
    }));

    const mine = await env.DB.prepare(
      `SELECT COUNT(*) AS wins, MIN(won_at) AS first_win FROM daily_wins
       WHERE instagram = ?1 AND (?2 IS NULL OR game_id = ?2)`,
    )
      .bind(handle, gameId)
      .first();
    const above = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT COUNT(*) AS w, MIN(won_at) AS m FROM daily_wins
         WHERE (?1 IS NULL OR game_id = ?1) GROUP BY instagram
       ) WHERE w > ?2 OR (w = ?2 AND m < ?3)`,
    )
      .bind(gameId, mine.wins, mine.first_win)
      .first();

    return json(
      {
        instagram: handle,
        display: `@${handle}`,
        rank: Number(above?.n || 0) + 1,
        wins: mine.wins,
        current_streak: streaks.current,
        best_streak: streaks.best,
        history,
      },
      200,
      { 'cache-control': 'public, max-age=30' },
    );
  } catch (err) {
    console.error('player_failed', err);
    return json({ error: 'db_unavailable' }, 503, { 'cache-control': 'no-store' });
  }
}

/** Avatars are tiny (the client shrinks them to 128x128 JPEG); hard caps keep D1 rows small. */
const AVATAR_MAX_BYTES = 16 * 1024;
const AVATAR_BODY_MAX = 24 * 1024;
const AVATAR_DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/;

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Magic-byte check so a "jpeg" data URL can't smuggle arbitrary bytes. */
function looksLikeImage(type, bytes) {
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (type === 'image/webp') {
    const tag = String.fromCharCode(...bytes.slice(0, 4)) + String.fromCharCode(...bytes.slice(8, 12));
    return tag === 'RIFFWEBP';
  }
  return false;
}

/** Only the device that owns an identity can set (and replace) the photo of its @. */
async function handleAvatarUpload(request, env) {
  const ip = clientIp(request);
  if (!rateLimit(`post:${ip}`, RATE.postPerIp)) {
    return json({ error: 'rate_limited' }, 429, { 'cache-control': 'no-store' });
  }
  const parsed = await readJsonBody(request, AVATAR_BODY_MAX);
  if (parsed.error) return json({ error: parsed.error }, 400, { 'cache-control': 'no-store' });

  const deviceId = String(parsed.data?.device_id || '').trim();
  if (!DEVICE_RE.test(deviceId)) {
    return json({ error: 'invalid_device' }, 400, { 'cache-control': 'no-store' });
  }
  const match = AVATAR_DATA_URL_RE.exec(String(parsed.data?.image || ''));
  if (!match) return json({ error: 'invalid_image' }, 400, { 'cache-control': 'no-store' });
  const [, contentType, b64] = match;

  let bytes;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    return json({ error: 'invalid_image' }, 400, { 'cache-control': 'no-store' });
  }
  if (bytes.length > AVATAR_MAX_BYTES) {
    return json({ error: 'image_too_large' }, 413, { 'cache-control': 'no-store' });
  }
  if (!looksLikeImage(contentType, bytes)) {
    return json({ error: 'invalid_image' }, 400, { 'cache-control': 'no-store' });
  }

  try {
    const owner = await env.DB.prepare(`SELECT instagram FROM device_identities WHERE device_id = ?1`)
      .bind(deviceId)
      .first();
    if (!owner) return json({ error: 'identity_required' }, 409, { 'cache-control': 'no-store' });

    await env.DB.prepare(
      `INSERT INTO device_avatars (device_id, content_type, image, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(device_id) DO UPDATE SET
         content_type = excluded.content_type, image = excluded.image, updated_at = excluded.updated_at`,
    )
      .bind(deviceId, contentType, b64, new Date().toISOString())
      .run();
    return json({ ok: true, instagram: owner.instagram }, 200, { 'cache-control': 'no-store' });
  } catch (err) {
    console.error('avatar_upload_failed', err);
    return json({ error: 'db_unavailable' }, 503, { 'cache-control': 'no-store' });
  }
}

/** Serves the photo of the device that currently owns `<handle>`; 404 → the UI draws an initial. */
async function handleAvatar(request, env, rawHandle) {
  const ip = clientIp(request);
  if (!rateLimit(`get:${ip}`, RATE.getPerIp)) {
    return json({ error: 'rate_limited' }, 429, { 'cache-control': 'no-store' });
  }
  let handle;
  try {
    handle = normalizeInstagram(decodeURIComponent(rawHandle || ''));
  } catch {
    handle = null;
  }
  if (!handle) return json({ error: 'invalid_instagram' }, 400, { 'cache-control': 'no-store' });

  try {
    const row = await env.DB.prepare(
      `SELECT a.content_type, a.image FROM device_identities i
       JOIN device_avatars a ON a.device_id = i.device_id
       WHERE i.instagram = ?1`,
    )
      .bind(handle)
      .first();
    if (!row) return json({ error: 'no_avatar' }, 404, { 'cache-control': 'public, max-age=60' });
    return new Response(base64ToBytes(row.image), {
      status: 200,
      headers: { 'content-type': row.content_type, 'cache-control': 'public, max-age=300' },
    });
  } catch (err) {
    console.error('avatar_failed', err);
    return json({ error: 'no_avatar' }, 404, { 'cache-control': 'no-store' });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), request, env);
    }

    const url = new URL(request.url);
    let response;

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        response = json({ ok: true, plan: 'free', games: ALLOWED_GAMES });
      } else if (request.method === 'GET' && url.pathname === '/ranking') {
        response = await handleRanking(request, env);
      } else if (request.method === 'GET' && url.pathname === '/ranking/all') {
        response = await handleRankingAll(request, env);
      } else if (request.method === 'GET' && url.pathname.startsWith('/player/')) {
        response = await handlePlayer(request, env, url.pathname.slice('/player/'.length));
      } else if (request.method === 'POST' && url.pathname === '/avatar') {
        response = await handleAvatarUpload(request, env);
      } else if (request.method === 'GET' && url.pathname.startsWith('/avatar/')) {
        response = await handleAvatar(request, env, url.pathname.slice('/avatar/'.length));
      } else if (request.method === 'POST' && url.pathname === '/identity') {
        response = await handleIdentity(request, env);
      } else if (request.method === 'POST' && url.pathname === '/win') {
        response = await handleWin(request, env);
      } else {
        response = json({ error: 'not_found' }, 404, { 'cache-control': 'no-store' });
      }
    } catch (err) {
      console.error('unhandled', err);
      response = json({ error: 'internal' }, 500, { 'cache-control': 'no-store' });
    }

    return withCors(response, request, env);
  },
};
