/**
 * Copyright (c) Llama Manager project. Use of this file is governed by the
 * LICENSE file in the repository root.
 *
 * Tests the pure GPU inventory logic: which card inference runs on, how cards
 * are classified integrated vs discrete, how rocm-smi's per-card output is
 * parsed, and that a card whose size nothing can measure is reported with a
 * reason rather than as zero or dropped. Every case is driven from fixtures so
 * it exercises hardware this host does not have.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTEGRATED_GTT_FRACTION,
  classifyCard,
  buildInventory,
  parseRocmSmiCards,
  parsePciApertureBytes,
  parseLspciNames,
  describeCardName,
} from './gpu-inventory.js';

const GIB = 1024 ** 3;
const SYSTEM = 128 * GIB;

test('a card whose GTT covers most of system RAM is integrated', () => {
  assert.equal(classifyCard({ gttBytes: 120 * GIB, systemBytes: SYSTEM }), 'integrated');
  assert.equal(classifyCard({ gttBytes: SYSTEM * INTEGRATED_GTT_FRACTION, systemBytes: SYSTEM }), 'integrated');
});

test('a card with a small GTT window is discrete', () => {
  assert.equal(classifyCard({ gttBytes: 256 * 1024 * 1024, systemBytes: SYSTEM }), 'discrete');
  assert.equal(classifyCard({ gttBytes: null, systemBytes: SYSTEM }), 'discrete');
});

/*
 * THE REGRESSION THIS MODULE EXISTS FOR.
 *
 * DRM cards enumerate in kernel order, so an OCuLink-attached discrete card can
 * sort AHEAD of the APU. The old first-card-wins scan in server.js then reported
 * the discrete card's temperature, power and memory under the iGPU's label --
 * wrong numbers, not merely missing ones -- and the thermal governor read the
 * same function.
 */
test('the iGPU is chosen for inference even when a discrete card sorts first', () => {
  const cards = [
    { card: 'card0', name: 'Radeon RX 7900', gttBytes: 256 * 1024 * 1024, vramBytes: 24 * GIB, temperature: 71, power: 260 },
    { card: 'card1', name: 'Radeon 8060S', gttBytes: 120 * GIB, vramBytes: 1 * GIB, temperature: 49, power: 38 },
  ];
  const gpus = buildInventory(cards, SYSTEM);

  assert.equal(gpus[0].card, 'card1', 'the integrated card must lead the list');
  assert.equal(gpus[0].inference, true);
  assert.equal(gpus[0].kind, 'integrated');
  assert.equal(gpus[1].inference, false);
  assert.equal(gpus[1].kind, 'discrete');
  // The pools must belong to the card they are reported under.
  assert.equal(gpus[0].gttBytes, 120 * GIB);
  assert.equal(gpus[0].temperature, 49, "the iGPU must not wear the discrete card's temperature");
  assert.equal(gpus[1].temperature, 71);
});

test('a discrete card is never credited with a share of host RAM', () => {
  const gpus = buildInventory(
    [{ card: 'card0', gttBytes: 120 * GIB }, { card: 'card1', vramBytes: 24 * GIB }],
    SYSTEM,
  );
  const discrete = gpus.find((g) => g.kind === 'discrete');
  assert.equal(discrete.gttBytes, null);
  assert.equal(discrete.systemBytes, null);
});

test('with no integrated card the first card still runs inference', () => {
  const gpus = buildInventory([
    { card: 'card0', name: 'RTX 3090', vramBytes: 24 * GIB },
    { card: 'card1', name: 'RTX 4090', vramBytes: 24 * GIB },
  ], SYSTEM);
  assert.equal(gpus[0].card, 'card0');
  assert.equal(gpus[0].inference, true);
});

test('an unmeasurable size is null with a reason, never zero and never dropped', () => {
  const gpus = buildInventory([
    { card: 'card0', gttBytes: 120 * GIB },
    { card: 'card1', name: 'Unknown', vramBytes: null },
  ], SYSTEM);
  assert.equal(gpus.length, 2, 'a card nothing can size is still a card');
  const unknown = gpus[1];
  assert.equal(unknown.vramBytes, null);
  assert.notEqual(unknown.vramBytes, 0);
  assert.match(unknown.reason, /reports its memory size|driver/);
});

test('a card with no driver bound is listed as unavailable with the reason', () => {
  const gpus = buildInventory([
    { card: 'card0', gttBytes: 120 * GIB },
    { card: '', name: 'RTX 3090', available: false },
  ], SYSTEM);
  assert.equal(gpus.length, 2);
  assert.equal(gpus[1].available, false);
  assert.match(gpus[1].reason, /no kernel driver is bound/);
});

test('no GPUs at all yields an empty inventory rather than a fake card', () => {
  assert.deepEqual(buildInventory([], SYSTEM), []);
});

/*
 * rocm-smi reports card0, card1, card2 ... The old parser read data.card0 and
 * discarded every other key, so a second AMD card was invisible.
 */
test('rocm-smi parsing covers every card, not just card0', () => {
  const parsed = parseRocmSmiCards({
    card0: { 'Temperature (Sensor edge) (C)': '49.0', 'VRAM Total Memory (B)': String(1 * GIB) },
    card1: { 'Temperature (Sensor edge) (C)': '71.0', 'VRAM Total Memory (B)': String(24 * GIB) },
  });
  assert.deepEqual(Object.keys(parsed).sort(), ['card0', 'card1']);
  assert.equal(parsed.card1.temperature, 71);
  assert.equal(parsed.card1.vramBytes, 24 * GIB);
});

test('rocm-smi returning nothing is an empty map, not a throw', () => {
  assert.deepEqual(parseRocmSmiCards({}), {});
  assert.deepEqual(parseRocmSmiCards(null), {});
});

