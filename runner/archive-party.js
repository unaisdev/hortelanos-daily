// Boots a headless emulator long enough to read the generated party for a seed,
// then exits. Results are cached so date browsing stays snappy after the first load.
import { Nostalgist } from './vendor/nostalgist.js';
import { loadGameFiles } from './game-files.js';
import { injectConfig } from './rom-config.js';
import { createGameLink } from './game-link.js';
import { decodeParty } from './party-decode.js';

const STATE_EWRAM = 0x21000;
const STATE_IWRAM = 0x19000;
const CACHE_KEY = 'dailyred-archive-party-v2';
const memoryCache = new Map();
let inflight = null;
let symbolsPromise = null;

let options = {
  symbolsUrl: 'game/symbols.json',
  loadFiles: () => loadGameFiles(),
  injectConfig,
  createGameLink,
  romFileName: 'dailyred.gba',
  cacheKey: CACHE_KEY,
};

export function configureArchiveParty(next = {}) {
  options = { ...options, ...next };
  symbolsPromise = null;
}

function loadCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(options.cacheKey) || '{}');
    for (const [seed, party] of Object.entries(raw)) memoryCache.set(Number(seed), party);
  } catch { /* ignore */ }
}

function saveCache(seed, party) {
  memoryCache.set(seed, party);
  try {
    const raw = Object.fromEntries([...memoryCache.entries()].slice(-40));
    localStorage.setItem(options.cacheKey, JSON.stringify(raw));
  } catch { /* quota / private mode */ }
}

loadCache();

async function loadSymbols() {
  symbolsPromise ??= fetch(options.symbolsUrl)
    .then((res) => {
      if (!res.ok) throw new Error('Faltan los símbolos de la ROM. Ejecuta scripts/gen-archive-assets.mjs.');
      return res.json();
    });
  return symbolsPromise;
}

function unwrapSaveState(buf) {
  let state = buf;
  const ascii = (start, len) => String.fromCharCode(...state.subarray(start, start + len));
  if (ascii(0, 7) === 'RASTATE') {
    let pos = 8;
    while (pos + 8 <= state.length) {
      const id = ascii(pos, 4);
      const size = new DataView(state.buffer, state.byteOffset + pos + 4, 4).getUint32(0, true);
      if (id === 'MEM ') {
        state = state.subarray(pos + 8, pos + 8 + size);
        break;
      }
      pos += 8 + size + ((8 - (size % 8)) % 8);
    }
  }
  const magic = new DataView(state.buffer, state.byteOffset, 4).getUint32(0, true);
  if ((magic & 0xFFFF0000) !== 0x01000000) {
    throw new Error('Formato de save state inesperado');
  }
  return {
    read(addr, len) {
      if (addr >= 0x02000000 && addr < 0x02040000) {
        const start = STATE_EWRAM + addr - 0x02000000;
        return state.subarray(start, start + len);
      }
      if (addr >= 0x03000000 && addr < 0x03008000) {
        const start = STATE_IWRAM + addr - 0x03000000;
        return state.subarray(start, start + len);
      }
      throw new Error(`Dirección ${addr.toString(16)} fuera de RAM`);
    },
  };
}

async function waitForStatus(read, timeoutMs = 30000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    try {
      const status = read?.();
      if (status) return status;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('El equipo tardó demasiado en generarse');
}

async function readPartyFromEmu(emu, symbols) {
  const { state } = await emu.saveState();
  const mem = unwrapSaveState(new Uint8Array(await state.arrayBuffer()));
  const count = mem.read(symbols.gPlayerPartyCount, 1)[0];
  const bytes = mem.read(symbols.gPlayerParty, 600);
  return { count, bytes, party: decodeParty(bytes, count || 6) };
}

// Status appears in CB2_DailyRed_StartFromCopyright before GenerateTeam runs,
// so we keep polling the save state until the party is actually filled.
async function waitForParty(emu, symbols, timeoutMs = 30000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    try {
      const snapshot = await readPartyFromEmu(emu, symbols);
      if (snapshot.count === 6 && snapshot.party.length === 6) return snapshot.party;
    } catch { /* save state not ready yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('El equipo tardó demasiado en generarse');
}

async function bootAndRead(seed) {
  const [files, symbols] = await Promise.all([options.loadFiles(), loadSymbols()]);
  const rom = options.injectConfig(files.rom, { seed });
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 160;
  canvas.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(canvas);

  let emu = null;
  try {
    emu = await Nostalgist.launch({
      core: 'mgba',
      element: canvas,
      size: { width: 240, height: 160 },
      rom: { fileName: options.romFileName, fileContent: new Blob([rom]) },
      resolveCoreJs: () => files.coreJs,
      resolveCoreWasm: () => files.coreWasm,
      retroarchConfig: {
        audio_mute_enable: true,
        savestate_file_compression: false,
        savestate_thumbnail_enable: false,
      },
    });
    const read = options.createGameLink(emu, seed);
    await waitForStatus(read);
    return await waitForParty(emu, symbols);
  } finally {
    try { emu?.exit(); } catch { /* ignore */ }
    canvas.remove();
  }
}

export async function loadArchiveParty(seed) {
  if (memoryCache.has(seed)) return memoryCache.get(seed);
  if (inflight?.seed === seed) return inflight.promise;

  const promise = bootAndRead(seed).then((party) => {
    saveCache(seed, party);
    return party;
  }).finally(() => {
    if (inflight?.seed === seed) inflight = null;
  });
  inflight = { seed, promise };
  return promise;
}

export function peekArchiveParty(seed) {
  return memoryCache.get(seed) || null;
}
