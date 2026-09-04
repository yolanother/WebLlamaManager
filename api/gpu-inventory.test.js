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
  parseNvidiaSmi,
  resolveGpuSeries,
  gpuMemoryUsagePercent,
  perCardKeys,
  historyCardKeys,
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

/*
 * NVIDIA LIVE TELEMETRY.
 *
 * nvidia-smi is the ONLY source for these numbers: the 610 open driver
 * registers no hwmon at all, verified on the appliance after installing it, so
 * the sysfs path that serves every AMD card reports nothing for an NVIDIA one.
 *
 * The fixture below is real output captured from the appliance, not invented:
 *   nvidia-smi --query-gpu=pci.bus_id,temperature.gpu,power.draw,\
 *     utilization.gpu,memory.total,memory.used,clocks.current.graphics,\
 *     clocks.current.memory --format=csv,noheader,nounits
 */

test('nvidia-smi output becomes per-card telemetry keyed by bus tail', () => {
  const parsed = parseNvidiaSmi('00000000:65:00.0, 54, 21.19, 0, 24576, 10, 210, 405');
  // nvidia-smi zero-pads the domain to 8 digits where sysfs uses 4, so the
  // bus:device.function tail is the only part that can be matched.
  const card = parsed['65:00.0'];
  assert.ok(card, 'card should be keyed by its bus tail');
  assert.equal(card.temperature, 54);
  assert.equal(card.power, 21.19);
  assert.equal(card.usage, 0);
  assert.equal(card.vramBytes, 24576 * 1024 * 1024);
  assert.equal(card.vramUsedBytes, 10 * 1024 * 1024);
  assert.equal(card.coreClock, 210);
  assert.equal(card.memClock, 405);
});

test('every card in a multi-GPU box is parsed, not just the first', () => {
  const parsed = parseNvidiaSmi([
    '00000000:65:00.0, 54, 21.19, 0, 24576, 10, 210, 405',
    '00000000:01:00.0, 71, 240.50, 97, 24576, 23000, 1900, 9500',
  ].join('\n'));
  assert.deepEqual(Object.keys(parsed).sort(), ['01:00.0', '65:00.0']);
  assert.equal(parsed['01:00.0'].usage, 97);
  assert.equal(parsed['01:00.0'].power, 240.5);
});

test('an [N/A] field is null, never zero', () => {
  // nvidia-smi prints [N/A] for sensors a given board does not have. Zero
  // would claim the card draws no power or sits at 0 C.
  const card = parseNvidiaSmi('00000000:65:00.0, [N/A], [N/A], 0, 24576, 10, [N/A], 405')['65:00.0'];
  assert.equal(card.temperature, null);
  assert.equal(card.power, null);
  assert.equal(card.coreClock, null);
  // The fields that DID report are still trusted.
  assert.equal(card.usage, 0);
  assert.equal(card.memClock, 405);
});

test('absent nvidia-smi is an empty map, not a throw', () => {
  assert.deepEqual(parseNvidiaSmi(''), {});
  assert.deepEqual(parseNvidiaSmi(null), {});
  assert.deepEqual(parseNvidiaSmi('\n\n'), {});
});

test('a short or malformed row is skipped rather than half-parsed', () => {
  assert.deepEqual(parseNvidiaSmi('00000000:65:00.0, 54'), {});
});

test('a card carries how much of its own memory is in use', () => {
  // Needed per-card so the memory chart can draw a line for each GPU rather
  // than only for the card inference runs on.
  const [apu, dgpu] = buildInventory([
    { card: 'card1', driver: 'nvidia', vramBytes: 24 * GIB, vramUsedBytes: 2 * GIB },
    { card: 'card2', driver: 'amdgpu', gttBytes: 128 * GIB, vramBytes: 1 * GIB, vramUsedBytes: 512 * 1024 * 1024 },
  ], SYSTEM);
  assert.equal(apu.vramUsedBytes, 512 * 1024 * 1024);
  assert.equal(dgpu.vramUsedBytes, 2 * GIB);
});

test('unmeasured memory-in-use is null, not zero', () => {
  const [gpu] = buildInventory([{ card: 'card1', driver: 'amdgpu', gttBytes: 128 * GIB }], SYSTEM);
  assert.equal(gpu.vramUsedBytes, null);
});

/*
 * PER-GPU CHART SERIES.
 *
 * Every analytics sample recorded one scalar per metric, taken from the
 * inference card, so a second GPU's temperature, power, utilisation and memory
 * were absent from every graph on the dashboard. These describe the extra
 * series a multi-card machine adds; a single-GPU machine adds none, so its
 * charts keep drawing exactly the lines they always drew.
 */

test('a single-GPU machine adds no extra series', () => {
  assert.deepEqual(resolveGpuSeries([{ card: 'card1', inference: true }]), []);
  assert.deepEqual(resolveGpuSeries([]), []);
  assert.deepEqual(resolveGpuSeries(null), []);
});

test('a multi-GPU machine gets one series per card, inference card first', () => {
  // Drakemore: the discrete card enumerates FIRST, so ordering by the array
  // would label the card that is not running the model "GPU 1".
  const series = resolveGpuSeries([
    { card: 'card1', name: 'NVIDIA GA102 [GeForce RTX 3090]', inference: false },
    { card: 'card2', name: 'AMD Device 1586', inference: true },
  ]);
  assert.equal(series.length, 2);
  assert.deepEqual(series.map((s) => s.card), ['card2', 'card1']);
  assert.deepEqual(series.map((s) => s.label), ['GPU 1', 'GPU 2']);
  // The key is what a chart uses as its dataKey and what the sample carries.
  assert.deepEqual(series.map((s) => s.key), ['gpu_card2', 'gpu_card1']);
  assert.equal(series[0].inference, true);
  assert.equal(series[1].name, 'NVIDIA GA102 [GeForce RTX 3090]');
});

