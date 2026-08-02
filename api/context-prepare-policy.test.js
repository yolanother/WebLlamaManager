// Llama Manager — contract tests for prepared-context admission policy.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies that counting and prefilling a prepared context can be requested in
// an explicit fail-closed resident-only mode, that admission is re-verified
// after the local lane is acquired so a model swap cannot be certified, that a
// maintenance priority can never displace realtime inference, and that the
// public prepared-context record carries versioned contract metadata.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONTEXT_PREPARE_PRIORITIES,
  contextPrepareAdmission,
  contextPrepareEngineDecision,
  normalizeContextPreparePriority,
  resolveContextResidency,
} from './context-prepare-policy.js';
import { CONTEXT_CACHE_CONTRACT_VERSION, PreparedContextStore } from './context-cache.js';
import { PriorityRequestQueue } from './request-queue.js';

test('prepared-context priorities exclude realtime so maintenance can never claim the latency class', () => {
  assert.deepEqual([...CONTEXT_PREPARE_PRIORITIES], ['interactive', 'background']);
  assert.equal(normalizeContextPreparePriority(undefined), 'interactive');
  assert.equal(normalizeContextPreparePriority(''), 'interactive');
  assert.equal(normalizeContextPreparePriority('BACKGROUND'), 'background');

  assert.throws(
    () => normalizeContextPreparePriority('realtime'),
    error => error instanceof TypeError && error.code === 'CONTEXT_PREPARE_INVALID_PRIORITY',
  );
  assert.throws(() => normalizeContextPreparePriority('urgent'), TypeError);
  assert.throws(() => normalizeContextPreparePriority(3), TypeError);
});

test('resident-only is explicit, fail-closed, and always implied by background priority', () => {
  assert.deepEqual(
    resolveContextResidency({ mode: 'count', priority: 'interactive', residentOnly: true }),
    { residentOnly: true, source: 'explicit' },
  );
  assert.deepEqual(
    resolveContextResidency({ mode: 'count', priority: 'interactive', residentOnly: true, allowModelLoad: true }),
    { residentOnly: true, source: 'explicit' },
    'the legacy load opt-out must never defeat an explicit resident-only request',
  );
  assert.deepEqual(
    resolveContextResidency({ mode: 'count', priority: 'background', residentOnly: false, allowModelLoad: true }),
    { residentOnly: true, source: 'background_priority' },
    'background maintenance work must never load or evict a model',
  );
});

test('legacy prepare defaults are preserved but never silently upgraded', () => {
  assert.deepEqual(
    resolveContextResidency({ mode: 'count', priority: 'interactive' }),
    { residentOnly: false, source: 'legacy_default' },
  );
  assert.deepEqual(
    resolveContextResidency({ mode: 'prefill', priority: 'interactive' }),
    { residentOnly: true, source: 'legacy_prefill_default' },
  );
  assert.deepEqual(
    resolveContextResidency({ mode: 'prefill', priority: 'interactive', allowModelLoad: true }),
    { residentOnly: false, source: 'legacy_allow_model_load' },
  );
  assert.deepEqual(
    resolveContextResidency({ mode: 'count', priority: 'interactive', residentOnly: false }),
    { residentOnly: false, source: 'explicit' },
  );
});

test('a nonresident count under resident-only is skipped instead of loading the model', () => {
  const decision = contextPrepareAdmission({
    mode: 'count',
    engine: 'llama',
    slotOperationsSupported: true,
    residentOnly: true,
    isResident: false,
  });

  assert.equal(decision.decision, 'skip');
  assert.equal(decision.status, 'skipped');
  assert.equal(decision.httpStatus, 200);
  assert.equal(decision.preparationOutcome, 'model_not_resident');
});

test('a nonresident count under the legacy default is still admitted for compatibility', () => {
  const decision = contextPrepareAdmission({
    mode: 'count',
    engine: 'llama',
    slotOperationsSupported: true,
    residentOnly: false,
    isResident: false,
  });

  assert.equal(decision.decision, 'admit');
  assert.equal(decision.status, 'ready');
  assert.equal(decision.httpStatus, 201);
});

test('post-admission residency loss is reported as a distinct model-swap outcome', () => {
  const preflight = contextPrepareAdmission({
    mode: 'prefill',
    engine: 'llama',
    slotOperationsSupported: true,
    residentOnly: true,
    isResident: true,
  });
  assert.equal(preflight.decision, 'admit');
  assert.equal(preflight.status, 'queued');
  assert.equal(preflight.httpStatus, 202);

  const afterSwap = contextPrepareAdmission({
    mode: 'prefill',
    engine: 'llama',
    slotOperationsSupported: true,
    residentOnly: true,
    isResident: false,
    stage: 'post_admission',
  });
  assert.equal(afterSwap.decision, 'skip');
  assert.equal(afterSwap.status, 'skipped');
  assert.equal(afterSwap.preparationOutcome, 'model_no_longer_resident');
  assert.notEqual(afterSwap.preparationOutcome, preflight.preparationOutcome);
});

