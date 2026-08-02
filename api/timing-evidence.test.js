// Llama Manager — contract tests for versioned request timing evidence.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies that per-request timing evidence binds one concrete resolved model
// and contract revision, keeps tokenization and prefill separately measured,
// classifies cold/warm/persona-change/eviction/cancelled/unsupported outcomes,
// types every unmeasurable dimension with an explicit reason instead of a
// synthesized zero, and never carries prompt text or credentials.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTEXT_CACHE_CONTRACT_VERSION } from './context-cache.js';
import {
  TIMING_EVIDENCE_VERSION,
  TIMING_EVIDENCE_PROFILES,
  TIMING_UNSUPPORTED_REASONS,
  TimingEvidenceRecorder,
  classifyCacheOutcome,
  createRequestTimingRecorder,
  monotonicClockMs,
  tokenizerRevision,
} from './timing-evidence.js';

/** Build a deterministic controllable clock for recorder tests. */
function fakeClock() {
  const state = { t: 0 };
  const clock = () => state.t;
  clock.advance = ms => { state.t += ms; return state.t; };
  clock.state = state;
  return clock;
}

/** Baseline identity for a llama.cpp-served generation request. */
const IDENTITY = Object.freeze({
  requestedModel: 'default',
  resolvedModel: 'gemma-4-27b',
  engine: 'llama',
  engineRevision: 'b9820',
  modelRevision: 'sha256:1f2e3d',
  tokenizerRevision: 'tok_9ab1',
  priority: 'realtime',
  routingPolicy: 'local_only',
});

/**
 * Drive a recorder through a complete generation lifecycle.
 *
 * @param {object} [overrides] Optional cache/engine overrides.
 * @returns {object} The built public evidence record.
 */
function generationRecord({
  cachedTokens = 0,
  priorCachedTokens = null,
  reloaded = false,
  cacheHitKind = 'none',
  engineTimings = { promptMs: 180, predictedMs: 400, promptN: 812, cacheN: 0 },
} = {}) {
  const clock = fakeClock();
  const recorder = new TimingEvidenceRecorder({
    requestId: 'req_test_1',
    profile: TIMING_EVIDENCE_PROFILES.GENERATION,
    clock,
    wallClock: () => new Date('2026-08-02T00:00:00.000Z'),
  });
  recorder.setIdentity(IDENTITY);
  recorder.mark('received');
  clock.advance(12);
  recorder.mark('admitted');
  recorder.mark('tokenization_started');
  clock.advance(4);
  recorder.mark('tokenization_completed');
  recorder.mark('prefill_started');
  clock.advance(180);
  recorder.mark('prefill_completed');
  recorder.mark('inference_started');
  clock.advance(20);
  recorder.mark('first_content');
  recorder.setTokenAccounting({
    exactInputTokens: 812,
    cachedTokens,
    source: 'exact_input_tokens_endpoint',
  });
  recorder.setCacheSignals({ cacheHitKind, reloaded, priorCachedTokens });
  if (engineTimings) recorder.setEngineTimings(engineTimings);
  return recorder.build();
}

test('the record is versioned and bound to the context-cache contract revision', () => {
  const record = generationRecord();
  assert.equal(record.object, 'llama_manager.timing_evidence');
  assert.equal(record.timing_evidence_version, TIMING_EVIDENCE_VERSION);
  assert.equal(record.context_cache_contract, CONTEXT_CACHE_CONTRACT_VERSION);
  assert.equal(record.profile, TIMING_EVIDENCE_PROFILES.GENERATION);
});

test('the record binds request, model, engine, tokenizer, priority, and routing identity', () => {
  const record = generationRecord({ cachedTokens: 700, priorCachedTokens: 700, cacheHitKind: 'affinity' });
  assert.equal(record.request_id, 'req_test_1');
  assert.deepEqual(record.identity, {
    requested_model: 'default',
    resolved_model: 'gemma-4-27b',
    certified_model: 'gemma-4-27b',
    engine: 'llama',
    engine_revision: 'b9820',
    model_revision: 'sha256:1f2e3d',
    tokenizer_revision: 'tok_9ab1',
    priority: 'realtime',
    routing_policy: 'local_only',
    model_swap_detected: false,
  });
  assert.equal(record.cache.hit_kind, 'affinity');
});

