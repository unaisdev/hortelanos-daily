import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { readStevenParty, STEVEN_ARCHIVE_FORMAT, verifyStevenArchive } from '../runner/steven-archive.js';
import { STEVEN_SPRITE_ROM_SHA256, stevenArchiveIconId } from '../runner/steven-archive-sprites.js';

const icon = (species) => stevenArchiveIconId(species, STEVEN_SPRITE_ROM_SHA256);

test('archive sprites translate Expansion IDs to existing Gold icons', () => {
  assert.deepEqual([25, 29, 32, 252, 280, 282].map(icon), [25, 29, 32, 277, 392, 394]);
  const icons = Array.from({ length: 386 }, (_, i) => icon(i + 1)).filter((id) => id !== null);
  assert.equal(icons.length, 383);
  assert.equal(new Set(icons).size, icons.length);
  for (const id of icons) {
    assert.ok(existsSync(new URL(`../runner/archive/dailygold/icons/${id}.png`, import.meta.url)), `missing icon ${id}`);
  }
});

test('archive sprites fall back for ambiguous forms and unknown IDs', () => {
  for (const species of [0, 201, 351, 386, 387, 1024, 1053, 1056, 65535, undefined]) {
    assert.equal(icon(species), null);
  }
  assert.equal(stevenArchiveIconId(252, '0'.repeat(64)), null);
});

test('archive symbols are rejected when the ROM bytes change', async () => {
  const rom = Uint8Array.of(1, 2, 3);
  const symbols = { format: STEVEN_ARCHIVE_FORMAT, romSha256: createHash('sha256').update(rom).digest('hex') };
  await verifyStevenArchive(rom, symbols);
  await assert.rejects(verifyStevenArchive(Uint8Array.of(1, 2, 4), symbols), /no corresponden/);
});

test('expansion archive export uses the matching seed, names and actual move slots', () => {
  const archive = new Uint8Array(1300);
  const view = new DataView(archive.buffer);
  view.setUint32(0, 123, true);
  for (let slot = 0; slot < 6; slot++) {
    const base = 4 + slot * 216;
    view.setUint16(base, 386, true);
    view.setUint16(base + 8, 541, true);
    view.setUint16(base + 14, 250, true);
    archive[base + 26] = 3;
    archive[base + 27] = 100;
    archive[base + 30] = 15;
    archive.fill(255, base + 45, base + 45 + 7 * 24);
    archive[base + 45] = 187;
    archive[base + 69] = 188;
    archive[base + 45 + 4 * 24] = 189;
  }
  const symbols = { gPlayerPartyCount: 1, gDailyMaxArchive: 2, charmap: { 187: 'A', 188: 'B', 189: 'C' } };
  const mem = { read: address => address === 1 ? [6] : archive };
  assert.deepEqual(readStevenParty(mem, symbols, 124), []);
  const party = readStevenParty(mem, symbols, 123);
  assert.equal(party.length, 6);
  assert.equal(party[0].name, 'A');
  assert.equal(party[0].ability, 'B');
  assert.equal(party[0].nature, 'Firme');
  assert.equal(party[0].stats[0], 250);
  assert.deepEqual(party[0].moves, [{ id: 541, name: 'C', pp: 15 }]);
});
