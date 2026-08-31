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