test('a concrete child that lost slot operations after admission is reported unsupported', () => {
  const decision = contextPrepareAdmission({
    mode: 'prefill',
    engine: 'llama',
    slotOperationsSupported: false,
    residentOnly: true,
    isResident: true,
    stage: 'post_admission',
  });

  assert.equal(decision.decision, 'unsupported');
  assert.equal(decision.code, 'CONTEXT_PREFILL_UNSUPPORTED');
  assert.equal(decision.httpStatus, 501);
});

test('unsupported engines refuse preparation before any residency or slot probe', () => {
  const ds4 = contextPrepareAdmission({ mode: 'count', engine: 'ds4' });
  assert.equal(ds4.decision, 'unsupported');
  assert.equal(ds4.code, 'CONTEXT_PREPARE_UNSUPPORTED');
  assert.equal(ds4.httpStatus, 501);
  assert.equal(ds4.status, 'unsupported');

  const missing = contextPrepareAdmission({ mode: 'count', engine: null });
  assert.equal(missing.decision, 'unsupported');
  assert.equal(missing.code, 'CONTEXT_PREPARE_UNSUPPORTED');
});

test('the engine gate is decidable on its own so prefill is not refused before its slot probe', () => {
  assert.equal(contextPrepareEngineDecision('llama'), null);

  const ds4 = contextPrepareEngineDecision('ds4');
  assert.equal(ds4.decision, 'unsupported');
  assert.equal(ds4.code, 'CONTEXT_PREPARE_UNSUPPORTED');
  assert.equal(ds4.httpStatus, 501);
  assert.match(ds4.message, /ds4/);
  assert.equal(contextPrepareEngineDecision(null).code, 'CONTEXT_PREPARE_UNSUPPORTED');

  // The gate must not depend on mode: a prefill on llama has to survive it and
  // reach the slot-capability probe rather than being pre-emptively refused.
  assert.equal(contextPrepareEngineDecision('llama'), null);
});

test('realtime work arriving during background preparation preempts and cancels it', async () => {
  const queue = new PriorityRequestQueue(1);
  const controller = new AbortController();
  const priority = normalizeContextPreparePriority('background');

  const prepareId = await queue.acquire({
    model: 'gemma-4',
    endpoint: 'context/prepare',
    priority,
    onPreempt: reason => controller.abort(reason),
  });
  assert.equal(controller.signal.aborted, false);

  const realtime = queue.acquire({ model: 'gemma-4', endpoint: 'chat', priority: 'realtime' });
  assert.equal(controller.signal.aborted, true, 'realtime arrival must cancel prepared-context work');
  assert.equal(String(controller.signal.reason), 'realtime_request');
  assert.equal(queue.active, 1, 'the serialized lane must never be over-subscribed while cancelling');

  queue.release(prepareId);
  const realtimeId = await realtime;
  queue.release(realtimeId);
  assert.equal(queue.active, 0);
});

test('background prepared-context admission stays bounded and cancellable', async () => {
  const queue = new PriorityRequestQueue(1, { maxBackgroundQueued: 1 });
  const holderId = await queue.acquire({ model: 'gemma-4', endpoint: 'chat', priority: 'interactive' });

  const queued = queue.acquire({ model: 'gemma-4', endpoint: 'context/prepare', priority: 'background' });
  const overflow = await queue.acquire({ model: 'gemma-4', endpoint: 'context/prepare', priority: 'background' })
    .then(() => null, error => error);
  assert.equal(overflow.code, 'BACKGROUND_QUEUE_FULL');
  assert.equal(overflow.statusCode, 429);

  const queuedId = queue.getItems().find(item => item.status === 'pending').id;
  assert.equal(queue.cancel(queuedId), true);
  await assert.rejects(queued, /cancelled/i);
  queue.release(holderId);
});

test('every public prepared record carries the canonical contract version and both model names', () => {
  const store = new PreparedContextStore();
  const created = store.create({
    scopeId: 'scope_test',
    requestedModel: 'default-big',
    resolvedModel: 'gemma-4-27b-it-q4',
    engine: 'llama',
    mode: 'count',
    status: 'ready',
    inputTokens: 4211,
    priority: 'background',
    residentOnly: true,
    preparationOutcome: 'counted',
    capabilities: { exact_count: true, exact_render: true, kv_prefill: true },
  });

  assert.equal(created.contextCacheContract, CONTEXT_CACHE_CONTRACT_VERSION);
  assert.equal(created.requestedModel, 'default-big');
  assert.equal(created.resolvedModel, 'gemma-4-27b-it-q4');
  assert.notEqual(created.requestedModel, created.resolvedModel);
  assert.equal(created.engine, 'llama');
  assert.equal(created.mode, 'count');
  assert.equal(created.status, 'ready');
  assert.equal(created.inputTokens, 4211);
  assert.equal(created.capabilities.exact_count, true);
  assert.equal(created.priority, 'background');
  assert.equal(created.residentOnly, true);
  assert.equal(created.preparationOutcome, 'counted');
  assert.equal(created.scopeId, undefined);

  assert.equal(store.get(created.id, 'scope_test').contextCacheContract, CONTEXT_CACHE_CONTRACT_VERSION);
  assert.equal(store.list('scope_test')[0].contextCacheContract, CONTEXT_CACHE_CONTRACT_VERSION);
  assert.equal(
    store.update(created.id, 'scope_test', { status: 'invalidated' }).contextCacheContract,
    CONTEXT_CACHE_CONTRACT_VERSION,
  );
});
