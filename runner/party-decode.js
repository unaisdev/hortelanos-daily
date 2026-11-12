// Decodes a Gen 3 party Pokemon (struct Pokemon, 100 bytes) for the archive UI.
import {
  ABILITY_NAMES, ITEM_NAMES, MOVE_NAMES, SPECIES_ABILITIES, SPECIES_NAMES,
} from './archive-data.js';
import { formatSpeciesName } from './team-preview.js';

const NATURES = [
  'Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty', 'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
  'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive', 'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash',
  'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky',
];

const ORDERS = [
  'GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG',
  'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG',
];

const STAT_LABELS = ['PS', 'Ataque', 'Defensa', 'Velocidad', 'At. Esp.', 'Def. Esp.'];

function u16(view, offset) {
  return view.getUint16(offset, true);
}

function u32(view, offset) {
  return view.getUint32(offset, true);
}

function prettyConst(name) {
  if (!name) return '—';
  return name
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function decodeMon(bytes) {
  const view = bytes instanceof DataView ? bytes : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const personality = u32(view, 0);
  const otId = u32(view, 4);
  if (personality === 0 && otId === 0) return null;

  const key = (personality ^ otId) >>> 0;
  const secure = new Uint8Array(48);
  const secureView = new DataView(secure.buffer);
  for (let i = 0; i < 48; i += 4) {
    secureView.setUint32(i, (u32(view, 32 + i) ^ key) >>> 0, true);
  }
  const order = ORDERS[personality % 24];
  const sub = (letter) => secure.subarray(order.indexOf(letter) * 12, order.indexOf(letter) * 12 + 12);
  const g = sub('G');
  const a = sub('A');
  const e = sub('E');
  const m = sub('M');
  const gView = new DataView(g.buffer, g.byteOffset, g.byteLength);
  const aView = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const mView = new DataView(m.buffer, m.byteOffset, m.byteLength);

  const ivWord = mView.getUint32(4, true);
  const ivs = [0, 5, 10, 15, 20, 25].map((shift) => (ivWord >>> shift) & 31);
  const species = gView.getUint16(0, true);
  const heldItem = gView.getUint16(2, true);
  const moves = [0, 2, 4, 6].map((o) => aView.getUint16(o, true));
  const pp = [8, 9, 10, 11].map((o) => a[o]);
  const abilityNum = (ivWord >>> 31) & 1;
  const abilityId = (SPECIES_ABILITIES[species] || [0, 0])[abilityNum] || 0;
  const stats = [88, 90, 92, 94, 96, 98].map((o) => u16(view, o));

  return {
    species,
    name: formatSpeciesName(species),
    speciesKey: SPECIES_NAMES[species] || `#${species}`,
    level: view.getUint8(84),
    hp: u16(view, 86),
    maxHp: stats[0],
    stats,
    statLabels: STAT_LABELS,
    nature: NATURES[personality % 25],
    ability: prettyConst(ABILITY_NAMES[abilityId]),
    heldItem: prettyConst(ITEM_NAMES[heldItem]),
    moves: moves.filter(Boolean).map((id, i) => ({
      id,
      name: prettyConst(MOVE_NAMES[id]),
      pp: pp[i],
    })),
    ivs,
    evs: [...e.subarray(0, 6)],
    shiny: ((otId >>> 16) ^ (otId & 0xFFFF) ^ (personality >>> 16) ^ (personality & 0xFFFF)) < 8,
    legendary: false, // filled by caller if needed
  };
}

export function decodeParty(bytes, count = 6) {
  const party = [];
  for (let i = 0; i < count; i++) {
    const slice = bytes.subarray(i * 100, i * 100 + 100);
    const mon = decodeMon(slice);
    if (mon) party.push(mon);
  }
  return party;
}
