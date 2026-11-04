import {
  isDesktop,
  whenDesktopReady,
  listInstalledPacks,
  checkLauncherUpdate,
  checkContentUpdates,
  installContentPack,
  getDesktopInfo,
  openExternalUrl,
  errorText,
} from './desktop.js';

const bootLog = document.getElementById('boot-log');
const bootSection = document.getElementById('boot');
const menuSection = document.getElementById('menu');
const gameList = document.getElementById('game-list');
const menuStatus = document.getElementById('menu-status');
const shell = document.getElementById('shell');
const updateBar = document.getElementById('update-bar');
const updateStatus = document.getElementById('update-status');
const updateBtn = document.getElementById('update-btn');
const updateLauncherBtn = document.getElementById('update-launcher-btn');
const menuHelp = document.getElementById('menu-help');
const helpFab = document.getElementById('help-fab');
const helpModal = document.getElementById('help-modal');
const helpModalClose = document.getElementById('help-modal-close');
const bootHint = document.querySelector('.boot-hint');
const displayName = document.getElementById('display-name');
const displayBoss = document.getElementById('display-boss');
const displayBlurb = document.getElementById('display-blurb');
const displayMeta = document.getElementById('display-meta');
const displayRepo = document.getElementById('display-repo');

const LINES = [
  'HORTELANO BIOS v1.0',
  'Copyright (C) Fan Project — not Nintendo',
  '',
  'Memory check .......... OK',
  'WebAssembly ........... OK',
  'Cartridge bus ......... SCAN',
  'Loading catalog.json ..',
];

let games = [];
let catalogReady = false;
let selected = 0;
let booting = true;
let bootTimer = null;
let contentUpdates = [];
let launcherUpdate = null;
let desktopInfo = null;
let skipRequested = false;
let updateBusy = false;

const SKIP_BOOT_KEY = 'hortelano:skip-boot';
const SELECTED_GAME_KEY = 'hortelano:selected-game';

function shouldSkipBoot() {
  try {
    if (sessionStorage.getItem(SKIP_BOOT_KEY) === '1') return true;
  } catch { /* */ }
  const params = new URLSearchParams(location.search);
  return params.get('from') === 'game' || params.get('skipBoot') === '1';
}

function clearSkipBoot() {
  try {
    sessionStorage.removeItem(SKIP_BOOT_KEY);
  } catch { /* */ }
  const url = new URL(location.href);
  if (url.searchParams.has('from') || url.searchParams.has('skipBoot')) {
    url.searchParams.delete('from');
    url.searchParams.delete('skipBoot');
    history.replaceState({}, '', url.pathname + url.search + url.hash);
  }
}

