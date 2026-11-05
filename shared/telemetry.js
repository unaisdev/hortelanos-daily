/**
 * Telemetría mínima del launcher (uso + ROM + errores).
 * Extensible: añade nombres en EVENTS y llama a track() desde shell/runner.
 * Contrato público: docs/TELEMETRY.md
 */
import config from './telemetry.config.js';

/** Eventos de producto versionados. Solo estos (más errores) se envían. */
export const EVENTS = Object.freeze({
  /** Shell listo (aproxima “gente que abre el launcher”). Incluye launcher_version + roms. */
  LAUNCHER_OPEN: 'launcher.open',
  /** Usuario arranca una partida en un cartucho concreto (gameId + content_version). */
  GAME_LAUNCH: 'game.launch',
});

const INSTALL_KEY = `${config.storagePrefix}install-id`;
const SESSION_OPEN_KEY = `${config.storagePrefix}session-open`;

let parsedDsn = null;
let initDone = false;
let context = {
  surface: 'unknown',
  gameId: null,
  platform: 'web',
  launcherVersion: null,
};

function debugEnabled() {
  try {
    return new URLSearchParams(location.search).has('debugTelemetry');
  } catch {
    return false;
  }
}

function log(...args) {
  if (debugEnabled()) console.info('[telemetry]', ...args);
}

function parseDsn(dsn) {
  if (!dsn || typeof dsn !== 'string') return null;
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const projectId = url.pathname.replace(/^\/+/, '').split('/')[0];
    if (!publicKey || !projectId) return null;
    const host = url.host;
    return {
      publicKey,
      projectId,
      envelopeUrl: `${url.protocol}//${host}/api/${projectId}/envelope/`,
    };
  } catch {
    return null;
  }
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch { /* */ }
}

function sessionGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch { /* */ }
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function installId() {
  let id = storageGet(INSTALL_KEY);
  if (!id) {
    id = uuid();
    storageSet(INSTALL_KEY, id);
  }
  return id;
}

function detectPlatform() {
  try {
    if (window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__HORTELANO_DESKTOP__) {
      return 'desktop';
    }
  } catch { /* */ }
  return 'web';
}

function baseTags() {
  const tags = {
    surface: context.surface,
    platform: context.platform,
  };
  if (context.gameId) tags.game_id = context.gameId;
  if (context.launcherVersion) tags.launcher_version = String(context.launcherVersion);
  return tags;
}

function baseUser() {
  return {
    id: installId(),
    // Sin PII: no email/IP explícita.
    ip_address: null,
  };
}

async function sendEnvelope(items) {
  if (!parsedDsn) return false;
  const header = {
    dsn: config.sentryDsn,
    sent_at: new Date().toISOString(),
  };
  if (config.release) header.release = config.release;
  const body = `${JSON.stringify(header)}\n${items.join('\n')}`;
  try {
    const res = await fetch(parsedDsn.envelopeUrl, {
      method: 'POST',
      body,
      keepalive: true,
      credentials: 'omit',
      mode: 'cors',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
    });
    log('envelope', res.status);
    return res.ok || res.status === 200 || res.status === 202;
  } catch (err) {
    log('send failed', err);
    return false;
  }
}

function eventItem(type, payload) {
  return `${JSON.stringify({ type })}\n${JSON.stringify(payload)}`;
}

/**
 * @param {{ surface?: string, gameId?: string|null, platform?: string, launcherVersion?: string|null }} opts
 */
