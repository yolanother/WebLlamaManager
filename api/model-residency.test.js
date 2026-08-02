// Llama Manager — exact desired-model residency policy tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies durable, operator-named model residency independently from the
// size-based anti-thrash policy, including exact local identity and admission
// outcomes that occur before any model load or eviction.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  annotateModelResidency,
  modelResidencyDecision,
  modelResidencyStatus,
  modelsEligibleForUnload,
  normalizeDesiredModels,
  residencyMutationDecision,
} from './model-residency.js';

const GEMMA = 'google_gemma-4-E2B-it-qat-q4_0-gguf';

test('a desired exact model is forced local and cannot be remotely substituted', () => {
  assert.deepEqual(modelResidencyDecision({
    requestedModel: GEMMA,
    desiredModels: [GEMMA],
    loadedModels: [],
    modelsMax: 2,
    hasViableRemote: true,
  }), {
    action: 'force-local',
    reason: 'desired-model-exact-local',
    protectedModel: GEMMA,
  });
});

test('a conflicting local load is rejected before it can evict a desired resident', () => {
  assert.deepEqual(modelResidencyDecision({
    requestedModel: 'gpt-oss-120b',
    desiredModels: [GEMMA],
    loadedModels: [{ id: GEMMA }, { id: 'qwen3-8b' }],
    modelsMax: 2,
    hasViableRemote: false,
  }), {
    action: 'reject',
    reason: 'desired-resident-would-be-evicted',
    protectedModel: GEMMA,
  });
});

test('a conflicting request offloads when an exact remote mapping is viable', () => {
  assert.deepEqual(modelResidencyDecision({
    requestedModel: 'qwen3-8b',
    desiredModels: [GEMMA],
    loadedModels: [{ id: GEMMA }, { id: 'other' }],
    modelsMax: 2,
    hasViableRemote: true,
  }), {
    action: 'offload',
    reason: 'desired-resident-protected',
    protectedModel: GEMMA,
  });
});

test('a free router slot allows safe co-residence', () => {
  assert.equal(modelResidencyDecision({
    requestedModel: 'qwen3-8b',
    desiredModels: [GEMMA],
    loadedModels: [{ id: GEMMA }],
    modelsMax: 2,
    hasViableRemote: false,
  }).action, 'allow-local');
});

test('releasing all desired models restores existing routing behavior', () => {
  assert.deepEqual(modelResidencyDecision({
    requestedModel: 'gpt-oss-120b',
    desiredModels: [],
    loadedModels: [{ id: GEMMA }, { id: 'other' }],
    modelsMax: 2,
    hasViableRemote: false,
  }), {
    action: 'allow-local',
    reason: 'no-residency-conflict',
  });
});

test('readiness fails immediately when a desired model is no longer resident', () => {
  assert.deepEqual(modelResidencyStatus({
    desiredModels: [GEMMA],
    loadedModels: [],
  }), {
    ready: false,
    desiredModels: [{ model: GEMMA, desired: true, loaded: false }],
    missingModels: [GEMMA],
  });
});

test('desired model configuration trims and deduplicates exact identifiers', () => {
  assert.deepEqual(normalizeDesiredModels([
    ` ${GEMMA} `,
    GEMMA,
    'qwen3-8b',
  ], { modelsMax: 2 }), [GEMMA, 'qwen3-8b']);
});

test('memory recovery never selects desired residents for unload', () => {
  assert.deepEqual(modelsEligibleForUnload([
    { id: GEMMA, status: { value: 'loaded' } },
    { id: 'other', status: { value: 'loaded' } },
    { id: 'gpt-oss-120b', status: { value: 'loaded' } },
  ], {
    keepModel: 'gpt-oss-120b',
    desiredModels: [GEMMA],
  }).map((model) => model.id), ['other']);
});

test('integration: protected Gemma rejects gpt-oss-120b before eviction', () => {
  const loadedModels = [{ id: GEMMA }, { id: 'qwen3-8b' }];
  const decision = modelResidencyDecision({
    requestedModel: 'Unsloth_gpt-oss-120b-GGUF_Q5_K_M_gpt-oss-120b-Q5_K_M',
    desiredModels: [GEMMA],
    loadedModels,
    modelsMax: 2,
    hasViableRemote: false,
  });

  assert.equal(decision.action, 'reject');
  assert.equal(decision.protectedModel, GEMMA);
  assert.equal(loadedModels.some((model) => model.id === GEMMA), true);
});

test('model catalog marks the concrete target and its alias from live target state', () => {
  const catalog = annotateModelResidency([
    { id: GEMMA, status: 'loaded' },
    { id: 'realtime-gemma', status: 'alias', aliasTarget: GEMMA },
  ], [GEMMA]);

  assert.deepEqual(catalog.map((entry) => entry.residency), [
    { desired: true, ready: true, target: GEMMA },
    { desired: true, ready: true, target: GEMMA },
  ]);
});

test('manual unload cannot remove a desired resident until the declaration is released', () => {
  assert.deepEqual(residencyMutationDecision({
    removedModels: [GEMMA],
    desiredModels: [GEMMA],
  }), {
    allowed: false,
    protectedModel: GEMMA,
  });
  assert.deepEqual(residencyMutationDecision({
    removedModels: [GEMMA],
    desiredModels: [],
  }), { allowed: true });
});

test('single-model activation cannot replace a different desired resident', () => {
  assert.deepEqual(residencyMutationDecision({
    removedModels: [GEMMA],
    replacementModel: 'qwen3-8b',
    desiredModels: [GEMMA],
  }), {
    allowed: false,
    protectedModel: GEMMA,
  });
  assert.deepEqual(residencyMutationDecision({
    removedModels: [GEMMA],
    replacementModel: GEMMA,
    desiredModels: [GEMMA],
  }), { allowed: true });
});
