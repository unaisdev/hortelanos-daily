/**
 * Hortelanos Daily ranking API (Cloudflare Worker + D1).
 * Designed for Workers Free: hard caps, fail closed — never auto-upgrade to paid.
 *
 * Honest limit: clients report wins; we validate shape/seed/rate, not ROM proof.
 */

import { ALLOWED_GAMES, expectedSeed } from './seed.js';

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

async function readJsonBody(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) return { error: 'body_too_large' };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: 'body_too_large' };
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { error: 'invalid_json' };
  }
}

/**
 * Bind / rename Instagram for a device.
 * First set of the day is free; up to MAX_RENAMES_PER_DAY renames per UTC day.
 * @returns {{ ok: true, instagram, renames_today, renames_left, changed: boolean } | { ok: false, error: string }}
 */
async function claimIdentity(db, { deviceId, instagram, day }) {
  const nowIso = new Date().toISOString();
  const row = await db
    .prepare(
      `SELECT instagram, change_date, renames_today FROM device_identities WHERE device_id = ?1`,
    )
    .bind(deviceId)
    .first();

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
  await db
    .prepare(
      `UPDATE device_identities
       SET instagram = ?1, change_date = ?2, renames_today = ?3, updated_at = ?4
       WHERE device_id = ?5`,
    )
    .bind(instagram, day, renamesToday, nowIso, deviceId)
    .run();

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
  const day = String(body.change_date || utcToday()).trim();

  if (!DEVICE_RE.test(deviceId)) {
    return json({ error: 'invalid_device' }, 400, { 'cache-control': 'no-store' });
  }
  if (!instagram) {
    return json({ error: 'invalid_instagram' }, 400, { 'cache-control': 'no-store' });
  }
  if (!isAllowedPlayDate(day)) {
    return json({ error: 'invalid_date' }, 400, { 'cache-control': 'no-store' });
  }

  try {
    const result = await claimIdentity(env.DB, { deviceId, instagram, day });
    if (!result.ok) {
      return json(
        {
          error: result.error,
          renames_today: result.renames_today,
          renames_left: result.renames_left,
          instagram: result.instagram,
        },
        429,
        { 'cache-control': 'no-store' },
      );
    }
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
      day: playDate,
    });
    if (!identity.ok) {
      return json(
        {
          error: identity.error,
          renames_today: identity.renames_today,
          renames_left: identity.renames_left,
          instagram: identity.instagram,
        },
        429,
        { 'cache-control': 'no-store' },
      );
    }

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
