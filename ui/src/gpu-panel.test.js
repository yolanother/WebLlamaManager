// Llama Manager — additional-GPU panel view model tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests specify that a single-GPU machine renders exactly as it did
// before gpus[] existed, that a second card is surfaced without ever being
// mistaken for the one inference runs on, and that a card nothing can size is
// shown with its reason rather than as zero or dropped.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGpuPanel, formatGpuMemory } from './gpu-panel.js';

const GIB = 1024 ** 3;

const IGPU = {
  card: 'card1', name: 'Radeon 8060S', kind: 'integrated', inference: true,
  available: true, reason: '', vramBytes: 1 * GIB, gttBytes: 120 * GIB,
  systemBytes: 128 * GIB, temperature: 49, usage: 22, power: 38,
};
const DGPU = {
  card: 'card0', name: 'Radeon RX 7900', kind: 'discrete', inference: false,
  available: true, reason: '', vramBytes: 24 * GIB, gttBytes: null,
  systemBytes: null, temperature: 71, usage: 0, power: 260,
};

/*
 * THE REGRESSION GUARD. Almost every appliance has one GPU. If this panel
 * changes anything for them -- a heading, a card count, extra chrome -- the
 * feature has cost far more than it gave.
 */
test('a single-GPU machine is presented exactly as before', () => {
  const view = resolveGpuPanel({ gpus: [IGPU] });
  assert.equal(view.showAdditional, false);
  assert.deepEqual(view.additional, []);
  assert.equal(view.label, null, 'no per-card heading on a one-GPU box');
  assert.equal(view.count, 1);
});

test('no gpus[] at all (an older API) is treated as single-GPU, not as broken', () => {
  for (const stats of [{}, { gpus: undefined }, { gpus: [] }, { gpus: null }]) {
    const view = resolveGpuPanel(stats);
    assert.equal(view.showAdditional, false);
    assert.deepEqual(view.additional, []);
  }
});

test('a second card is listed, and the inference card is never in that list', () => {
  const view = resolveGpuPanel({ gpus: [IGPU, DGPU] });
  assert.equal(view.showAdditional, true);
  assert.equal(view.count, 2);
  assert.equal(view.additional.length, 1);
  assert.equal(view.additional[0].card, 'card0');
  assert.equal(view.label, 'Radeon 8060S', 'the panel names the card inference runs on');
  assert.ok(!view.additional.some((g) => g.inference), 'the inference card must not be duplicated');
});

test('an unavailable card is listed, marked, and carries its reason', () => {
  const dead = { ...DGPU, available: false, vramBytes: null,
    reason: 'no kernel driver is bound to it, so it cannot be used and its memory size is unknown' };
  const view = resolveGpuPanel({ gpus: [IGPU, dead] });
  assert.equal(view.additional.length, 1, 'a card that cannot be used is still a card');
  assert.equal(view.additional[0].available, false);
  assert.match(view.additional[0].detail, /no kernel driver/);
});

test('an unmeasurable size shows the reason, never 0 B', () => {
  const unknown = { ...DGPU, vramBytes: null,
    reason: 'no driver or vendor tool on this machine reports its memory size' };
  const view = resolveGpuPanel({ gpus: [IGPU, unknown] });
  assert.doesNotMatch(view.additional[0].detail, /\b0 B\b/);
  assert.match(view.additional[0].detail, /reports its memory size/);
});

test('memory formatting prefers the pool that card actually has', () => {
  // The iGPU's usable pool is GTT, not its 1 GiB carve-out.
  assert.match(formatGpuMemory(IGPU), /120/);
  // A discrete card has no GTT; its VRAM is the answer.
  assert.match(formatGpuMemory(DGPU), /24/);
  assert.equal(formatGpuMemory({ vramBytes: null, gttBytes: null }), null);
});

test('a card with no name still renders identifiably', () => {
  const view = resolveGpuPanel({ gpus: [IGPU, { ...DGPU, name: '' }] });
  assert.ok(view.additional[0].title.length > 0, 'never renders an empty heading');
  // The DRM node is kept so two unnamed cards stay distinguishable, but it is
  // not the whole label -- "card0" alone tells the operator nothing.
  assert.match(view.additional[0].title, /card0/);
  assert.match(view.additional[0].title, /Discrete GPU/);
});

test('an unnamed inference card gets a meaningful heading, not just its node', () => {
  // This appliance's own iGPU publishes no product_name.
  const view = resolveGpuPanel({ gpus: [{ ...IGPU, name: '' }, DGPU] });
  assert.match(view.label, /Integrated GPU/);
  assert.notEqual(view.label, 'card1');
});