test('durations are milliseconds derived only from the injected monotonic clock', () => {
  const record = generationRecord();
  assert.equal(record.clocks.unit, 'milliseconds');
  assert.equal(record.clocks.monotonic_source, 'injected');
  assert.equal(record.clocks.started_at, '2026-08-02T00:00:00.000Z');
  assert.equal(record.manager_observed.queue_wait.ms, 12);
  assert.equal(record.manager_observed.tokenization.ms, 4);
  assert.equal(record.manager_observed.prefill.ms, 180);
  assert.equal(record.manager_observed.inference_start.ms, 196);
  assert.equal(record.manager_observed.first_content.ms, 216);
});

test('manager-observed and client-observed first-token latency stay separate', () => {
  const clock = fakeClock();
  const recorder = new TimingEvidenceRecorder({
    requestId: 'req_ttft',
    profile: TIMING_EVIDENCE_PROFILES.GENERATION,
    clock,
  });
  recorder.setIdentity(IDENTITY);
  recorder.mark('received');
  clock.advance(5);
  recorder.mark('first_content');
  const withoutClient = recorder.build();
  assert.equal(withoutClient.client_observed.first_token.supported, false);
  assert.equal(
    withoutClient.client_observed.first_token.reason,
    TIMING_UNSUPPORTED_REASONS.CLIENT_CLOCK_NOT_REPORTED,
  );

  recorder.setClientObservedFirstTokenMs(41.5);
  const withClient = recorder.build();
  assert.equal(withClient.client_observed.first_token.ms, 41.5);
  assert.equal(withClient.client_observed.first_token.origin, 'client_wall_clock');
  assert.equal(withClient.manager_observed.first_content.ms, 5);
  assert.equal(withClient.manager_observed.first_content.origin, 'manager_monotonic');
});

test('unmeasured dimensions are typed unsupported and never synthesized as zero', () => {
  const clock = fakeClock();
  const recorder = new TimingEvidenceRecorder({
    requestId: 'req_partial',
    profile: TIMING_EVIDENCE_PROFILES.GENERATION,
    clock,
  });
  recorder.setIdentity(IDENTITY);
  recorder.mark('received');
  clock.advance(9);
  recorder.mark('admitted');
  recorder.mark('prefill_started');
  clock.advance(50);
  recorder.mark('prefill_completed');
  const record = recorder.build();

  assert.equal(record.manager_observed.tokenization.supported, false);
  assert.equal(record.manager_observed.tokenization.reason, TIMING_UNSUPPORTED_REASONS.MARK_MISSING);
  assert.equal('ms' in record.manager_observed.tokenization, false);
  assert.equal(record.manager_observed.prefill.ms, 50);
  assert.equal(record.complete, false);
});

test('tokenization is never inferred from prefill or an aggregate queue counter', () => {
  const record = generationRecord({ engineTimings: { promptMs: 180, predictedMs: 400, promptN: 812, cacheN: 0 } });
  // Engine prompt timing measures prefill only; tokenization is not derivable.
  assert.equal(record.engine_reported.prefill.ms, 180);
  assert.equal(record.engine_reported.prefill.source, 'llama_cpp_timings.prompt_ms');
  assert.equal(record.engine_reported.tokenization.supported, false);
  assert.equal(
    record.engine_reported.tokenization.reason,
    TIMING_UNSUPPORTED_REASONS.ENGINE_DOES_NOT_SEPARATE_TOKENIZATION,
  );
  // Manager tokenization is its own discrete measurement, not prefill minus anything.
  assert.notEqual(record.manager_observed.tokenization.ms, record.manager_observed.prefill.ms);
  assert.equal(record.manager_observed.tokenization.source, 'manager_measured_tokenization_call');
});

test('overlapping tokenization and prefill intervals invalidate the record', () => {
  const clock = fakeClock();
  const recorder = new TimingEvidenceRecorder({
    requestId: 'req_overlap',
    profile: TIMING_EVIDENCE_PROFILES.PREFILL,
    clock,
  });
  recorder.setIdentity(IDENTITY);
  recorder.mark('received');
  recorder.mark('admitted');
  recorder.mark('tokenization_started');
  recorder.mark('prefill_started');
  clock.advance(10);
  recorder.mark('tokenization_completed');
  clock.advance(5);
  recorder.mark('prefill_completed');
  const record = recorder.build();
  assert.equal(record.complete, false);
  assert.ok(record.incomplete_reasons.includes(TIMING_UNSUPPORTED_REASONS.OVERLAPPING_TOKENIZATION_AND_PREFILL));
});

