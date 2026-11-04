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
const updateBtn = document.getElementById('update-btn');
const menuHelp = document.getElementById('menu-help');
const helpFab = document.getElementById('help-fab');
const helpModal = document.getElementById('help-modal');
const helpModalClose = document.getElementById('help-modal-close');
const bootHint = document.querySelector('.boot-hint');
const displayName = document.getElementById('display-name');
const displayBoss = document.getElementById('display-boss');
const displayBlurb = document.getElementById('display-blurb');
const displayMeta = document.getElementById('display-meta');

const LINES = [
  'HORTELANO BIOS v0.1',
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
        reason = 'sin content pack / ROM';
      } else {
        const romRes = await fetch(`../${entry.packPath}/${manifest.rom.path}`, { method: 'HEAD' });
        playable = romRes.ok;
        if (!playable) reason = 'ROM no encontrada';
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
    refreshUpdates().catch((err) => {
      if (updateBar) {
        updateBar.hidden = false;
        updateBar.textContent = `Updates no disponibles (${errorText(err)})`;
      }
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

function renderDisplay() {
  const game = games[selected];
  if (!game || !displayName) return;
  const spr = spriteFor(game);
  const upd = contentUpdates.find((u) => u.gameId === game.id && u.updateAvailable);
  const updLabel = upd ? ` · update ${upd.remoteVersion || '?'}` : '';
  displayName.textContent = game.name;
  displayBoss.textContent = `VS ${game.boss || spr.mascot || '?'}`;
  displayBlurb.textContent = game.blurb || '';
  displayMeta.textContent = game.playable
    ? `protocol ${game.protocolId} · content ${game.contentVersion}${updLabel}`
    : `${game.reason || 'No disponible'}${updLabel}`;
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
    li.innerHTML = `
      <span class="cursor" aria-hidden="true">${isSel ? '<img class="cursor-ball" src="assets/sprites/poke-ball.png?v=3" width="28" height="28" alt="">' : ''}</span>
      <div class="sprite-wrap">
        <img class="sprite" src="${src}" data-static="${srcStatic}" alt="">
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
      menuStatus.textContent = `${game.name}: sin ROM local. Pulsa U para descargar el content pack.`;
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

async function refreshUpdates() {
  if (!updateBar) return;
  updateBar.hidden = false;
  updateBar.textContent = 'Buscando updates en GitHub…';
  if (updateBtn) updateBtn.hidden = true;

  const [launcher, contents] = await Promise.all([
    checkLauncherUpdate(),
    checkContentUpdates(),
  ]);
  launcherUpdate = launcher;
  contentUpdates = contents;
  renderList();

  const pendingContent = contents.filter((c) => c.updateAvailable && c.downloadUrl);
  const bits = [];
  if (launcher.updateAvailable) {
    bits.push(`launcher ${launcher.currentVersion} → ${launcher.latestVersion}`);
  }
  for (const c of pendingContent) {
    bits.push(`${c.gameId} ${c.localVersion} → ${c.remoteVersion}`);
  }

  if (!bits.length) {
    updateBar.textContent = `Desktop v${desktopInfo?.launcherVersion || '?'} · packs al día`;
    if (updateBtn) updateBtn.hidden = true;
    return;
  }

  updateBar.textContent = `Update: ${bits.join(' · ')}`;
  if (updateBtn) {
    updateBtn.hidden = false;
    updateBtn.textContent = pendingContent.length
      ? 'Descargar packs (U)'
      : 'Abrir releases launcher (U)';
  }
}

async function applyUpdates() {
  if (!isDesktop()) return;
  menuStatus.textContent = '';
  const pending = contentUpdates.filter((c) => c.updateAvailable && c.downloadUrl);
  if (!pending.length) {
    if (launcherUpdate?.htmlUrl) {
      try {
        await openExternalUrl(launcherUpdate.htmlUrl);
      } catch {
        window.open(launcherUpdate.htmlUrl, '_blank', 'noopener');
      }
      menuStatus.textContent = 'Abre el Release del launcher y descarga el build de tu SO (unsigned).';
    } else {
      menuStatus.textContent = 'No hay packs descargables ahora mismo.';
    }
    return;
  }

  updateBar.textContent = 'Descargando content packs…';
  if (updateBtn) updateBtn.disabled = true;
  try {
    for (const item of pending) {
      updateBar.textContent = `Descargando ${item.gameId}…`;
      await installContentPack(item.gameId, item.downloadUrl, item.sha256 || null);
    }
    const base = await loadCatalogFromFetch();
    const catalog = await enrichFromDesktop(base);
    games = catalog.games;
    catalogReady = true;
    await refreshUpdates();
    menuStatus.textContent = 'Packs actualizados.';
  } catch (err) {
    menuStatus.textContent = errorText(err);
    updateBar.textContent = 'Fallo al actualizar packs';
  } finally {
    if (updateBtn) updateBtn.disabled = false;
  }
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
