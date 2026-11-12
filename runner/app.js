import { Nostalgist } from './vendor/nostalgist.js';
import { loadGameFiles } from './game-files.js';
import { getProtocolAdapter } from './protocols/index.js';
import { checkGameCompat } from './compat.js';
import {
  configureDaily, today, addDays, dailySeed, msUntilTomorrow, loadStats, hydrateStatsFromDisk,
  resultFor, currentStreaks, markBattleStarted, recordResult, settleAbandonedGame,
} from './daily.js';
import { createStatsDiskMirror } from '../shell/desktop.js';
import { previewTeamForSeed } from './team-preview.js';
import { configureArchiveParty, loadArchiveParty, peekArchiveParty } from './archive-party.js';

const $ = (id) => document.getElementById(id);
const app = document.querySelector('.app');
const screen = $('screen');
const ui = {
  play: $('play'),
  retry: $('retry'),
  sound: $('sound'),
  soundControl: document.querySelector('.sound-control'),
  volumePanel: $('volume-panel'),
  volume: $('volume'),
  volumeValue: $('volume-value'),
  fullscreen: $('fullscreen'),
  wins: $('stat-wins'),
  losses: $('stat-losses'),
  winStreak: $('stat-win-streak'),
  dayStreak: $('stat-day-streak'),
  played: $('played'),
  playedResult: $('played-result'),
  playedNext: $('played-next'),
  practiceNote: $('practice-note'),
  loadingText: $('loading-text'),
  loadingDetail: $('loading-detail'),
  meter: $('meter'),
  errorText: $('error-text'),
  gameTitle: $('game-title'),
  bossSprite: $('boss-sprite'),
  archive: $('archive'),
  archiveDate: $('archive-date'),
  archivePreview: $('archive-preview'),
  archiveFight: $('archive-fight'),
  archiveStatus: $('archive-status'),
  archiveTeam: $('archive-team'),
};

const params = new URLSearchParams(location.search);
const gameId = params.get('game') || sessionStorage.getItem('hortelano:selected-game');
if (!gameId) location.replace('../shell/?from=game');

const session = {
  get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* */ } },
};

let manifest = null;
let packBase = null;
let protocol = null;
let practiceSeed = null;
let archiveSeed = null;
let archiveIconBase = null;
let stats = null;
let emu = null;
let readGame = null;
let pollTimer = null;
let runDate = null;
let battleSeen = false;
let volume = 25;
let starting = false;
let titleDate = null;
let PHASE;
let RESULT;

const audioContexts = [];
const volumeGains = [];
const NativeAudioContext = window.AudioContext;
if (NativeAudioContext) {
  window.AudioContext = class extends NativeAudioContext {
    constructor(...args) {
      super(...args);
      audioContexts.push(this);
      const realDestination = this.destination;
      const master = this.createGain();
      master.gain.value = volume / 100;
      master.connect(realDestination);
      Object.defineProperty(this, 'destination', {
        configurable: true,
        enumerable: true,
        get: () => master,
      });
      volumeGains.push(master);
    }
  };
}

function volumeKey() {
  return manifest?.client?.volumeKey || `hortelano:${gameId}:volume`;
}

function setState(state) {
  app.dataset.state = state;
  const playing = state === 'playing';
  ui.sound.disabled = !playing;
  if (ui.volume) ui.volume.disabled = !playing;
  ui.fullscreen.disabled = !playing || !document.fullscreenEnabled;
}

function applyVolume() {
  const gain = volume / 100;
  for (const node of volumeGains) {
    try { node.gain.value = gain; } catch { /* closed */ }
  }
}

function megabytes(n) {
  return (n / 1048576).toFixed(1);
}

function checkBrowser() {
  if (typeof WebAssembly !== 'object' || typeof DecompressionStream !== 'function') {
    throw new Error('Este navegador no puede ejecutar el juego. Usa Chrome, Edge, Firefox o Safari reciente.');
  }
}

function stopEmulator() {
  clearInterval(pollTimer);
  pollTimer = null;
  readGame = null;
  if (emu) {
    try { emu.exit(); } catch (err) { console.warn('Emulator exit failed', err); }
    emu = null;
  }
  for (const ctx of audioContexts.splice(0)) ctx.close().catch(() => {});
  volumeGains.length = 0;
}

