// Stable export from Daily Steven's pokeemerald-expansion ROM.
import { stevenArchiveIconId } from './steven-archive-sprites.js';

export const STEVEN_ARCHIVE_FORMAT = 'steven-expansion-v1';
const MON_BYTES = 216;
const PARTY_SIZE = 6;
const NAME_BYTES = 24;
const NATURES = [
  'Fuerte', 'Huraña', 'Audaz', 'Firme', 'Pícara', 'Osada', 'Dócil', 'Plácida', 'Agitada', 'Floja',
  'Miedosa', 'Activa', 'Seria', 'Alegre', 'Ingenua', 'Modesta', 'Afable', 'Mansa', 'Tímida', 'Alocada',
  'Serena', 'Amable', 'Grosera', 'Cauta', 'Rara',
];
const STAT_LABELS = ['PS', 'Ataque', 'Defensa', 'Velocidad', 'At. Esp.', 'Def. Esp.'];

export async function verifyStevenArchive(rom, symbols) {
  if (symbols.format !== STEVEN_ARCHIVE_FORMAT || !/^[a-f0-9]{64}$/.test(symbols.romSha256)) {
    throw new Error('Formato de archivo de Daily Steven incompatible.');
  }
  const digest = await crypto.subtle.digest('SHA-256', rom);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== symbols.romSha256) throw new Error('Los símbolos de Daily Steven no corresponden a esta ROM.');
}

export function readStevenParty(mem, symbols, seed) {
  const count = mem.read(symbols.gPlayerPartyCount, 1)[0];
  if (count !== PARTY_SIZE) return [];
  const bytes = mem.read(symbols.gDailyMaxArchive, 4 + PARTY_SIZE * MON_BYTES);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== seed) return [];
  const u16 = (offset) => view.getUint16(offset, true);

  return Array.from({ length: count }, (_, slot) => {
    const base = 4 + slot * MON_BYTES;
    const text = (index) => {
      const start = base + 45 + index * NAME_BYTES;
      let name = '';
      for (const byte of bytes.subarray(start, start + NAME_BYTES)) {
        if (byte === 255) break;
        name += symbols.charmap[byte] ?? '�';
      }
      return name.trim();
    };
    const stats = [14, 16, 18, 20, 22, 24].map((offset) => u16(base + offset));
    const species = u16(base);
    return {
      species,
      archiveIconId: stevenArchiveIconId(species, symbols.romSha256),
      name: text(0),
      level: bytes[base + 27],
      shiny: Boolean(bytes[base + 28]),
      nature: NATURES[bytes[base + 26]],
      ability: text(1),
      heldItem: u16(base + 4) ? text(2) : '—',
      stats,
      statLabels: STAT_LABELS,
      moves: Array.from({ length: 4 }, (_, index) => ({
        id: u16(base + 6 + index * 2),
        name: text(3 + index),
        pp: bytes[base + 29 + index],
      })).filter((move) => move.id),
      ivs: Array.from(bytes.subarray(base + 33, base + 39)),
      evs: Array.from(bytes.subarray(base + 39, base + 45)),
    };
  });
}