test('lifecycle marks must be recorded in contract order', () => {
  const recorder = new TimingEvidenceRecorder({ requestId: 'req_order', profile: TIMING_EVIDENCE_PROFILES.GENERATION });
  recorder.mark('received');
  recorder.mark('prefill_started');
  assert.throws(() => recorder.mark('admitted'), /order/i);
  assert.throws(() => recorder.mark('received'), /already/i);
  assert.throws(() => recorder.mark('not_a_phase'), /unknown/i);
});

test('cached and exact input token accounting must reconcile with the tokenizer contract', () => {
  const good = generationRecord({ cachedTokens: 700 });
  assert.deepEqual(good.cache.token_accounting, {
    exact_input_tokens: 812,
    cached_tokens: 700,
    new_tokens: 112,
    reconciled: true,
    source: 'exact_input_tokens_endpoint',
    tokenizer_revision: 'tok_9ab1',
    context_cache_contract: CONTEXT_CACHE_CONTRACT_VERSION,
  });

  const bad = generationRecord({ cachedTokens: 900 });
  assert.equal(bad.cache.token_accounting.reconciled, false);
  assert.equal(bad.complete, false);
  assert.ok(bad.incomplete_reasons.includes(TIMING_UNSUPPORTED_REASONS.TOKEN_ACCOUNTING_UNRECONCILED));
});

test('an alias cannot certify a different concrete model than the one that served', () => {
  const clock = fakeClock();
  const recorder = new TimingEvidenceRecorder({
    requestId: 'req_swap',
    profile: TIMING_EVIDENCE_PROFILES.GENERATION,
    clock,
  });
  recorder.setIdentity(IDENTITY);
  recorder.mark('received');
  recorder.noteObservedModel('gemma-4-12b');
  const record = recorder.build();
  assert.equal(record.identity.certified_model, 'gemma-4-27b');
  assert.equal(record.identity.model_swap_detected, true);
  assert.equal(record.complete, false);
  assert.ok(record.incomplete_reasons.includes(TIMING_UNSUPPORTED_REASONS.RESOLVED_MODEL_CHANGED));

  // The same concrete model reported back by the engine is not a swap.
  const stable = new TimingEvidenceRecorder({ requestId: 'req_stable', profile: TIMING_EVIDENCE_PROFILES.COUNT });
  stable.setIdentity(IDENTITY);
  stable.noteObservedModel('gemma-4-27b');
  assert.equal(stable.build().identity.model_swap_detected, false);
});

test('a record without a concrete resolved model cannot be built', () => {
  const recorder = new TimingEvidenceRecorder({ requestId: 'req_noid', profile: TIMING_EVIDENCE_PROFILES.COUNT });
  assert.throws(() => recorder.build(), /resolvedModel/);
  assert.throws(() => recorder.setIdentity({ resolvedModel: 'x', prompt: 'secret text' }), /unsupported identity/i);
});

test('cache outcome classification covers cold, warm, persona change, and eviction reload', () => {
  assert.equal(classifyCacheOutcome({ exactInputTokens: 800, cachedTokens: 0 }), 'cold');
  assert.equal(classifyCacheOutcome({ exactInputTokens: 800, cachedTokens: 700 }), 'warm_prefix');
  assert.equal(
    classifyCacheOutcome({ exactInputTokens: 800, cachedTokens: 150, priorCachedTokens: 700 }),
    'persona_change',
  );
  assert.equal(
    classifyCacheOutcome({ exactInputTokens: 800, cachedTokens: 0, priorCachedTokens: 700 }),
    'persona_change',
  );
  assert.equal(
    classifyCacheOutcome({ exactInputTokens: 800, cachedTokens: 700, reloaded: true }),
    'eviction_reload',
  );
  assert.equal(classifyCacheOutcome({ cancelled: true, cachedTokens: 700 }), 'cancelled');
  assert.equal(classifyCacheOutcome({ engineSupported: false, cachedTokens: 700 }), 'unsupported');
});