function renderTitle() {
  titleDate = today();
  const { winStreak, dayStreak } = currentStreaks(stats, titleDate);
  ui.wins.textContent = stats.wins;
  ui.losses.textContent = stats.losses;
  ui.winStreak.textContent = winStreak;
  ui.dayStreak.textContent = dayStreak;

  const boss = manifest.client.bossLabel;
  const result = practiceSeed ? null : resultFor(stats, titleDate);
  ui.play.hidden = Boolean(result);
  ui.played.hidden = !result;
  ui.practiceNote.hidden = !practiceSeed;
  if (result) {
    ui.playedResult.textContent = result === 'won'
      ? `¡Hoy has derrotado a ${boss}!`
      : `${boss} ha ganado hoy.`;
  }
  updateCountdown();
}

function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

function updateCountdown() {
  if (titleDate !== today()) {
    renderTitle();
    if (archiveEnabled()) {
      syncArchiveDateBounds();
      showArchivePreview();
    }
    return;
  }
  if (!ui.played.hidden) ui.playedNext.textContent = `Próximo combate en ${formatTime(msUntilTomorrow())}`;
}
setInterval(() => {
  if (app.dataset.state === 'title') updateCountdown();
}, 1000);

async function startRun() {
  if (starting) return;
  starting = true;
  try {
    checkBrowser();
    stopEmulator();
    setState('loading');
    ui.loadingText.textContent = 'Descargando el juego';
    ui.loadingDetail.textContent = '';
    const files = await loadGameFiles(packBase, manifest.rom.path, (loaded, total) => {
      ui.meter.style.width = total ? `${Math.min(100, (loaded / total) * 100)}%` : '50%';
      ui.loadingDetail.textContent = total
        ? `${megabytes(loaded)} of ${megabytes(total)} MB`
        : `${megabytes(loaded)} MB`;
    });

    runDate = today();
    stats = loadStats();
    if (!practiceSeed && resultFor(stats, runDate)) {
      renderTitle();
      setState('title');
      return;
    }
    const seed = practiceSeed ?? dailySeed(runDate);
    const rom = practiceSeed
      ? protocol.injectConfig(files.rom, { seed })
      : protocol.injectConfig(files.rom, {
        seed,
        wins: stats.wins,
        battles: stats.wins + stats.losses,
        daily: true,
      });

    ui.loadingText.textContent = 'Iniciando el emulador';
    ui.loadingDetail.textContent = '';
    ui.meter.style.width = '100%';

    const canvas = document.createElement('canvas');
    canvas.className = 'game-canvas';
    screen.prepend(canvas);
    emu = await Nostalgist.launch({
      core: 'mgba',
      element: canvas,
      size: { width: 720, height: 480 },
      rom: { fileName: `${manifest.id}.gba`, fileContent: new Blob([rom]) },
      resolveCoreJs: () => files.coreJs,
      resolveCoreWasm: () => files.coreWasm,
      retroarchConfig: {
        audio_mute_enable: false,
        audio_volume: 0,
        savestate_file_compression: false,
        savestate_thumbnail_enable: false,
        input_player1_a: 'x',
        input_player1_b: 'z',
        input_player1_start: 'enter',
        input_player1_select: 'rshift',
        input_player1_up: 'up',
        input_player1_down: 'down',
        input_player1_left: 'left',
        input_player1_right: 'right',
      },
    });

    readGame = protocol.createGameLink(emu, seed);
    battleSeen = false;
    pollTimer = setInterval(watchGame, 500);
    setState('playing');
    applyVolume();
    showVolume();
  } catch (err) {
    console.error(err);
    stopEmulator();
    const hint = err instanceof TypeError ? ' Comprueba tu conexión e inténtalo de nuevo.' : '';
    ui.errorText.textContent = `${err?.message || err}${hint}`;
    setState('error');
  } finally {
    starting = false;
  }
}

function watchGame() {
  let status;
  try { status = readGame?.(); } catch { return; }
  if (!status || practiceSeed) return;
  if (status.phase >= PHASE.BATTLE) {
    battleSeen = true;
    markBattleStarted(stats, runDate);
  } else if (battleSeen && status.result === RESULT.NONE) {
    recordResult(stats, runDate, false);
    endDailyGame(0);
    return;
  }
  if (status.result !== RESULT.NONE) recordResult(stats, runDate, status.result === RESULT.WON);
  if (status.phase === PHASE.FINISHED) endDailyGame(1000);
}

