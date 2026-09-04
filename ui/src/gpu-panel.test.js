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
import { resolveGpuPanel, formatGpuMemory, resolveGpuRings } from './gpu-panel.js';

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

/*
 * AN APERTURE FIGURE IS AN ESTIMATE, AND MUST SAY SO (A3).
 *
 * When no vendor tool can size a discrete card, A1 falls back to the largest
 * prefetchable PCI BAR. Drakemore's 24 GiB RTX 3090 exposes a 32 GiB resizable
 * BAR, so an unqualified "32 GB" is a number an operator would size a model
 * against and be wrong by 8 GiB. Every other source is a real measurement and
 * must NOT be hedged -- a qualifier on a figure that is exact is its own kind of
 * lie.
 */
const NVIDIA_APERTURE = {
  card: 'card1', name: 'NVIDIA GA102 [GeForce RTX 3090]', driver: 'nouveau',
  kind: 'discrete', inference: false, available: true, reason: '',
  vramBytes: 32 * GIB, vramSource: 'aperture', gttBytes: null, systemBytes: null,
  temperature: null, usage: null, power: null,
};

test('an aperture-derived size is rendered as an estimate, not a measurement', () => {
  const detail = formatGpuMemory(NVIDIA_APERTURE);
  assert.match(detail, /32 GB/);
  assert.match(detail, /estimate/i, 'the figure must carry its own qualifier');
  assert.match(detail, /^~/, 'and read as approximate at a glance');
});

test('a size a vendor tool measured is NOT hedged', () => {
  const measured = { ...NVIDIA_APERTURE, vramSource: 'nvidia-smi', vramBytes: 24 * GIB };
  assert.equal(formatGpuMemory(measured), '24 GB');
  const sysfs = { ...NVIDIA_APERTURE, vramSource: 'sysfs', vramBytes: 24 * GIB };
  assert.equal(formatGpuMemory(sysfs), '24 GB');
  // A pre-A1 payload has no vramSource at all and must not suddenly read as an estimate.
  const legacy = { ...NVIDIA_APERTURE, vramSource: undefined, vramBytes: 24 * GIB };
  assert.equal(formatGpuMemory(legacy), '24 GB');
});

test("the APU's GTT pool is never labelled an estimate by a stray vramSource", () => {
  // vramSource describes vramBytes. The integrated card reports its usable pool
  // from GTT, so an 'aperture' tag on its unused VRAM carve-out must not leak in.
  const apu = { ...IGPU, vramSource: 'aperture' };
  assert.equal(formatGpuMemory(apu), '120 GB');
});

test('a vendor-named card keeps the name the backend resolved', () => {
  const view = resolveGpuPanel({ gpus: [IGPU, NVIDIA_APERTURE] });
  assert.equal(view.additional.length, 1);
  // Identical to what the kiosk panel shows -- A4 locks the two together, so
  // this must not be prettified here.
  assert.equal(view.additional[0].title, 'NVIDIA GA102 [GeForce RTX 3090]');
});

test('the bound driver is on the card, because nouveau vs nvidia is the whole question', () => {
  const view = resolveGpuPanel({ gpus: [IGPU, NVIDIA_APERTURE] });
  assert.equal(view.additional[0].driver, 'nouveau');
});

test('an estimate carries an explanation for the reader who hovers it', () => {
  const view = resolveGpuPanel({ gpus: [IGPU, NVIDIA_APERTURE] });
  const card = view.additional[0];
  assert.match(card.detail, /estimate/i);
  assert.ok(card.detailTitle, 'an estimate must explain itself');
  assert.match(card.detailTitle, /aperture|no vendor tool/i);
});

test('a measured card carries no explanation, because there is nothing to explain', () => {
  const view = resolveGpuPanel({ gpus: [IGPU, { ...DGPU, vramSource: 'sysfs' }] });
  assert.equal(view.additional[0].detail, '24 GB');
  assert.equal(view.additional[0].detailTitle, null);
});