test('a card memory percentage uses the pool that card actually has', () => {
  const GB = GIB;
  // An APU's usable pool is its GTT window, not the token 1 GiB VRAM carve-out;
  // reporting VRAM for it would understate the machine by two orders of
  // magnitude, exactly as the panel's formatter already avoids.
  assert.equal(gpuMemoryUsagePercent({
    kind: 'integrated', gttBytes: 100 * GB, gttUsedBytes: 25 * GB,
    vramBytes: 1 * GB, vramUsedBytes: 1 * GB,
  }), 25);
  // A discrete card has no GTT and its VRAM is the answer.
  assert.equal(gpuMemoryUsagePercent({
    kind: 'discrete', vramBytes: 24 * GB, vramUsedBytes: 6 * GB,
  }), 25);
});

test('a card nothing can measure reports null, not zero usage', () => {
  // 0% would claim the card is empty; null says we cannot see it.
  assert.equal(gpuMemoryUsagePercent({ kind: 'discrete', vramBytes: 24 * GIB }), null);
  assert.equal(gpuMemoryUsagePercent({ kind: 'discrete', vramUsedBytes: 1 * GIB }), null);
  assert.equal(gpuMemoryUsagePercent({}), null);
  assert.equal(gpuMemoryUsagePercent(null), null);
});

test('a memory percentage never exceeds 100 or goes negative', () => {
  assert.equal(gpuMemoryUsagePercent({ kind: 'discrete', vramBytes: 10, vramUsedBytes: 40 }), 100);
  assert.equal(gpuMemoryUsagePercent({ kind: 'discrete', vramBytes: 10, vramUsedBytes: -5 }), 0);
});

test('the inference card carries how much of its GTT window is in use', () => {
  // Without this the integrated card contributed NO point to the per-GPU
  // memory chart -- gpuMemoryUsagePercent reads gttUsedBytes for an APU, and
  // the field was being dropped here while gttBytes survived.
  const [apu] = buildInventory([
    { card: 'card1', driver: 'amdgpu', gttBytes: 128 * GIB, gttUsedBytes: 32 * GIB },
  ], SYSTEM);
  assert.equal(apu.gttUsedBytes, 32 * GIB);
  assert.equal(gpuMemoryUsagePercent(apu), 25);
});

test('a discrete card reports no GTT usage either, not just no GTT size', () => {
  // Leaving gttUsedBytes set while nulling gttBytes would leave a discrete card
  // claiming to consume a host-memory window it cannot address.
  const [, dgpu] = buildInventory([
    { card: 'card1', driver: 'nvidia', vramBytes: 24 * GIB, gttBytes: 256 * 1024 * 1024, gttUsedBytes: 64 * 1024 * 1024 },
    { card: 'card2', driver: 'amdgpu', gttBytes: 128 * GIB, gttUsedBytes: 8 * GIB },
  ], SYSTEM);
  assert.equal(dgpu.gttBytes, null);
  assert.equal(dgpu.gttUsedBytes, null);
});

/*
 * PER-GPU LONG-RANGE HISTORY.
 *
 * The persisted minute records held one scalar per metric, so the 1h/1d/1w
 * charts showed a single line however many cards the machine had. These find
 * the per-card fields without a hardcoded card list -- card ids differ per
 * machine, and the persisted file is append-only, so records written before a
 * card was fitted simply lack its keys.
 */

test('per-card sample keys are discovered from the samples themselves', () => {
  const points = [
    { timestamp: 1, gpu: 40, cpu: 30, gpu_card2: 40, gpu_card1: 55 },
    { timestamp: 2, gpu: 41, cpu: 31, gpu_card2: 41 },
  ];
  assert.deepEqual(perCardKeys(points).sort(), ['gpu_card1', 'gpu_card2']);
});

test('samples with no per-card fields yield no keys', () => {
  assert.deepEqual(perCardKeys([{ timestamp: 1, gpu: 40, cpu: 30 }]), []);
  assert.deepEqual(perCardKeys([]), []);
  assert.deepEqual(perCardKeys(null), []);
});

test('history records expose their per-card keys per metric prefix', () => {
  // A record written before the second card was fitted lacks its keys entirely;
  // the union across the range is what the chart must draw.
  const records = [
    { ts: 1, pwr: 10, tg: 40, pwr_card2: 10, tg_card2: 40 },
    { ts: 2, pwr: 12, tg: 42, pwr_card2: 11, tg_card2: 41, pwr_card1: 30, tg_card1: 55 },
  ];
  assert.deepEqual(historyCardKeys(records, 'pwr').sort(), ['pwr_card1', 'pwr_card2']);
  assert.deepEqual(historyCardKeys(records, 'tg').sort(), ['tg_card1', 'tg_card2']);
  assert.deepEqual(historyCardKeys(records, 'mg'), []);
});

test('a metric prefix never captures another metric that starts the same way', () => {
  // "ms" (system memory) must not be harvested as a per-card "m" series.
  const records = [{ ts: 1, ms: 20, mg: 30, mg_card1: 5 }];
  assert.deepEqual(historyCardKeys(records, 'mg'), ['mg_card1']);
  assert.deepEqual(historyCardKeys(records, 'ms'), []);
});