function endDailyGame(delayMs) {
  clearInterval(pollTimer);
  pollTimer = null;
  setTimeout(() => {
    stopEmulator();
    renderTitle();
    setState('title');
  }, delayMs);
}

function onClick(button, handler) {
  if (!button) return;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    button.blur();
    Promise.resolve()
      .then(() => handler())
      .catch((err) => {
        console.error(err);
        ui.errorText.textContent = err?.message || String(err);
        setState('error');
      });
  });
}

onClick(ui.play, startRun);
onClick(ui.retry, startRun);

function archiveEnabled() {
  return Boolean(ui.archive && !ui.archive.hidden && archiveIconBase);
}

function latestArchiveDate() {
  return addDays(today(), -1);
}

function selectedArchiveDate() {
  const value = ui.archiveDate?.value;
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  if (value > latestArchiveDate()) return null;
  return value;
}

function syncArchiveDateBounds() {
  if (!ui.archiveDate) return;
  const latest = latestArchiveDate();
  ui.archiveDate.max = latest;
  if (!ui.archiveDate.value || ui.archiveDate.value > latest) ui.archiveDate.value = latest;
}

function archiveTip(mon) {
  const tip = document.createElement('div');
  tip.className = 'archive-tip';
  tip.setAttribute('role', 'tooltip');

  const title = document.createElement('p');
  title.className = 'archive-tip-title';
  title.textContent = `${mon.name}${mon.shiny ? ' ✦' : ''}`;
  tip.appendChild(title);

  const meta = document.createElement('p');
  meta.className = 'archive-tip-meta';
  meta.textContent = `Nv. ${mon.level} · ${mon.nature} · ${mon.ability} · ${mon.heldItem}`;
  tip.appendChild(meta);

  const tipStats = document.createElement('dl');
  tipStats.className = 'archive-tip-stats';
  mon.statLabels.forEach((label, i) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = String(mon.stats[i]);
    tipStats.append(dt, dd);
  });
  tip.appendChild(tipStats);

  const moves = document.createElement('ol');
  moves.className = 'archive-tip-moves';
  for (const move of mon.moves) {
    const li = document.createElement('li');
    li.textContent = `${move.name} (${move.pp} PP)`;
    moves.appendChild(li);
  }
  tip.appendChild(moves);

  const ivs = document.createElement('p');
  ivs.className = 'archive-tip-ivs';
  ivs.textContent = `IV ${mon.ivs.join('/')} · EV ${mon.evs.join('/')}`;
  tip.appendChild(ivs);
  return tip;
}

function renderArchiveTeam(party) {
  const legendaryIds = new Set(
    previewTeamForSeed(archiveSeed).filter((m) => m.legendary).map((m) => m.id),
  );
  ui.archiveTeam.hidden = false;
  ui.archiveTeam.replaceChildren(...party.map((mon) => {
    const li = document.createElement('li');
    li.className = 'archive-mon';
    li.tabIndex = 0;
    if (legendaryIds.has(mon.species)) li.classList.add('is-legendary');
    if (mon.shiny) li.classList.add('is-shiny');

    const img = document.createElement('img');
    img.className = 'archive-mon-sprite';
    img.src = new URL(`icons/${mon.species}.png`, archiveIconBase).href;
    img.width = 64;
    img.height = 64;
    img.alt = mon.name;
    img.loading = 'lazy';
    img.decoding = 'async';

    const name = document.createElement('span');
    name.className = 'archive-mon-name';
    name.textContent = mon.name;

    li.append(img, name, archiveTip(mon));
    if (legendaryIds.has(mon.species)) {
      const tag = document.createElement('span');
      tag.className = 'archive-mon-tag';
      tag.textContent = 'Legendario';
      li.appendChild(tag);
    }
    return li;
  }));
}

let archiveRequest = 0;

