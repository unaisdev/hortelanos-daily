const bootLog = document.getElementById('boot-log');
const bootSection = document.getElementById('boot');
const menuSection = document.getElementById('menu');
const gameList = document.getElementById('game-list');
const menuStatus = document.getElementById('menu-status');
const shell = document.getElementById('shell');

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
let selected = 0;
let booting = true;
let bootTimer = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runBoot() {
  bootLog.textContent = '';
  for (const line of LINES) {
    if (!booting) break;
    bootLog.textContent += `${line}\n`;
    await sleep(line ? 180 : 80);
  }
  if (!booting) return;
  try {
    const catalog = await loadCatalog();
    bootLog.textContent += `Found ${catalog.games.length} daily cartridge(s)\n`;
    await sleep(250);
    bootLog.textContent += 'Press START\n';
    await sleep(400);
  } catch (err) {
    bootLog.textContent += `ERROR: ${err.message}\n`;
    menuStatus.textContent = err.message;
  }
  showMenu();
}

async function loadCatalog() {
  const res = await fetch('../catalog/catalog.json');
  if (!res.ok) throw new Error(`No se pudo leer el catálogo (HTTP ${res.status}).`);
  const catalog = await res.json();
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
      reason = err.message || 'pack inválido';
    }
    enriched.push({ ...entry, manifest, playable, reason });
  }
  return { ...catalog, games: enriched };
}

function showMenu() {
  booting = false;
  clearTimeout(bootTimer);
  bootSection.hidden = true;
  menuSection.hidden = false;
  shell.dataset.screen = 'menu';
  renderList();
}

function renderList() {
  gameList.innerHTML = '';
  games.forEach((game, index) => {
    const li = document.createElement('li');
    li.className = `game-item${game.playable ? '' : ' is-disabled'}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(index === selected));
    li.tabIndex = -1;
    li.innerHTML = `
      <span class="cursor" aria-hidden="true">${index === selected ? '>' : ' '}</span>
      <p class="name">${game.name}</p>
      <p class="blurb">${game.blurb}</p>
      <p class="meta">protocol ${game.protocolId} · content ${game.contentVersion}${game.playable ? '' : ` · ${game.reason}`}</p>
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
    menuStatus.textContent = `${game.name}: ${game.reason}. Ver docs/PROTOCOL.md y Releases del repo fuente.`;
    return;
  }
  menuStatus.textContent = '';
  try {
    sessionStorage.setItem('hortelano:selected-game', game.id);
  } catch { /* */ }
  location.href = `../runner/?game=${encodeURIComponent(game.id)}`;
}

function onKey(event) {
  if (booting && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    showMenu();
    return;
  }
  if (shell.dataset.screen !== 'menu') return;
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
  }
}

bootSection.addEventListener('click', () => {
  if (booting) showMenu();
});

window.addEventListener('keydown', onKey);

loadCatalog()
  .then((catalog) => {
    games = catalog.games;
    if (!games.length) throw new Error('El catálogo no tiene juegos.');
    return runBoot();
  })
  .catch((err) => {
    bootLog.textContent += `\nFATAL: ${err.message}\n`;
    menuStatus.textContent = err.message;
    showMenu();
  });