export function initTelemetry(opts = {}) {
  if (opts.surface) context.surface = opts.surface;
  if (opts.gameId !== undefined) context.gameId = opts.gameId;
  if (opts.launcherVersion !== undefined) context.launcherVersion = opts.launcherVersion;
  context.platform = opts.platform || detectPlatform();

  parsedDsn = parseDsn(config.sentryDsn);
  if (initDone) return Boolean(parsedDsn);
  initDone = true;

  if (!parsedDsn) {
    log('disabled (no sentryDsn)');
    return false;
  }

  window.addEventListener('error', (event) => {
    const err = event.error instanceof Error
      ? event.error
      : new Error(event.message || 'window.error');
    captureException(err, { mechanism: 'window.onerror' });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const err = reason instanceof Error ? reason : new Error(String(reason ?? 'unhandledrejection'));
    captureException(err, { mechanism: 'unhandledrejection' });
  });

  log('ready', { surface: context.surface, platform: context.platform });
  return true;
}

export function setTelemetryContext(partial = {}) {
  context = { ...context, ...partial };
  if (partial.platform == null) context.platform = detectPlatform();
}

/**
 * Evento de producto. Solo claves listadas en EVENTS (o strings documentados en TELEMETRY.md).
 * @param {string} name
 * @param {Record<string, string|number|boolean|null|undefined>} [props]
 */
export function track(name, props = {}) {
  if (config.tracesSampleRate < 1 && Math.random() > config.tracesSampleRate) {
    log('sampled out', name);
    return;
  }
  const clean = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    // Solo primitivos; nada de objetos/ROM/blobs.
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      clean[k] = v;
    }
  }
  log('track', name, clean);

  if (!parsedDsn) return;

  const event_id = uuid().replace(/-/g, '');
  const payload = {
    event_id,
    timestamp: Date.now() / 1000,
    platform: 'javascript',
    level: 'info',
    transaction: name,
    release: config.release,
    environment: config.environment,
    tags: {
      ...baseTags(),
      event: name,
      ...(clean.gameId != null ? { game_id: String(clean.gameId) } : {}),
      ...(clean.content_version != null ? { content_version: String(clean.content_version) } : {}),
      ...(clean.launcher_version != null ? { launcher_version: String(clean.launcher_version) } : {}),
    },
    user: baseUser(),
    contexts: {
      app: {
        app_name: 'hortelanos-daily',
        app_version: clean.launcher_version || context.launcherVersion || config.release,
      },
      telemetry: {
        event: name,
        ...clean,
      },
    },
    extra: clean,
    message: name,
    fingerprint: [name, clean.gameId || context.gameId || 'none'].map(String),
  };

  void sendEnvelope([eventItem('event', payload)]);
}

/** Una vez por pestaña/sesión de shell. */
export function trackLauncherOpenOnce(props = {}) {
  if (sessionGet(SESSION_OPEN_KEY) === '1') {
    log('launcher.open already counted this session');
    return;
  }
  sessionSet(SESSION_OPEN_KEY, '1');
  track(EVENTS.LAUNCHER_OPEN, props);
}

/**
 * @param {unknown} err
 * @param {Record<string, string|number|boolean|null|undefined>} [extra]
 */
export function captureException(err, extra = {}) {
  const error = err instanceof Error ? err : new Error(String(err ?? 'unknown'));
  log('exception', error.message, extra);

  if (!parsedDsn) return;

  const event_id = uuid().replace(/-/g, '');
  const frames = (error.stack || '')
    .split('\n')
    .slice(0, 40)
    .map((line) => ({ filename: 'app', function: line.trim() }));

  const payload = {
    event_id,
    timestamp: Date.now() / 1000,
    platform: 'javascript',
    level: 'error',
    release: config.release,
    environment: config.environment,
    tags: { ...baseTags(), ...(extra.mechanism ? { mechanism: String(extra.mechanism) } : {}) },
    user: baseUser(),
    exception: {
      values: [
        {
          type: error.name || 'Error',
          value: String(error.message || error).slice(0, 500),
          stacktrace: frames.length ? { frames: frames.reverse() } : undefined,
        },
      ],
    },
    extra: {
      ...Object.fromEntries(
        Object.entries(extra).filter(([, v]) =>
          v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'),
      ),
    },
  };

  void sendEnvelope([eventItem('event', payload)]);
}

export function telemetryEnabled() {
  return Boolean(parsedDsn);
}
