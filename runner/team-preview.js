// Mirrors PickTeamSpecies in pokefirered/src/dailyred_team.c so the website
// can show the six species a date's seed produces, without booting the ROM.
// Moves / IVs / items still come from the game itself once you play.
import { BASE_STAT_TOTALS, NUM_SPECIES, SPECIES_NAMES } from './team-preview-data.js';

const PARTY_SIZE = 6;
const MIN_TEAM_BASE_STAT_TOTAL = 2850;
const LEGENDARY_TEAM_ODDS = 8;
const MAX_SPECIES_ATTEMPTS = 1000;
const MAX_TEAM_ATTEMPTS = 1000;
const OLD_UNOWN_B = 252;
const OLD_UNOWN_Z = 276;

// Same list and order as sLegendaries in dailyred_team.c.
const LEGENDARIES = [
  144, 145, 146, 150, 151, // Articuno Zapdos Moltres Mewtwo Mew
  243, 244, 245, 249, 250, 251, // Raikou Entei Suicune Lugia Ho-Oh Celebi
  401, 402, 403, 407, 408, // Regirock Regice Registeel Latias Latios
  404, 405, 406, 409, 410, // Kyogre Groudon Rayquaza Jirachi Deoxys
];

const LEGENDARY_SET = new Set(LEGENDARIES);

function teamRandom(rng) {
  // ISO_RANDOMIZE1: u32 wrap of 1103515245 * state + 24691, then high 16 bits.
  rng.state = (Math.imul(1103515245, rng.state) + 24691) >>> 0;
  return rng.state >>> 16;
}

function isEligible(species) {
  if (species === 0 || species >= NUM_SPECIES) return false;
  if (species >= OLD_UNOWN_B && species <= OLD_UNOWN_Z) return false;
  return true;
}

function isTaken(species, taken, takenCount) {
  for (let i = 0; i < takenCount; i++) {
    if (taken[i] === species) return true;
  }
  return false;
}

function pickSpecies(rng, taken, takenCount) {
  for (let i = 0; i < MAX_SPECIES_ATTEMPTS; i++) {
    const species = 1 + (teamRandom(rng) % (NUM_SPECIES - 1));
    if (isEligible(species) && !LEGENDARY_SET.has(species) && !isTaken(species, taken, takenCount)) {
      return species;
    }
  }
  for (let species = 1; species < NUM_SPECIES; species++) {
    if (isEligible(species) && !LEGENDARY_SET.has(species) && !isTaken(species, taken, takenCount)) {
      return species;
    }
  }
  return 1; // Bulbasaur fallback, same as the ROM
}

function pickTeamSpecies(seed) {
  const rng = { state: seed >>> 0 };
  const species = new Array(PARTY_SIZE);
  const best = new Array(PARTY_SIZE);
  let bestTotal = 0;
  let first = 0;

  if (teamRandom(rng) % LEGENDARY_TEAM_ODDS === 0) {
    species[first++] = LEGENDARIES[teamRandom(rng) % LEGENDARIES.length];
  }

  let attempt;
  for (attempt = 0; attempt < MAX_TEAM_ATTEMPTS; attempt++) {
    let total = 0;
    for (let i = 0; i < PARTY_SIZE; i++) {
      if (i >= first) species[i] = pickSpecies(rng, species, i);
      total += BASE_STAT_TOTALS[species[i]] || 0;
    }
    if (total >= MIN_TEAM_BASE_STAT_TOTAL) break;
    if (total > bestTotal) {
      bestTotal = total;
      for (let i = 0; i < PARTY_SIZE; i++) best[i] = species[i];
    }
  }
  if (attempt === MAX_TEAM_ATTEMPTS) {
    for (let i = 0; i < PARTY_SIZE; i++) species[i] = best[i];
  }

  const slot = teamRandom(rng) % PARTY_SIZE;
  const tmp = species[0];
  species[0] = species[slot];
  species[slot] = tmp;
  return species;
}

const NAME_FIXES = {
  HO_OH: 'Ho-Oh',
  MR_MIME: 'Mr. Mime',
  FARFETCHD: 'Farfetch\'d',
  NIDORAN_F: 'Nidoran♀',
  NIDORAN_M: 'Nidoran♂',
  PORYGON_Z: 'Porygon-Z',
};

export function formatSpeciesName(idOrKey) {
  const key = typeof idOrKey === 'number' ? SPECIES_NAMES[idOrKey] : idOrKey;
  if (!key) return `#${idOrKey}`;
  if (NAME_FIXES[key]) return NAME_FIXES[key];
  return key
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// Returns [{ id, name, legendary }, ...] for the six Pokemon of `seed`.
export function previewTeamForSeed(seed) {
  if (!Number.isInteger(seed) || seed < 1 || seed > 0xFFFFFFFF) {
    throw new Error('Semilla de equipo no válida');
  }
  return pickTeamSpecies(seed).map((id) => ({
    id,
    name: formatSpeciesName(id),
    legendary: LEGENDARY_SET.has(id),
  }));
}