async function showArchivePreview() {
  if (!archiveEnabled()) return;
  const date = selectedArchiveDate();
  const requestId = ++archiveRequest;
  if (!date) {
    archiveSeed = null;
    ui.archiveFight.disabled = true;
    ui.archiveTeam.hidden = true;
    ui.archiveStatus.hidden = false;
    ui.archiveStatus.textContent = 'Elige una fecha hasta ayer. El equipo de hoy solo está en el emulador.';
    return;
  }

  archiveSeed = dailySeed(date);
  ui.archiveFight.disabled = true;
  ui.archiveStatus.hidden = false;

  const statusText = `Equipo del ${date} · práctica (no cuenta para el diario). Pasa el ratón por un Pokémon para ver el summary.`;
  const cached = peekArchiveParty(archiveSeed);
  if (cached) {
    renderArchiveTeam(cached);
    ui.archiveFight.disabled = false;
    ui.archiveStatus.textContent = statusText;
    return;
  }

  ui.archiveTeam.hidden = true;
  ui.archiveStatus.textContent = 'Generando el equipo en la ROM…';
  ui.archivePreview.disabled = true;
  try {
    const party = await loadArchiveParty(archiveSeed);
    if (requestId !== archiveRequest) return;
    renderArchiveTeam(party);
    ui.archiveFight.disabled = false;
    ui.archiveStatus.textContent = statusText;
  } catch (err) {
    if (requestId !== archiveRequest) return;
    console.error(err);
    const speciesOnly = previewTeamForSeed(archiveSeed).map((m) => ({
      species: m.id,
      name: m.name,
      level: 100,
      nature: '—',
      ability: '—',
      heldItem: '—',
      stats: [0, 0, 0, 0, 0, 0],
      statLabels: ['PS', 'Ataque', 'Defensa', 'Velocidad', 'At. Esp.', 'Def. Esp.'],
      moves: [],
      ivs: [],
      evs: [],
      shiny: false,
    }));
    renderArchiveTeam(speciesOnly);
    ui.archiveFight.disabled = false;
    ui.archiveStatus.textContent = `No se pudo leer el summary completo (${err?.message || err}). Mostrando especies.`;
  } finally {
    if (requestId === archiveRequest) ui.archivePreview.disabled = false;
  }
}

function fightArchiveTeam() {
  if (!archiveSeed || starting) return;
  practiceSeed = archiveSeed;
  const url = new URL(location.href);
  url.searchParams.set('seed', String(practiceSeed));
  history.replaceState(null, '', url);
  renderTitle();
  startRun();
}

async function initArchive() {
  if (!ui.archive) return;
  const archiveBase = new URL(`./archive/${gameId}/`, import.meta.url);
  const symbolsUrl = new URL('symbols.json', archiveBase);
  try {
    const res = await fetch(symbolsUrl);
    if (!res.ok) throw new Error('sin archive');
    archiveIconBase = archiveBase;
    configureArchiveParty({
      symbolsUrl: symbolsUrl.href,
      loadFiles: () => loadGameFiles(packBase, manifest.rom.path),
      injectConfig: (rom, opts) => protocol.injectConfig(rom, opts),
      createGameLink: (emulator, seed) => protocol.createGameLink(emulator, seed),
      romFileName: `${manifest.id}.gba`,
      cacheKey: `hortelano:${gameId}:archive-party-v2`,
    });
    ui.archive.hidden = false;
    syncArchiveDateBounds();
    ui.archiveDate.addEventListener('change', () => { showArchivePreview(); });
    onClick(ui.archivePreview, () => { showArchivePreview(); });
    onClick(ui.archiveFight, fightArchiveTeam);
    showArchivePreview();
  } catch {
    ui.archive.hidden = true;
  }
}

ui.volume?.addEventListener('input', () => {
  volume = Number(ui.volume.value);
  session.set(volumeKey(), String(volume));
  if (manifest?.client?.mutedKey) {
    session.set(manifest.client.mutedKey, volume <= 0 ? '1' : '0');
  }
  showVolume();
  applyVolume();
});

if (ui.soundControl) {
  ui.soundControl.addEventListener('mouseenter', () => {
    if (!ui.sound.disabled) ui.sound.setAttribute('aria-expanded', 'true');
  });
  ui.soundControl.addEventListener('mouseleave', () => {
    ui.sound.setAttribute('aria-expanded', 'false');
  });
}

function showVolume() {
  const silent = volume <= 0;
  if (ui.volume) ui.volume.value = String(volume);
  if (ui.volumeValue) ui.volumeValue.textContent = String(volume);
  ui.sound.setAttribute('aria-pressed', String(silent));
  const on = ui.sound.querySelector('.icon-sound-on');
  const off = ui.sound.querySelector('.icon-sound-off');
  if (on) on.hidden = silent;
  if (off) off.hidden = !silent;
}