test('a cold record is classified and versioned', () => {
  const record = generationRecord({ cachedTokens: 0, cacheHitKind: 'none' });
  assert.equal(record.cache.classification, 'cold');
  assert.equal(record.cache.token_accounting.new_tokens, 812);
  assert.equal(record.complete, true);
  assert.equal(record.timing_evidence_version, TIMING_EVIDENCE_VERSION);
});

test('a warm-prefix record keeps its reused-token accounting', () => {
  const record = generationRecord({ cachedTokens: 700, cacheHitKind: 'affinity' });
  assert.equal(record.cache.classification, 'warm_prefix');
  assert.equal(record.cache.token_accounting.cached_tokens, 700);
  assert.equal(record.complete, true);
});

test('a persona change is distinguished from a warm prefix', () => {
  const record = generationRecord({ cachedTokens: 120, priorCachedTokens: 700, cacheHitKind: 'affinity' });
  assert.equal(record.cache.classification, 'persona_change');
  assert.equal(record.cache.prior_cached_tokens, 700);
});

test('an eviction and reload is classified distinctly from a cold start', () => {
  const record = generationRecord({ cachedTokens: 40, reloaded: true, cacheHitKind: 'disk_restore' });
  assert.equal(record.cache.classification, 'eviction_reload');
  assert.equal(record.cache.reloaded, true);
});

test('a cancelled request is classified cancelled and stays incomplete', () => {
  const clock = fakeClock();
  const recorder = new TimingEvidenceRecorder({
    requestId: 'req_cancel',
    profile: TIMING_EVIDENCE_PROFILES.PREFILL,
    clock,
  });
  recorder.setIdentity(IDENTITY);
  recorder.mark('received');
  clock.advance(6);
  recorder.mark('admitted');
  recorder.mark('prefill_started');
  clock.advance(30);
  recorder.cancel('preempted_by_realtime');
  const record = recorder.build();

  assert.equal(record.cache.classification, 'cancelled');
  assert.equal(record.cancelled, true);
  assert.equal(record.cancellation_reason, 'preempted_by_realtime');
  assert.equal(record.manager_observed.prefill.supported, false);
  assert.equal(record.manager_observed.prefill.reason, TIMING_UNSUPPORTED_REASONS.PHASE_NOT_REACHED);
  assert.equal(record.complete, false);
});

test('an unsupported engine yields typed reasons on every engine dimension', () => {
  const recorder = new TimingEvidenceRecorder({ requestId: 'req_ds4', profile: TIMING_EVIDENCE_PROFILES.GENERATION });
  recorder.setIdentity({ ...IDENTITY, engine: 'ds4', engineRevision: 'ds4-0.4' });
  recorder.markEngineUnsupported(TIMING_UNSUPPORTED_REASONS.ENGINE_UNSUPPORTED);
  recorder.mark('received');
  const record = recorder.build();

  assert.equal(record.cache.classification, 'unsupported');
  assert.equal(record.engine_reported.prefill.supported, false);
  assert.equal(record.engine_reported.prefill.reason, TIMING_UNSUPPORTED_REASONS.ENGINE_UNSUPPORTED);
  assert.equal(record.engine_reported.tokenization.supported, false);
  assert.equal(record.engine_reported.tokenization.reason, TIMING_UNSUPPORTED_REASONS.ENGINE_UNSUPPORTED);
  assert.equal(record.complete, false);
  assert.ok(record.incomplete_reasons.length > 0);
});

test('the count profile only requires admission and tokenization to be complete', () => {
  const clock = fakeClock();
  const recorder = new TimingEvidenceRecorder({
    requestId: 'req_count',
    profile: TIMING_EVIDENCE_PROFILES.COUNT,
    clock,
  });
  recorder.setIdentity(IDENTITY);
  recorder.mark('received');
  clock.advance(3);
  recorder.mark('admitted');
  recorder.mark('tokenization_started');
  clock.advance(7);
  recorder.mark('tokenization_completed');
  recorder.setTokenAccounting({ exactInputTokens: 350, cachedTokens: 0, source: 'exact_input_tokens_endpoint' });
  const record = recorder.build();

  assert.equal(record.complete, true);
  assert.equal(record.manager_observed.tokenization.ms, 7);
  assert.equal(record.manager_observed.prefill.supported, false);
  assert.equal(record.manager_observed.prefill.reason, TIMING_UNSUPPORTED_REASONS.PHASE_NOT_APPLICABLE);
  assert.equal(record.manager_observed.first_content.reason, TIMING_UNSUPPORTED_REASONS.PHASE_NOT_APPLICABLE);
});