/*
 * The unavailable-reason > size > reason precedence A1's panel established is
 * extended here, not replaced: a card the kernel never bound has nothing useful
 * to say about its memory, estimate or not.
 */
test('an unusable card still leads with its reason, not with an estimate', () => {
  const unbound = { ...NVIDIA_APERTURE, available: false, driver: '', reason: 'no kernel driver is bound to it' };
  const view = resolveGpuPanel({ gpus: [IGPU, unbound] });
  assert.equal(view.additional[0].detail, 'no kernel driver is bound to it');
});

/*
 * THE STATS-RAIL GAUGE.
 *
 * The rail used to show one ring for the inference card and label it "1/2",
 * which said "you are looking at card 1 of 2" -- true, and useless: the second
 * card's load was nowhere on the rail. One concentric ring per GPU shows every
 * card at once, outermost first, so a busy second card is visible without
 * opening the dashboard.
 */

// Drakemore's real shape: the discrete card enumerates FIRST, and nouveau
// publishes no utilisation counter for it.
const RINGS_APU = {
  card: 'card2', name: 'AMD Device 1586', kind: 'integrated', inference: true,
  available: true, driver: 'amdgpu', usage: 99,
};
const RINGS_3090 = {
  card: 'card1', name: 'NVIDIA GA102 [GeForce RTX 3090]', kind: 'discrete',
  inference: false, available: true, driver: 'nouveau', usage: null,
};

test('a single-GPU machine gets exactly one ring and no count in the label', () => {
  const view = resolveGpuRings({ gpus: [IGPU] });
  assert.equal(view.rings.length, 1);
  assert.equal(view.rings[0].value, 22);
  assert.equal(view.label, 'GPU');
});

test('an older API with no gpus[] still gets one ring from the headline figure', () => {
  // An appliance whose manager predates gpus[] must not render a bare tile.
  for (const stats of [{}, { gpus: [] }, { gpus: null }]) {
    const view = resolveGpuRings({ ...stats, gpu: { usage: 41 } });
    assert.equal(view.rings.length, 1);
    assert.equal(view.rings[0].value, 41);
    assert.equal(view.label, 'GPU');
  }
});

test('every GPU gets its own ring, inference card outermost', () => {
  const view = resolveGpuRings({ gpus: [RINGS_3090, RINGS_APU] });
  assert.equal(view.rings.length, 2);
  // Outermost is the card inference runs on, NOT the first in DRM order.
  assert.equal(view.rings[0].card, 'card2');
  assert.equal(view.rings[0].value, 99);
  assert.equal(view.rings[1].card, 'card1');
});

test('a card with no utilisation counter draws a track but no fill', () => {
  // nouveau reports nothing. A 0% fill would assert the 3090 is idle; a null
  // value renders the track alone, which reads as "present, unmeasured".
  const view = resolveGpuRings({ gpus: [RINGS_3090, RINGS_APU] });
  assert.equal(view.rings[1].value, null);
  assert.match(view.rings[1].title, /RTX 3090/);
  assert.match(view.rings[1].title, /no utilisation/i);
});

test('the label counts the cards rather than claiming to show one of them', () => {
  const view = resolveGpuRings({ gpus: [RINGS_3090, RINGS_APU] });
  // "1/2" said "card 1 of 2", which stopped being true once both are drawn.
  assert.equal(view.label, 'GPU ×2');
  assert.match(view.title, /AMD Device 1586/);
  assert.match(view.title, /RTX 3090/);
});

test('an unavailable card still gets a ring, so a dead card is not invisible', () => {
  const dead = { ...RINGS_3090, available: false, usage: null, reason: 'no kernel driver is bound to it' };
  const view = resolveGpuRings({ gpus: [dead, RINGS_APU] });
  assert.equal(view.rings.length, 2);
  assert.equal(view.rings[1].value, null);
  assert.match(view.rings[1].title, /no kernel driver/);
});