function showFullscreen() {
  const active = Boolean(document.fullscreenElement);
  ui.fullscreen.setAttribute('aria-label', active ? 'Salir de pantalla completa' : 'Pantalla completa');
  const enter = ui.fullscreen.querySelector('.icon-fs-enter');
  const exit = ui.fullscreen.querySelector('.icon-fs-exit');
  if (enter) enter.hidden = active;
  if (exit) exit.hidden = !active;
}

onClick(ui.fullscreen, () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('console').requestFullscreen().catch(() => {});
});

document.addEventListener('fullscreenchange', showFullscreen);

window.addEventListener('keydown', (event) => {
  if (app.dataset.state === 'playing' && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) {
    event.preventDefault();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!emu) return;
  if (document.hidden) emu.pause();
  else emu.resume();
});

function resumeAudio() {
  for (const ctx of audioContexts) {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }
  applyVolume();
}
window.addEventListener('pointerdown', resumeAudio);
window.addEventListener('keydown', resumeAudio);

for (const button of document.querySelectorAll('[data-button]')) {
  const release = () => {
    if (!button.classList.contains('is-down')) return;
    button.classList.remove('is-down');
    emu?.pressUp(button.dataset.button);
  };
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    button.classList.add('is-down');
    emu?.pressDown(button.dataset.button);
  });
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
}

const dpad = document.querySelector('.dpad');
let heldDirection = null;

function setDirection(next) {
  if (next === heldDirection) return;
  if (heldDirection) emu?.pressUp(heldDirection);
  if (next) emu?.pressDown(next);
  heldDirection = next;
  dpad.dataset.dir = next ?? '';
}

function directionAt(event) {
  const box = dpad.getBoundingClientRect();
  const dx = event.clientX - (box.left + box.width / 2);
  const dy = event.clientY - (box.top + box.height / 2);
  if (Math.hypot(dx, dy) < box.width * 0.12) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

dpad.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  dpad.setPointerCapture(event.pointerId);
  setDirection(directionAt(event));
});
dpad.addEventListener('pointermove', (event) => {
  if (dpad.hasPointerCapture(event.pointerId)) setDirection(directionAt(event));
});
dpad.addEventListener('pointerup', () => setDirection(null));
dpad.addEventListener('pointercancel', () => setDirection(null));

async function boot() {
  packBase = new URL(`../games/${gameId}/`, import.meta.url).href;
  const res = await fetch(new URL('game.manifest.json', packBase));
  if (!res.ok) throw new Error(`No se encontró el pack «${gameId}».`);
  manifest = await res.json();

  const compat = checkGameCompat(manifest);
  if (!compat.ok) {
    ui.gameTitle.textContent = manifest.name || gameId;
    ui.errorText.textContent = compat.message;
    setState('error');
    ui.retry.hidden = true;
    return;
  }

  protocol = getProtocolAdapter(manifest.protocolId);
  PHASE = protocol.PHASE;
  RESULT = protocol.RESULT;
  practiceSeed = protocol.parseSeed(params.get('seed'));

  const diskMirror = await createStatsDiskMirror(manifest.client.statsKey);
  configureDaily({
    statsKey: manifest.client.statsKey,
    seedPrefix: manifest.client.seedPrefix,
    diskMirror,
  });

  const savedVolume = Number(session.get(volumeKey()));
  if (Number.isFinite(savedVolume) && savedVolume >= 0 && savedVolume <= 100) {
    volume = savedVolume;
  } else if (session.get(manifest.client.mutedKey) === '1') {
    volume = 0;
  } else {
    volume = 25;
  }

  stats = settleAbandonedGame(await hydrateStatsFromDisk());

  ui.gameTitle.textContent = manifest.name;
  document.title = `${manifest.name} · Hortelano's Daily`;
  ui.bossSprite.src = new URL(manifest.client.titleAsset, packBase).href;
  ui.bossSprite.alt = manifest.client.bossLabel;

  renderTitle();
  setState('title');
  showVolume();
  showFullscreen();
  ui.fullscreen.hidden = !document.fullscreenEnabled;
  await initArchive();

  window.hortelano = {
    get emulator() { return emu; },
    get stats() { return { ...stats }; },
    get manifest() { return manifest; },
  };
}

boot()
  .then(() => {
    clearTimeout(window.__hortelanoBootTimer);
  })
  .catch((err) => {
    clearTimeout(window.__hortelanoBootTimer);
    console.error(err);
    ui.errorText.textContent = err?.message || String(err);
    setState('error');
  });
