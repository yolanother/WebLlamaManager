// Llama Manager — tests for the protect-resident offload policy.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectResidentDecision, DEFAULT_PROTECT_MIN_BYTES } from './protect-resident.js';

const GB = 1024 * 1024 * 1024;
const big = (id, gb = 65) => ({ id, sizeBytes: gb * GB }); // e.g. gpt-oss-120b
const small = (id, gb = 5) => ({ id, sizeBytes: gb * GB }); // e.g. an 8b

// Baseline args representing "a 120b is resident, both slots full, request is for a
// different model that a remote can serve" — the case we MUST offload.
const baseFull = {
  requestedModel: 'qwen3-8b',
  loadedModels: [big('gpt-oss-120b'), small('other-8b')],
  modelsMax: 2,
  hasViableRemote: true,
};

test('offloads when a protected model is resident, slots are full, and a remote can serve', () => {
  const d = protectResidentDecision(baseFull);
  assert.equal(d.offload, true);
  assert.match(d.reason, /protect-resident/);
});

test('does NOT offload when the policy is disabled', () => {
  const d = protectResidentDecision({ ...baseFull, enabled: false });
  assert.equal(d.offload, false);
  assert.equal(d.reason, 'policy-disabled');
});

test('does NOT offload when the requested model is already resident', () => {
  const d = protectResidentDecision({ ...baseFull, requestedModel: 'gpt-oss-120b' });
  assert.equal(d.offload, false);
  assert.equal(d.reason, 'already-resident');
});

test('does NOT offload when no remote backend can serve the request (serve local)', () => {
  const d = protectResidentDecision({ ...baseFull, hasViableRemote: false });
  assert.equal(d.offload, false);
  assert.equal(d.reason, 'no-remote');
});

test('does NOT offload when no resident model is large enough to protect', () => {
  const d = protectResidentDecision({
    ...baseFull,
    loadedModels: [small('a-8b'), small('b-8b')], // both small, both slots full
  });
  assert.equal(d.offload, false);
  assert.equal(d.reason, 'no-protected-resident');
});

test('co-residence: does NOT offload when a free slot lets the model load without eviction', () => {
  const d = protectResidentDecision({
    ...baseFull,
    loadedModels: [big('gpt-oss-120b')], // only 1 of 2 slots used → free slot
  });
  assert.equal(d.offload, false);
  assert.equal(d.reason, 'free-slot-fits');
});

test('a request FOR a big model (not resident) is served local, not offloaded', () => {
  // loaded = two small models, full; requested is the 120b which has no real remote anyway,
  // but even with hasViableRemote true we must run the big model locally (nothing to protect).
  const d = protectResidentDecision({
    requestedModel: 'gpt-oss-120b',
    loadedModels: [small('a-8b'), small('b-8b')],
    modelsMax: 2,
    hasViableRemote: true,
  });
  assert.equal(d.offload, false);
  assert.equal(d.reason, 'no-protected-resident');
});

test('protect threshold is configurable (lower threshold protects mid-size models)', () => {
  const d = protectResidentDecision({
    requestedModel: 'qwen3-8b',
    loadedModels: [small('mid-30b', 30), small('other-8b')],
    modelsMax: 2,
    hasViableRemote: true,
    protectMinBytes: 20 * GB, // now the 30b counts as protected
  });
  assert.equal(d.offload, true);
  assert.match(d.reason, /protect-resident:mid-30b/);
});

test('DEFAULT_PROTECT_MIN_BYTES is a sane large-model threshold (≈40GB)', () => {
  assert.equal(DEFAULT_PROTECT_MIN_BYTES, 40 * GB);
});