/*
 * VENDOR-NEUTRAL ENUMERATION (A1).
 *
 * Drakemore's RTX 3090 sits on nouveau, which registers no hwmon and publishes
 * no mem_info_vram_total, so every AMD-shaped reader drops it. These helpers are
 * the vendor-neutral fallbacks, mirrored from the kiosk agent so the two
 * readouts cannot disagree about what is in the machine.
 */

test('the aperture is the largest prefetchable memory BAR', () => {
  // A 24 GiB RTX 3090 exposes a 32 GiB prefetchable BAR -- the figure is an
  // over-report, which is why A3 labels it an estimate rather than hiding it.
  const resource = [
    '0x00000000a0000000 0x00000000a0ffffff 0x0000000000040200', // 16 MiB, not prefetchable
    '0x0000008000000000 0x00000087ffffffff 0x000000000014220c', // 32 GiB, prefetchable
    '0x0000000000000000 0x0000000000000000 0x0000000000000000',
  ].join('\n');
  assert.equal(parsePciApertureBytes(resource), 32 * GIB);
});

test('a BAR too small to be VRAM is discarded, not reported', () => {
  // A card without resizable BAR shows a 256 MiB window onto a large pool.
  // Printing that as the card's memory would be a confident lie.
  const resource = '0x0000000090000000 0x000000009fffffff 0x000000000014220c';
  assert.equal(parsePciApertureBytes(resource), null);
  assert.equal(parsePciApertureBytes(''), null);
  assert.equal(parsePciApertureBytes(null), null);
});

test('a non-prefetchable memory BAR is never mistaken for VRAM', () => {
  const resource = '0x0000008000000000 0x00000087ffffffff 0x0000000000040200';
  assert.equal(parsePciApertureBytes(resource), null);
});

test('lspci -mm output becomes a slot to name map', () => {
  const stdout = [
    'c6:00.0 "VGA compatible controller" "NVIDIA Corporation" "GA102 [GeForce RTX 3090]" -r a1 "NVIDIA Corporation" "Device 1467"',
    'c8:00.0 "VGA compatible controller" "Advanced Micro Devices, Inc. [AMD/ATI]" "Strix Halo" -ra1 "AMD" "Device 1586"',
  ].join('\n');
  const names = parseLspciNames(stdout);
  assert.equal(names['c6:00.0'], 'GA102 [GeForce RTX 3090]');
  assert.equal(names['c8:00.0'], 'Strix Halo');
});

test('lspci being absent is an empty map, not a throw', () => {
  assert.deepEqual(parseLspciNames(''), {});
  assert.deepEqual(parseLspciNames(null), {});
});

test('a card is named from its vendor and whatever label resolves', () => {
  assert.equal(
    describeCardName({ vendorId: '0x10de', deviceId: '0x2204', lspciName: 'GA102 [GeForce RTX 3090]' }),
    'NVIDIA GA102 [GeForce RTX 3090]',
  );
  // Silicon newer than the local PCI database: the raw device id, not a guess.
  assert.equal(describeCardName({ vendorId: '0x1002', deviceId: '0x1586' }), 'AMD Device 1586');
  // An unknown vendor id is shown as-is rather than dropped.
  assert.equal(describeCardName({ vendorId: '0x1234', deviceId: '0x0001' }), '0x1234 Device 0001');
  assert.equal(describeCardName({}), 'Graphics adapter');
});

/*
 * A card with no hwmon must still produce an entry. nouveau registers none, so
 * requiring one is exactly what made the 3090 invisible. Telemetry it cannot
 * report is null -- a confident 0 W / 0 C would read as a broken card.
 */
test('a card with no telemetry is inventoried with nulls, not zeroes', () => {
  const cards = [
    { card: 'card1', name: 'NVIDIA GA102 [GeForce RTX 3090]', driver: 'nouveau', vramBytes: 32 * GIB, vramSource: 'aperture' },
    { card: 'card2', name: 'AMD Device 1586', driver: 'amdgpu', gttBytes: 120 * GIB, vramBytes: 1 * GIB, temperature: 49, power: 38 },
  ];
  const [inference, discrete] = buildInventory(cards, SYSTEM);
  assert.equal(inference.card, 'card2');
  assert.equal(inference.kind, 'integrated');
  assert.equal(discrete.card, 'card1');
  assert.equal(discrete.driver, 'nouveau');
  assert.equal(discrete.available, true);
  assert.equal(discrete.temperature, null);
  assert.equal(discrete.power, null);
  assert.equal(discrete.vramBytes, 32 * GIB);
  assert.equal(discrete.vramSource, 'aperture');
  assert.equal(inference.vramSource, null);
});

/*
 * Per-card `usage` was structurally null on EVERY card ever built. The sysfs
 * reader supplies the kernel's counter as `busyPercent`; this read `raw.usage`,
 * a key nothing sets. The headline figure was fine, which is what hid it: the
 * dashboard's rail showed real utilisation while the per-card panel beside it
 * showed nothing, on the same machine, from the same poll.
 */
test('a card reports the utilisation the kernel measured for it', () => {
  const [gpu] = buildInventory([{ card: 'card1', driver: 'amdgpu', gttBytes: 128 * GIB, busyPercent: 97 }], SYSTEM);
  assert.equal(gpu.usage, 97);
});

test('a card with no utilisation counter reports null, not idle', () => {
  // nouveau exposes no gpu_busy_percent. Reporting 0% would assert the card is
  // idle; null says we cannot see it, which is the truth.
  const [, dgpu] = buildInventory([
    { card: 'card2', driver: 'amdgpu', gttBytes: 128 * GIB, busyPercent: 30 },
    { card: 'card1', driver: 'nouveau' },
  ], SYSTEM);
  assert.equal(dgpu.usage, null);
});
