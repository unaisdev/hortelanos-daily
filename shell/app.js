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
const bootHint = document.querySelector('.boot-hint');

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

function renderList() {
  gameList.innerHTML = '';
  games.forEach((game, index) => {
    const li = document.createElement('li');
    li.className = `game-item${game.playable ? '' : ' is-disabled'}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(index === selected));
    li.tabIndex = -1;
    const upd = contentUpdates.find((u) => u.gameId === game.id && u.updateAvailable);
    const updLabel = upd
      ? ` · update ${upd.remoteVersion || '?'}`
      : '';
    li.innerHTML = `
      <span class="cursor" aria-hidden="true">${index === selected ? '>' : ' '}</span>
      <p class="name">${game.name}</p>
      <p class="blurb">${game.blurb}</p>
      <p class="meta">protocol ${game.protocolId} · content ${game.contentVersion}${game.playable ? '' : ` · ${game.reason}`}${updLabel}</p>
    `;
    li.addEventListener('click', () => {
      selected = index;
      renderList();
      launchSelected();
    });
    gameList.appendChild(li);
  });
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
    sessionStorage.setItem('hortelano:selected-game', game.id);
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
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    selected = (selected + 1) % games.length;
    renderList();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    selected = (selected - 1 + games.length) % games.length;
    renderList();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    launchSelected();
  } else if (event.key === 'Escape') {
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

window.addEventListener('keydown', onKey);

// Fetch catalog first (never blocked by Tauri IPC). Desktop ready / enrich is best-effort.
setBootHint('Cargando cartuchos…');
bootLog.textContent = 'Loading catalog.json ..\n';

loadCatalogFromFetch()
  .then(async (catalog) => {
    games = catalog.games;
    catalogReady = true;
    setBootHint('Pulsa Enter o haz clic para saltar');
    // Kick boot immediately; enrich IPC in parallel without blocking skip/menu.
    const bootPromise = runBoot();
    whenDesktopReady(800)
      .then(() => enrichFromDesktop({ games }))
      .then((enriched) => {
        if (!enriched?.games?.length) return;
        games = enriched.games;
        if (shell.dataset.screen === 'menu') renderList();
      })
      .catch(() => {});
    return bootPromise;
  })
  .catch((err) => {
    const text = errorText(err);
    bootLog.textContent += `FATAL: ${text}\n`;
    setBootHint(text);
    catalogReady = false;
  });
