/** Thin bridge to Tauri IPC when running inside the desktop shell. */

function getInvoke() {
  const g = typeof window !== 'undefined' ? window : undefined;
  if (!g) return null;
  if (g.__TAURI__?.core?.invoke) return g.__TAURI__.core.invoke.bind(g.__TAURI__.core);
  if (g.__TAURI_INTERNALS__?.invoke) return g.__TAURI_INTERNALS__.invoke.bind(g.__TAURI_INTERNALS__);
  return null;
}

export function isDesktop() {
  return Boolean(getInvoke()) || Boolean(window.__HORTELANO_DESKTOP__);
}

/** Wait briefly for Tauri global injection on localhost webviews. */
export async function whenDesktopReady(timeoutMs = 800) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getInvoke()) {
      window.__HORTELANO_DESKTOP__ = true;
      return true;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return Boolean(getInvoke());
}

export function errorText(err) {
  if (err == null) return 'error desconocido';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    if (typeof err.message === 'string' && err.message) return err.message;
    if (typeof err.error === 'string' && err.error) return err.error;
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function invoke(cmd, args = {}, timeoutMs = 2500) {
  const inv = getInvoke();
  if (!inv) throw new Error('No está corriendo en Hortelano desktop');
  try {
    return await withTimeout(inv(cmd, args), timeoutMs, cmd);
  } catch (err) {
    throw new Error(errorText(err));
  }
}

export async function getDesktopInfo() {
  return invoke('get_desktop_info', {}, 1500);
}

export async function listInstalledPacks() {
  return invoke('list_installed_packs', {}, 1500);
}

export async function checkLauncherUpdate() {
  return invoke('check_launcher_update', {}, 8000);
}

export async function checkContentUpdates() {
  return invoke('check_content_updates', {}, 8000);
}

export async function installContentPack(gameId, downloadUrl, expectedSha256 = null) {
  return invoke('install_content_pack', {
    gameId,
    downloadUrl,
    expectedSha256,
  }, 120000);
}

export async function openExternalUrl(url) {
  return invoke('open_external_url', { url }, 3000);
}
