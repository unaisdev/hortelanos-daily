import { Nostalgist } from './vendor/nostalgist.js';
import { loadGameFiles } from './game-files.js';
import { getProtocolAdapter } from './protocols/index.js';
import { checkGameCompat } from './compat.js';
import {
  configureDaily, today, dailySeed, msUntilTomorrow, loadStats, resultFor, currentStreaks,
  markBattleStarted, recordResult, settleAbandonedGame,
} from './daily.js';

const $ = (id) => document.getElementById(id);
const app = document.querySelector('.app');
const screen = $('screen');
const ui = {
  play: $('play'),
  retry: $('retry'),
  sound: $('sound'),
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
let stats = null;
let emu = null;
let readGame = null;
let pollTimer = null;
let runDate = null;
let battleSeen = false;
let muted = false;
let starting = false;
let titleDate = null;
let PHASE;
let RESULT;

const audioContexts = [];
const NativeAudioContext = window.AudioContext;
if (NativeAudioContext) {
  window.AudioContext = class extends NativeAudioContext {
    constructor(...args) {
      super(...args);
      audioContexts.push(this);
    }
  };
}

function setState(state) {
  app.dataset.state = state;
  const playing = state === 'playing';
  ui.sound.disabled = !playing;
  ui.fullscreen.disabled = !playing || !document.fullscreenEnabled;
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
        audio_mute_enable: muted,
        savestate_file_compression: false,
        savestate_thumbnail_enable: false,
      },
    });

    readGame = protocol.createGameLink(emu, seed);
    battleSeen = false;
    pollTimer = setInterval(watchGame, 500);
    setState('playing');
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

onClick(ui.sound, () => {
  if (!emu) return;
  emu.sendCommand('MUTE');
  muted = !muted;
  session.set(manifest.client.mutedKey, muted ? '1' : '0');
  showMuted();
});

function showMuted() {
  ui.sound.textContent = muted ? 'Activar sonido' : 'Silenciar';
  ui.sound.setAttribute('aria-pressed', String(muted));
}

onClick(ui.fullscreen, () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('console').requestFullscreen().catch(() => {});
});

document.addEventListener('fullscreenchange', () => {
  ui.fullscreen.textContent = document.fullscreenElement ? 'Salir de pantalla completa' : 'Pantalla completa';
});

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

  configureDaily({
    statsKey: manifest.client.statsKey,
    seedPrefix: manifest.client.seedPrefix,
  });
  muted = session.get(manifest.client.mutedKey) === '1';
  stats = settleAbandonedGame(loadStats());

  ui.gameTitle.textContent = manifest.name;
  document.title = `${manifest.name} · Hortelano's Daily`;
  ui.bossSprite.src = new URL(manifest.client.titleAsset, packBase).href;
  ui.bossSprite.alt = manifest.client.bossLabel;

  renderTitle();
  setState('title');
  showMuted();
  ui.fullscreen.hidden = !document.fullscreenEnabled;

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