test('the record never carries prompt text, message content, or credentials', () => {
  const clock = fakeClock();
  const recorder = new TimingEvidenceRecorder({
    requestId: 'req_privacy',
    profile: TIMING_EVIDENCE_PROFILES.GENERATION,
    clock,
  });
  recorder.setIdentity(IDENTITY);
  recorder.mark('received');
  recorder.setTokenAccounting({ exactInputTokens: 5, cachedTokens: 0, source: 'exact_input_tokens_endpoint' });
  const serialized = JSON.stringify(recorder.build());

  // Concrete secret material that a careless implementation might carry through.
  const leaks = [
    'Bearer sk-live-abcdef',
    'sk-live-abcdef',
    'You are a terse assistant.',
    'summarize this contract',
    'hf_tokenABCDEF',
  ];
  for (const secret of leaks) {
    assert.equal(serialized.includes(secret), false, `record leaked "${secret}"`);
  }
  // Field names that would carry caller content are rejected outright rather
  // than silently dropped, so a future caller cannot smuggle text into the record.
  assert.throws(() => recorder.setIdentity({ authorization: 'Bearer sk-live-abcdef' }), /unsupported identity/i);
  assert.throws(() => recorder.setIdentity({ prompt: 'summarize this contract' }), /unsupported identity/i);
  assert.throws(() => recorder.setCacheSignals({ messages: ['You are a terse assistant.'] }), /unsupported cache/i);
  assert.throws(
    () => recorder.setTokenAccounting({ exactInputTokens: 5, cachedTokens: 0, source: 'x', prompt: 'p' }),
    /unsupported token/i,
  );
});

test('the built record exposes only the documented top-level surface', () => {
  const record = generationRecord();
  assert.deepEqual(Object.keys(record).sort(), [
    'cache',
    'cancellation_reason',
    'cancelled',
    'client_observed',
    'clocks',
    'complete',
    'context_cache_contract',
    'engine_reported',
    'identity',
    'incomplete_reasons',
    'lifecycle',
    'manager_observed',
    'object',
    'profile',
    'request_id',
    'timing_evidence_version',
  ]);
  assert.deepEqual(record.lifecycle, [
    'received',
    'admitted',
    'tokenization_started',
    'tokenization_completed',
    'prefill_started',
    'prefill_completed',
    'inference_started',
    'first_content',
  ]);
});

test('a dimension the manager structurally cannot observe carries its own typed reason', () => {
  const clock = fakeClock();
  const recorder = new TimingEvidenceRecorder({
    requestId: 'req_chat',
    profile: TIMING_EVIDENCE_PROFILES.GENERATION,
    clock,
  });
  recorder.setIdentity(IDENTITY);
  recorder.mark('received');
  clock.advance(30);
  recorder.mark('admitted');
  // A served generation exposes no discrete tokenization or prefill boundary to
  // the manager; llama.cpp reports prompt processing only.
  recorder.markDimensionUnsupported('tokenization', TIMING_UNSUPPORTED_REASONS.ENGINE_DOES_NOT_SEPARATE_TOKENIZATION);
  recorder.markDimensionUnsupported('prefill', TIMING_UNSUPPORTED_REASONS.MANAGER_CANNOT_SEPARATE_PREFILL);
  recorder.markDimensionUnsupported('inference_start', TIMING_UNSUPPORTED_REASONS.MANAGER_CANNOT_OBSERVE_INFERENCE_START);
  clock.advance(400);
  recorder.mark('first_content');
  recorder.setEngineTimings({ promptMs: 210, predictedMs: 180, promptN: 700, cacheN: 500 });
  recorder.setTokenAccounting({ exactInputTokens: 700, cachedTokens: 500, source: 'llama_cpp_timings' });
  const record = recorder.build();

  assert.equal(record.manager_observed.tokenization.supported, false);
  assert.equal(
    record.manager_observed.tokenization.reason,
    TIMING_UNSUPPORTED_REASONS.ENGINE_DOES_NOT_SEPARATE_TOKENIZATION,
  );
  assert.equal(record.manager_observed.prefill.reason, TIMING_UNSUPPORTED_REASONS.MANAGER_CANNOT_SEPARATE_PREFILL);
  // Prefill is still certifiable because the engine reports it directly.
  assert.equal(record.engine_reported.prefill.ms, 210);
  assert.equal(record.manager_observed.queue_wait.ms, 30);
  assert.equal(record.manager_observed.first_content.ms, 430);
  assert.equal(record.cache.classification, 'warm_prefix');
  // Tokenization and inference start remain uncertifiable, with typed reasons.
  assert.equal(record.complete, false);
  assert.deepEqual(record.incomplete_reasons, [
    `tokenization:${TIMING_UNSUPPORTED_REASONS.ENGINE_DOES_NOT_SEPARATE_TOKENIZATION}`,
    `inference_start:${TIMING_UNSUPPORTED_REASONS.MANAGER_CANNOT_OBSERVE_INFERENCE_START}`,
  ]);
});

