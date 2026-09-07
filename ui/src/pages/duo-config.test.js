// Llama Manager — tests for the duo config panel's pure state logic.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  duoConfigSections,
  defaultDuoSettings,
  validateDuoSettings,
  acceleratorAvailability,
} from './duo-config.js';

const FROSTBURN = { threads: 16, physicalCores: 16, logicalCores: 32, threadsDerived: true, hasNvidia: false };
const DRAKEMORE = { ...FROSTBURN, hasNvidia: true };

test('the accelerator section is ABSENT on an AMD-only box, not merely disabled', () => {
  const ids = duoConfigSections(FROSTBURN).map(s => s.id);
  assert.ok(!ids.includes('accelerator'), 'a box with no NVIDIA card must not show the control at all');
});

test('the accelerator section appears where an NVIDIA card exists', () => {
  const ids = duoConfigSections(DRAKEMORE).map(s => s.id);
  assert.ok(ids.includes('accelerator'));
});

test('core sections render on every box regardless of GPU vendor', () => {
  for (const profile of [FROSTBURN, DRAKEMORE]) {
    const ids = duoConfigSections(profile).map(s => s.id);
    assert.ok(ids.includes('models'), 'models section missing');
    assert.ok(ids.includes('threads'), 'threads section missing');
  }
});

test('an unknown/absent profile degrades to the AMD-only layout rather than throwing', () => {
  assert.ok(Array.isArray(duoConfigSections(null)));
  assert.ok(!duoConfigSections(null).map(s => s.id).includes('accelerator'));
});

test('thread default follows the profile, and is never a hardcoded number', () => {
  assert.equal(defaultDuoSettings(FROSTBURN).threads, 16);
  assert.equal(defaultDuoSettings({ ...FROSTBURN, threads: 6 }).threads, 6);
});

test('accelerator defaults to OFF, and the pods agent keeps the card by default', () => {
  const s = defaultDuoSettings(DRAKEMORE);
  assert.equal(s.useAccelerator, false);
  assert.equal(s.acceleratorPriority, 'agent-first');
});

test('a box with no NVIDIA card can never have the accelerator enabled', () => {
  const r = validateDuoSettings({ threads: 16, useAccelerator: true }, FROSTBURN);
  assert.equal(r.ok, false);
  assert.match(r.error, /NVIDIA/i);
});

test('threads above the logical core count is rejected — that is the 23x cliff', () => {
  const r = validateDuoSettings({ threads: 64 }, FROSTBURN);
  assert.equal(r.ok, false);
  assert.match(r.error, /thread/i);
});

test('threads at the LOGICAL core count is warned about, since it collapses throughput', () => {
  const r = validateDuoSettings({ threads: 32 }, FROSTBURN);
  assert.equal(r.ok, true, 'the operator may still choose it');
  assert.match(r.warning, /physical|collapse|slow/i);
});

test('the physical-core count produces no warning', () => {
  const r = validateDuoSettings({ threads: 16 }, FROSTBURN);
  assert.equal(r.ok, true);
  assert.equal(r.warning, undefined);
});

test('threads below 1 is rejected', () => {
  assert.equal(validateDuoSettings({ threads: 0 }, FROSTBURN).ok, false);
});

test('accelerator availability explains WHY it is unavailable', () => {
  assert.equal(acceleratorAvailability(DRAKEMORE).available, true);
  const a = acceleratorAvailability(FROSTBURN);
  assert.equal(a.available, false);
  assert.match(a.reason, /no NVIDIA/i);
});
