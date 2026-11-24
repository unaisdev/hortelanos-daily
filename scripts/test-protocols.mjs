#!/usr/bin/env node
/**
 * Pruebas de los adaptadores de protocolo (runner/protocols).
 * Run: node scripts/test-protocols.mjs
 *
 * Comprueba, con ROMs y memoria sintéticas, que cada adaptador escribe la configuración y lee el estado con SUS firmas
 * y que no se confunde con las del otro juego (Daily Red/Gold vs Daily Steven).
 */
import assert from 'node:assert/strict';
import { checkGameCompat } from '../runner/compat.js';
import {
  getProtocolAdapter,
  hasProtocolAdapter,
  listProtocolIds,
} from '../runner/protocols/index.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const RED = 'dailyred-conf-v2+status-v1';
const MAX = 'dailymax-conf-v1+status-v1';

test('la compatibilidad usa la versión del lanzador y conserva los packs anteriores', () => {
  const steven = { protocolId: MAX, compat: { minLauncherVersion: '3.0.0' } };
  assert.equal(checkGameCompat(steven, '2.9.9').code, 'launcher-too-old');
  assert.ok(checkGameCompat(steven, '3.0.0').ok);
  assert.ok(checkGameCompat({ protocolId: RED, compat: { minLauncherVersion: '0.1.0' } }, '3.0.0').ok);
});

function fakeRom(magic) {
  const rom = new Uint8Array(4096).fill(0xff);
  const enc = new TextEncoder().encode(magic);
  rom.set(enc, 1024); // la config empieza justo tras la firma
  return { rom, offset: 1024 + enc.length };
}

function fakeEmulator(statusMagic, seed, phase, result, at = 2048) {
  const heap = new Uint8Array(8192);
  heap.set(new TextEncoder().encode(statusMagic), at);
  new DataView(heap.buffer).setUint32(at + 16, seed >>> 0, true);
  heap[at + 20] = phase;
  heap[at + 21] = result;
  return { getEmscriptenModule: () => ({ HEAPU8: heap }) };
}

test('el registro conoce Daily Gold/Red y Daily Steven', () => {
  assert.deepEqual(new Set(listProtocolIds()), new Set([RED, MAX]));
  assert.ok(hasProtocolAdapter(RED));
  assert.ok(hasProtocolAdapter(MAX));
  assert.ok(!hasProtocolAdapter('otro-protocolo'));
  assert.throws(() => getProtocolAdapter('otro-protocolo'), /Protocolo desconocido/);
});

test('cada adaptador declara su identificador y sus firmas', () => {
  const red = getProtocolAdapter(RED);
  const max = getProtocolAdapter(MAX);
  assert.equal(red.PROTOCOL_ID, RED);
  assert.equal(max.PROTOCOL_ID, MAX);
  assert.equal(red.CONFIG_MAGIC, 'DAILYRED-CONF-V2');
  assert.equal(red.STATUS_MAGIC, 'DAILYRED-STATUS1');
  assert.equal(max.CONFIG_MAGIC, 'DAILYMAX-CONF-V1');
  assert.equal(max.STATUS_MAGIC, 'DAILYMAX-STATUS1');
  assert.equal(max.CONFIG_MAGIC.length, 16);
  assert.equal(max.STATUS_MAGIC.length, 16);
});

for (const [id, conf, status] of [[RED, 'DAILYRED-CONF-V2', 'DAILYRED-STATUS1'], [MAX, 'DAILYMAX-CONF-V1', 'DAILYMAX-STATUS1']]) {
  const ad = getProtocolAdapter(id);

  test(`${id}: injectConfig escribe semilla, victorias, combates y daily tras la firma`, () => {
    const { rom, offset } = fakeRom(conf);
    assert.equal(ad.findConfigOffset(rom), offset);
    const out = ad.injectConfig(rom, { seed: 0xdeadbeef, wins: 3, battles: 7, daily: true });
    const view = new DataView(out.buffer);
    assert.equal(view.getUint32(offset, true), 0xdeadbeef);
    assert.equal(view.getUint16(offset + 4, true), 3);
    assert.equal(view.getUint16(offset + 6, true), 7);
    assert.equal(view.getUint8(offset + 8), 1);
    assert.equal(new DataView(rom.buffer).getUint32(offset, true), 0xffffffff, 'no modifica la ROM original');
  });

  test(`${id}: injectConfig falla si la ROM no tiene su firma`, () => {
    const { rom } = fakeRom('XXXXXXXXXXXXXXXX');
    assert.equal(ad.findConfigOffset(rom), -1);
    assert.throws(() => ad.injectConfig(rom, { seed: 1 }), /no contiene/);
  });

  test(`${id}: createGameLink lee fase y resultado del bloque de estado de la misma semilla`, () => {
    const link = ad.createGameLink(fakeEmulator(status, 4242, 2, 1), 4242);
    assert.deepEqual(link(), { phase: 2, result: 1 });
    const other = ad.createGameLink(fakeEmulator(status, 4242, 2, 1), 999);
    assert.equal(other(), null, 'otra semilla: no es este combate');
  });

  test(`${id}: parseSeed valida la semilla`, () => {
    assert.equal(ad.parseSeed('123'), 123);
    assert.equal(ad.parseSeed('0'), null);
    assert.equal(ad.parseSeed('abc'), null);
    assert.equal(ad.parseSeed('4294967296'), null);
  });
}

test('los adaptadores no se confunden entre juegos', () => {
  const red = getProtocolAdapter(RED);
  const max = getProtocolAdapter(MAX);
  const redRom = fakeRom('DAILYRED-CONF-V2').rom;
  const maxRom = fakeRom('DAILYMAX-CONF-V1').rom;
  assert.equal(max.findConfigOffset(redRom), -1);
  assert.equal(red.findConfigOffset(maxRom), -1);
  const maxLink = red.createGameLink(fakeEmulator('DAILYMAX-STATUS1', 77, 1, 0), 77);
  assert.equal(maxLink(), null, 'Red no lee el estado de Steven');
  const redLink = max.createGameLink(fakeEmulator('DAILYRED-STATUS1', 77, 1, 0), 77);
  assert.equal(redLink(), null, 'Steven no lee el estado de Red');
});

console.log(`\n${passed} pruebas de protocolo pasadas`);