test('an explicit unsupported declaration cannot overwrite a real measurement', () => {
  const clock = fakeClock();
  const recorder = new TimingEvidenceRecorder({ requestId: 'req_x', profile: TIMING_EVIDENCE_PROFILES.COUNT, clock });
  recorder.setIdentity(IDENTITY);
  recorder.mark('received');
  clock.advance(2);
  recorder.mark('admitted');
  recorder.markDimensionUnsupported('queue_wait', TIMING_UNSUPPORTED_REASONS.MARK_MISSING);
  assert.equal(recorder.build().manager_observed.queue_wait.ms, 2);
  assert.throws(() => recorder.markDimensionUnsupported('not_a_dimension', 'x'), /unknown/i);
});

test('a request id may be bound after the recorder starts timing', () => {
  const recorder = new TimingEvidenceRecorder({ profile: TIMING_EVIDENCE_PROFILES.COUNT, clock: () => 0 });
  recorder.setIdentity(IDENTITY);
  recorder.mark('received');
  assert.equal(recorder.build().request_id, null);
  recorder.setRequestId('req_late');
  assert.equal(recorder.build().request_id, 'req_late');
});

test('tokenizer revision fingerprints canonical tokenizer material and is never fabricated', () => {
  const props = {
    'tokenizer.ggml.model': 'gemma',
    n_vocab: 262144,
    bos_token: '<bos>',
    eos_token: '<eos>',
    chat_template: '{{ messages }}',
  };
  const revision = tokenizerRevision(props);
  assert.match(revision, /^tok_[0-9a-f]{32}$/);
  assert.equal(tokenizerRevision({ ...props }), revision);
  assert.notEqual(tokenizerRevision({ ...props, n_vocab: 128000 }), revision);
  assert.notEqual(tokenizerRevision({ ...props, chat_template: '{{ other }}' }), revision);
  // Absent evidence yields null so the record reports an unknown tokenizer
  // rather than certifying a fabricated one.
  assert.equal(tokenizerRevision(null), null);
  assert.equal(tokenizerRevision(undefined), null);
});

test('createRequestTimingRecorder binds identity and marks receipt in one step', () => {
  const clock = fakeClock();
  const recorder = createRequestTimingRecorder({
    requestId: 'req_factory',
    profile: TIMING_EVIDENCE_PROFILES.PREFILL,
    clock,
    ...IDENTITY,
  });
  clock.advance(8);
  recorder.mark('admitted');
  const record = recorder.build();
  assert.equal(record.request_id, 'req_factory');
  assert.equal(record.profile, TIMING_EVIDENCE_PROFILES.PREFILL);
  assert.equal(record.identity.resolved_model, 'gemma-4-27b');
  assert.equal(record.manager_observed.queue_wait.ms, 8);
  assert.deepEqual(record.lifecycle, ['received', 'admitted']);
});

test('the default monotonic clock advances and never returns wall-clock epoch time', () => {
  const first = monotonicClockMs();
  const second = monotonicClockMs();
  assert.equal(typeof first, 'number');
  assert.ok(second >= first);
  assert.ok(first < Date.now() / 2, 'monotonic clock must not be an epoch timestamp');
});