function restoreSelectedIndex() {
  try {
    const id = sessionStorage.getItem(SELECTED_GAME_KEY);
    if (!id) return;
    const idx = games.findIndex((g) => g.id === id);
    if (idx >= 0) selected = idx;
  } catch { /* */ }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function setBootHint(text) {
  if (bootHint) bootHint.textContent = text;
}

async function runBoot() {
  bootLog.textContent = '';
  for (const line of LINES) {
    if (!booting || skipRequested) break;
    bootLog.textContent += `${line}\n`;
    await sleep(line ? 120 : 50);
  }
  if (!booting) return;
  bootLog.textContent += `Found ${games.length} daily cartridge(s)\n`;
  if (isDesktop()) {
    bootLog.textContent += `Desktop shell ...... OK (${desktopInfo?.platform || 'webview'})\n`;
  }
  if (skipRequested) {
    showMenu();
    return;
  }
  await sleep(150);
  bootLog.textContent += 'Press START\n';
  setBootHint('Pulsa Enter o haz clic para continuar');
  await sleep(250);
  showMenu();
}

async function loadCatalogFromFetch() {
  const res = await fetch('../catalog/catalog.json');
  if (!res.ok) throw new Error(`No se pudo leer el catálogo (HTTP ${res.status}).`);
  const catalog = await res.json();
  if (!Array.isArray(catalog.games) || !catalog.games.length) {
    throw new Error('El catálogo no tiene juegos.');
  }
  const enriched = [];
  for (const entry of catalog.games) {
    let manifest = null;
    let playable = false;
    let reason = '';
    try {
      const mRes = await fetch(`../${entry.packPath}/game.manifest.json`);
      if (!mRes.ok) throw new Error('manifest ausente');
      manifest = await mRes.json();
      if (manifest.status === 'awaiting-content-pack') {
        reason = 'Sin ROM local';
      } else {
        const romRes = await fetch(`../${entry.packPath}/${manifest.rom.path}`, { method: 'HEAD' });
        playable = romRes.ok;
        if (!playable) reason = 'Sin ROM local';
      }
    } catch (err) {
      reason = errorText(err) || 'pack inválido';
    }
    enriched.push({ ...entry, manifest, playable, reason });
  }
  return { ...catalog, games: enriched };
}

/** Overlay app-data pack status from Rust when IPC works; never blocks the menu. */
async function enrichFromDesktop(catalog) {
  if (!isDesktop()) return catalog;
  try {
    desktopInfo = await getDesktopInfo();
  } catch (err) {
    console.warn('get_desktop_info', err);
  }
  try {
    const packs = await listInstalledPacks();
    const byId = new Map(packs.map((p) => [p.id, p]));
    return {
      ...catalog,
      games: catalog.games.map((entry) => {
        const pack = byId.get(entry.id);
        if (!pack) return entry;
        return {
          ...entry,
          contentVersion: pack.contentVersion || entry.contentVersion,
          protocolId: pack.protocolId || entry.protocolId,
          manifest: pack.manifest || entry.manifest,
          playable: pack.playable,
          reason: pack.reason || entry.reason || '',
          source: pack.source,
        };
      }),
    };
  } catch (err) {
    console.warn('list_installed_packs', err);
    return catalog;
  }
}

function showMenu() {
  if (!catalogReady || !games.length) {
    setBootHint('Cargando cartuchos… espera un momento');
    return;
  }
  booting = false;
  skipRequested = false;
  clearTimeout(bootTimer);
  bootSection.hidden = true;
  menuSection.hidden = false;
  if (menuHelp) menuHelp.hidden = false;
  if (helpFab) helpFab.hidden = false;
  shell.dataset.screen = 'menu';
  renderList();
  if (isDesktop()) {
    syncUpdatesOnOpen().catch((err) => {
      console.warn('syncUpdatesOnOpen', err);
      setUpdateStatus('Desktop · updates no disponibles');
      if (updateBar) updateBar.hidden = false;
    });
  }
}

function requestSkip() {
  if (!catalogReady || !games.length) {
    setBootHint('Cargando cartuchos…');
    return;
  }
  skipRequested = true;
  showMenu();
}

function spriteFor(game) {
  const menu = game.menu || {};
  const animated = menu.sprite || '';
  const fallback = menu.spriteStatic || '';
  return { animated, fallback, accent: menu.accent || '#5cff8a', mascot: menu.mascot || game.boss || '' };
}

function isGithubPack(game) {
  // Only when the pack was actually installed from GitHub Releases.
  return game?.source === 'github';
}

function repoUrlFor(game) {
  const repo = game?.content?.repo;
  if (!repo || typeof repo !== 'string') return '';
  return `https://github.com/${repo}`;
}

const GITHUB_ICON_SVG =
  '<svg class="gh-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.7 7.7 0 0 1 8 4.07c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

function renderDisplay() {
  const game = games[selected];
  if (!game || !displayName) return;
  const spr = spriteFor(game);
  const upd = contentUpdates.find((u) => u.gameId === game.id && u.updateAvailable);
  const updLabel = upd ? ` · update ${upd.remoteVersion || '?'}` : '';
  const fromGh = isGithubPack(game);
  const repoUrl = repoUrlFor(game);
  displayName.textContent = game.name;
  displayBoss.textContent = `VS ${game.boss || spr.mascot || '?'}`;
  displayBlurb.textContent = game.blurb || '';
  if (game.playable) {
    displayMeta.textContent = fromGh
      ? `GitHub · content ${game.contentVersion}${updLabel}`
      : `protocol ${game.protocolId} · content ${game.contentVersion}${updLabel}`;
  } else {
    displayMeta.textContent = `${game.reason || 'No disponible'}${updLabel}`;
  }
  displayMeta.classList.toggle('from-github', fromGh);

  if (displayRepo) {
    const repoPath = game?.content?.repo ? `/${game.content.repo}` : '';
    if (repoUrl && repoPath) {
      displayRepo.hidden = false;
      displayRepo.href = repoUrl;
      displayRepo.innerHTML = `${GITHUB_ICON_SVG}<span>${repoPath}</span>`;
      displayRepo.setAttribute('aria-label', `Repo de ${game.name}: ${repoUrl}`);
    } else {
      displayRepo.hidden = true;
      displayRepo.removeAttribute('href');
      displayRepo.innerHTML = '';
    }
  }
}

function renderList() {
  if (!gameList) return;
  gameList.innerHTML = '';
  games.forEach((game, index) => {
    const li = document.createElement('li');
    const isSel = index === selected;
    li.className = `trainer-slot${game.playable ? '' : ' is-disabled'}${isSel ? ' is-selected' : ''}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(isSel));
    li.setAttribute('aria-label', game.name);
    li.tabIndex = -1;
    const spr = spriteFor(game);
    const src = spr.animated || spr.fallback;
    const srcStatic = spr.fallback || spr.animated;
    const ghBadge = isGithubPack(game)
      ? `<span class="pack-gh" title="Content pack de GitHub" aria-label="pack de GitHub">${GITHUB_ICON_SVG}</span>`
      : '';
    li.innerHTML = `
      <span class="cursor" aria-hidden="true">${isSel ? '<img class="cursor-ball" src="assets/sprites/poke-ball.png?v=3" width="28" height="28" alt="">' : ''}</span>
      <div class="sprite-wrap">
        <img class="sprite" src="${src}" data-static="${srcStatic}" alt="">
        ${ghBadge}
      </div>
      <span class="slot-label">${game.boss || spr.mascot || game.name}</span>
    `;
    const img = li.querySelector('.sprite');
    if (img) {
      img.addEventListener('error', () => {
        if (img.dataset.static && img.src !== img.dataset.static) img.src = img.dataset.static;
      });
    }
    li.addEventListener('click', () => {
      if (selected === index) {
        launchSelected();
        return;
      }
      selected = index;
      renderList();
    });
    gameList.appendChild(li);
  });
  renderDisplay();
}

function launchSelected() {
  const game = games[selected];
  if (!game) return;
  if (!game.playable) {
    const upd = contentUpdates.find((u) => u.gameId === game.id && u.downloadUrl);
    if (upd) {
      menuStatus.textContent = `${game.name}: Sin ROM local. Pulsa U para descargar el content pack.`;
      return;
    }
    menuStatus.textContent = `${game.name}: ${game.reason}. Ver docs/PROTOCOL.md y Releases del repo fuente.`;
    return;
  }
  menuStatus.textContent = '';
  try {
    sessionStorage.setItem(SELECTED_GAME_KEY, game.id);
    sessionStorage.setItem(SKIP_BOOT_KEY, '1');
  } catch { /* */ }
  location.href = `../runner/?game=${encodeURIComponent(game.id)}`;
}

function setUpdateStatus(text) {
  if (updateStatus) updateStatus.textContent = text;
  else if (updateBar) updateBar.hidden = false;
}

function pendingContentUpdates(list = contentUpdates) {
  return list.filter((c) => c.updateAvailable && c.downloadUrl);
}

function paintUpdateBar({ pendingContent = pendingContentUpdates(), autoNote = '' } = {}) {
  if (!updateBar) return;
  updateBar.hidden = false;

  const launcherReady = Boolean(launcherUpdate?.updateAvailable);
  updateBar.dataset.launcherUpdate = launcherReady ? '1' : '0';

  const bits = [];
  if (launcherReady) {
    bits.push(`launcher ${launcherUpdate.currentVersion} → ${launcherUpdate.latestVersion}`);
  }
  for (const c of pendingContent) {
    bits.push(`${c.gameId} ${c.localVersion} → ${c.remoteVersion}`);
  }

  if (autoNote) {
    setUpdateStatus(autoNote);
  } else if (!bits.length) {
    setUpdateStatus(`Desktop v${desktopInfo?.launcherVersion || launcherUpdate?.currentVersion || '?'} · packs al día`);
  } else {
    setUpdateStatus(bits.join(' · '));
  }

  if (updateBtn) {
    const showPacks = pendingContent.length > 0;
    updateBtn.hidden = !showPacks;
    updateBtn.textContent = showPacks ? `Descargar packs (U)` : 'Descargar packs';
  }
  if (updateLauncherBtn) {
    updateLauncherBtn.hidden = !launcherReady;
    if (launcherReady) {
      updateLauncherBtn.textContent = `Launcher ${launcherUpdate.latestVersion} → abrir release`;
    }
  }
}

async function refreshUpdates() {
  if (!updateBar) return;
  updateBar.hidden = false;
  setUpdateStatus('Buscando updates en GitHub…');
  if (updateBtn) updateBtn.hidden = true;
  if (updateLauncherBtn) updateLauncherBtn.hidden = true;

  const [launcher, contents] = await Promise.all([
    checkLauncherUpdate(),
    checkContentUpdates(),
  ]);
  launcherUpdate = launcher;
  contentUpdates = contents;
  renderList();
  paintUpdateBar();
  return {
    launcher,
    contents,
    pendingContent: pendingContentUpdates(contents),
  };
}

async function installPendingPacks(pending) {
  if (!pending.length) return false;
  updateBusy = true;
  if (updateBtn) updateBtn.disabled = true;
  if (updateLauncherBtn) updateLauncherBtn.disabled = true;
  try {
    for (const item of pending) {
      setUpdateStatus(`Descargando ${item.gameId} ${item.remoteVersion || ''}…`.trim());
      await installContentPack(item.gameId, item.downloadUrl, item.sha256 || null);
    }
    const base = await loadCatalogFromFetch();
    const catalog = await enrichFromDesktop(base);
    games = catalog.games;
    catalogReady = true;
    renderList();
    return true;
  } finally {
    updateBusy = false;
    if (updateBtn) updateBtn.disabled = false;
    if (updateLauncherBtn) updateLauncherBtn.disabled = false;
  }
}

/** On menu open: check Releases, auto-install content packs, keep launcher as UI notice. */
async function syncUpdatesOnOpen() {
  const { pendingContent } = await refreshUpdates();
  if (!pendingContent.length) return;

  menuStatus.textContent = 'Actualizando content packs…';
  try {
    await installPendingPacks(pendingContent);
    await refreshUpdates();
    paintUpdateBar({
      autoNote: launcherUpdate?.updateAvailable
        ? `Packs actualizados · launcher ${launcherUpdate.currentVersion} → ${launcherUpdate.latestVersion}`
        : `Packs actualizados · Desktop v${desktopInfo?.launcherVersion || '?'}`,
    });
    menuStatus.textContent = 'Packs listos para jugar.';
  } catch (err) {
    menuStatus.textContent = errorText(err);
    setUpdateStatus('Fallo al actualizar packs — pulsa U para reintentar');
    if (updateBtn) {
      updateBtn.hidden = false;
      updateBtn.textContent = 'Reintentar packs (U)';
    }
  }
}

async function applyUpdates() {
  if (!isDesktop() || updateBusy) return;
  menuStatus.textContent = '';
  let pending = pendingContentUpdates();
  if (!pending.length) {
    try {
      const refreshed = await refreshUpdates();
      pending = refreshed.pendingContent;
    } catch (err) {
      menuStatus.textContent = errorText(err);
      return;
    }
  }
  if (!pending.length) {
    menuStatus.textContent = launcherUpdate?.updateAvailable
      ? 'Packs al día. Hay launcher nuevo: usa «abrir release» arriba.'
      : 'No hay packs nuevos en Releases.';
    return;
  }

  try {
    await installPendingPacks(pending);
    await refreshUpdates();
    menuStatus.textContent = 'Packs actualizados.';
  } catch (err) {
    menuStatus.textContent = errorText(err);
    setUpdateStatus('Fallo al actualizar packs');
  }
}

async function openLauncherRelease() {
  const url = launcherUpdate?.htmlUrl;
  if (!url) return;
  try {
    await openExternalUrl(url);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
  menuStatus.textContent = 'Descarga el build de tu SO (unsigned) e instálalo / descomprime el portable.';
}

function onKey(event) {
  if (booting && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    requestSkip();
    return;
  }
  if (shell.dataset.screen !== 'menu') return;
  if (!games.length) return;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    event.preventDefault();
    selected = (selected + 1) % games.length;
    renderList();
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    event.preventDefault();
    selected = (selected - 1 + games.length) % games.length;
    renderList();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    launchSelected();
  } else if (event.key === 'Escape') {
    if (helpModal?.open) {
      event.preventDefault();
      closeHelpModal();
      return;
    }
    if (helpJustClosed) {
      event.preventDefault();
      return;
    }
    location.reload();
  } else if ((event.key === 'u' || event.key === 'U') && isDesktop()) {
    event.preventDefault();
    applyUpdates();
  }
}

bootSection.addEventListener('click', () => {
  if (booting) requestSkip();
});

if (updateBtn) {
  updateBtn.addEventListener('click', () => {
    applyUpdates();
  });
}
if (updateLauncherBtn) {
  updateLauncherBtn.addEventListener('click', () => {
    openLauncherRelease();
  });
}

if (displayRepo) {
  displayRepo.addEventListener('click', async (event) => {
    const url = displayRepo.href;
    if (!url || displayRepo.hidden) return;
    if (!isDesktop()) return;
    event.preventDefault();
    try {
      await openExternalUrl(url);
    } catch {
      window.open(url, '_blank', 'noopener');
    }
  });
}

let helpJustClosed = false;

function openHelpModal() {
  if (!helpModal) return;
  if (typeof helpModal.showModal === 'function') helpModal.showModal();
  else helpModal.setAttribute('open', '');
}

function closeHelpModal() {
  if (!helpModal) return;
  if (typeof helpModal.close === 'function') helpModal.close();
  else helpModal.removeAttribute('open');
}

if (helpFab) {
  helpFab.addEventListener('click', () => openHelpModal());
}
if (helpModalClose) {
  helpModalClose.addEventListener('click', () => closeHelpModal());
}
if (helpModal) {
  helpModal.addEventListener('click', (event) => {
    if (event.target === helpModal) closeHelpModal();
  });
  helpModal.addEventListener('close', () => {
    helpJustClosed = true;
    queue(() => {
      helpJustClosed = false;
    }, 0);
  });
}

window.addEventListener('keydown', onKey);

// Fetch catalog first (never blocked by Tauri IPC). Desktop ready / enrich is best-effort.
const skipBoot = shouldSkipBoot();
if (skipBoot) {
  setBootHint('Volviendo al menú…');
  bootLog.textContent = 'Restoring menu ..\n';
} else {
  setBootHint('Cargando cartuchos…');
  bootLog.textContent = 'Loading catalog.json ..\n';
}

loadCatalogFromFetch()
  .then(async (catalog) => {
    games = catalog.games;
    catalogReady = true;
    restoreSelectedIndex();
    whenDesktopReady(800)
      .then(() => enrichFromDesktop({ games }))
      .then((enriched) => {
        if (!enriched?.games?.length) return;
        games = enriched.games;
        restoreSelectedIndex();
        if (shell.dataset.screen === 'menu') renderList();
      })
      .catch(() => {});

    if (skipBoot) {
      clearSkipBoot();
      showMenu();
      return;
    }

    setBootHint('Pulsa Enter o haz clic para saltar');
    return runBoot();
  })
  .catch((err) => {
    const text = errorText(err);
    bootLog.textContent += `FATAL: ${text}\n`;
    setBootHint(text);
    catalogReady = false;
  });
