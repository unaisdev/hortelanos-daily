// Adapter: dailyred-conf-v2+status-v1
// Contrato compartido por Daily Gold y Daily Red actuales.

const confMagic = new TextEncoder().encode('DAILYRED-CONF-V2');
const statusMagicWords = new Uint32Array(new TextEncoder().encode('DAILYRED-STATUS1').buffer);

export const PROTOCOL_ID = 'dailyred-conf-v2+status-v1';
export const CONFIG_MAGIC = 'DAILYRED-CONF-V2';
export const STATUS_MAGIC = 'DAILYRED-STATUS1';

export const PHASE = { EXPLORING: 0, BATTLE: 1, RESULT: 2, FINISHED: 3 };
export const RESULT = { NONE: 0, WON: 1, LOST: 2 };

export function findConfigOffset(rom) {
  const first = confMagic[0];
  outer: for (let i = rom.indexOf(first); i !== -1; i = rom.indexOf(first, i + 1)) {
    for (let j = 1; j < confMagic.length; j++) {
      if (rom[i + j] !== confMagic[j]) continue outer;
    }
    return i + confMagic.length;
  }
  return -1;
}

export function injectConfig(rom, { seed, wins = 0, battles = 0, daily = false }) {
  const offset = findConfigOffset(rom);
  if (offset < 0) {
    throw new Error(
      `Esta ROM no contiene ${CONFIG_MAGIC}. ¿Content pack incorrecto o protocolId desfasado?`,
    );
  }
  const patched = rom.slice();
  const view = new DataView(patched.buffer);
  view.setUint32(offset, seed >>> 0, true);
  view.setUint16(offset + 4, Math.min(wins, 0xffff), true);
  view.setUint16(offset + 6, Math.min(battles, 0xffff), true);
  view.setUint8(offset + 8, daily ? 1 : 0);
  return patched;
}

export function createGameLink(emulator, seed) {
  let offset = -1;
  return function read() {
    const heap = emulator.getEmscriptenModule().HEAPU8;
    if (offset < 0) offset = findStatus(heap, seed >>> 0);
    if (offset < 0) return null;
    return { phase: heap[offset + 20], result: heap[offset + 21] };
  };
}

function findStatus(heap, seed) {
  const words = new Uint32Array(heap.buffer, heap.byteOffset, heap.byteLength >>> 2);
  for (let i = 0, end = words.length - 5; i < end; i++) {
    if (
      words[i] === statusMagicWords[0]
      && words[i + 1] === statusMagicWords[1]
      && words[i + 2] === statusMagicWords[2]
      && words[i + 3] === statusMagicWords[3]
      && words[i + 4] === seed
    ) {
      return i * 4;
    }
  }
  return -1;
}

export function parseSeed(text) {
  if (text == null || !/^\d{1,10}$/.test(String(text).trim())) return null;
  const seed = Number(text);
  return seed >= 1 && seed <= 0xffffffff ? seed : null;
}
