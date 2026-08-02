// Llama Manager — versioned per-request tokenization and prefill timing evidence.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Records auditable latency evidence for one request against one concrete
// resolved model and manager contract revision. It keeps admission/queue wait,
// input tokenization, KV prefill, inference start, and first emitted content as
// separately measured monotonic dimensions that can never be conflated,
// double-counted, or inferred from an aggregate counter, types every
// unmeasurable dimension with an explicit reason instead of a synthesized zero,
// classifies the cache outcome (cold, warm prefix, persona change, eviction
// reload, cancelled, unsupported), and carries no prompt text or credentials.

import { canonicalHash, CONTEXT_CACHE_CONTRACT_VERSION } from './context-cache.js';

/** Version of the public timing-evidence record contract. */
export const TIMING_EVIDENCE_VERSION = 1;

/**
 * Certification profiles. A profile declares which timing dimensions a record
 * must measure before downstream certification may treat it as complete.
 */
export const TIMING_EVIDENCE_PROFILES = Object.freeze({
  /** Exact input counting only; no KV prefill and no generation. */
  COUNT: 'count',
  /** Exact input counting plus background KV prefill; no generation. */
  PREFILL: 'prefill',
  /** A full served request through first emitted content. */
  GENERATION: 'generation',
});

/** Typed reasons explaining why a dimension carries no measurement. */
export const TIMING_UNSUPPORTED_REASONS = Object.freeze({
  /** llama.cpp folds input tokenization into its prompt (prefill) timing. */
  ENGINE_DOES_NOT_SEPARATE_TOKENIZATION: 'engine_does_not_separate_tokenization',
  /** The engine returned no prompt-processing timing for this request. */
  ENGINE_LACKS_PREFILL_INSTRUMENTATION: 'engine_lacks_prefill_instrumentation',
  /** The serving engine exposes no timing instrumentation at all. */
  ENGINE_UNSUPPORTED: 'engine_unsupported',
  /** A served generation exposes no prefill boundary the manager can observe. */
  MANAGER_CANNOT_SEPARATE_PREFILL: 'manager_cannot_separate_prefill',
  /** Neither manager nor engine reports when decoding began for this request. */
  MANAGER_CANNOT_OBSERVE_INFERENCE_START: 'manager_cannot_observe_inference_start',
  /** The caller did not report its own wall-clock first-token latency. */
  CLIENT_CLOCK_NOT_REPORTED: 'client_clock_not_reported',
  /** The phase began but never completed (cancellation, preemption, failure). */
  PHASE_NOT_REACHED: 'phase_not_reached',
  /** The phase does not exist for this certification profile. */
  PHASE_NOT_APPLICABLE: 'phase_not_applicable',
  /** The phase applies to this profile but was never instrumented. */
  MARK_MISSING: 'mark_missing',
  /** Tokenization and prefill intervals overlapped, so neither is auditable. */
  OVERLAPPING_TOKENIZATION_AND_PREFILL: 'overlapping_tokenization_and_prefill',
  /** Cached tokens could not be reconciled against the exact input count. */
  TOKEN_ACCOUNTING_UNRECONCILED: 'token_accounting_unreconciled',
  /** The concrete model that served differed from the certified resolved model. */
  RESOLVED_MODEL_CHANGED: 'resolved_model_changed',
});

/** Lifecycle marks in contract order. */
const LIFECYCLE_MARKS = Object.freeze([
  'received',
  'admitted',
  'tokenization_started',
  'tokenization_completed',
  'prefill_started',
  'prefill_completed',
  'inference_started',
  'first_content',
]);

/** Marks that may only be recorded after admission has been marked. */
const POST_ADMISSION_MARKS = Object.freeze([
  'tokenization_started', 'tokenization_completed',
  'prefill_started', 'prefill_completed',
  'inference_started', 'first_content',
]);

/** Paired phase marks, used to derive interval durations. */
const PHASE_INTERVALS = Object.freeze({
  queue_wait: ['received', 'admitted'],
  tokenization: ['tokenization_started', 'tokenization_completed'],
  prefill: ['prefill_started', 'prefill_completed'],
});

/** Single marks reported as an offset from request receipt. */
const PHASE_OFFSETS = Object.freeze({
  inference_start: 'inference_started',
  first_content: 'first_content',
});

/** Every reported manager-observed dimension, in report order. */
const MANAGER_DIMENSIONS = Object.freeze([
  'queue_wait', 'tokenization', 'prefill', 'inference_start', 'first_content',
]);

/** Dimensions each certification profile must measure to be complete. */
const PROFILE_REQUIREMENTS = Object.freeze({
  [TIMING_EVIDENCE_PROFILES.COUNT]: Object.freeze(['queue_wait', 'tokenization']),
  [TIMING_EVIDENCE_PROFILES.PREFILL]: Object.freeze(['queue_wait', 'tokenization', 'prefill']),
  [TIMING_EVIDENCE_PROFILES.GENERATION]: Object.freeze([
    'queue_wait', 'tokenization', 'prefill', 'inference_start', 'first_content',
  ]),
});

/** Identity fields accepted by {@link TimingEvidenceRecorder#setIdentity}. */
const IDENTITY_FIELDS = Object.freeze([
  'requestedModel', 'resolvedModel', 'engine', 'engineRevision',
  'modelRevision', 'tokenizerRevision', 'priority', 'routingPolicy',
]);

/** Cache signal fields accepted by {@link TimingEvidenceRecorder#setCacheSignals}. */
const CACHE_SIGNAL_FIELDS = Object.freeze(['cacheHitKind', 'reloaded', 'priorCachedTokens']);

/** Token accounting fields accepted by {@link TimingEvidenceRecorder#setTokenAccounting}. */
const TOKEN_ACCOUNTING_FIELDS = Object.freeze(['exactInputTokens', 'cachedTokens', 'source']);

/** Engine timing fields accepted by {@link TimingEvidenceRecorder#setEngineTimings}. */
const ENGINE_TIMING_FIELDS = Object.freeze(['promptMs', 'predictedMs', 'promptN', 'cacheN']);

/**
 * Read the process monotonic clock in milliseconds with sub-millisecond
 * precision. The value shares no origin with wall-clock epoch time and is only
 * meaningful as a difference between two reads in the same process.
 *
 * @returns {number} Monotonic milliseconds since an arbitrary process origin.
 */
export function monotonicClockMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

/**
 * Fingerprint the canonical tokenizer material of one concrete model from a
 * llama.cpp `/props` payload. Two requests certified against the same tokenizer
 * revision rendered their input with the same vocabulary, special tokens, and
 * chat template, so their exact and cached token counts are comparable.
 *
 * Missing property evidence returns null rather than a fabricated identifier —
 * an unknown tokenizer must never be certified as a known one.
 *
 * @param {Record<string, unknown>|null|undefined} props llama.cpp `/props` payload.
 * @returns {string|null} An opaque `tok_*` revision, or null when unknown.
 */
export function tokenizerRevision(props) {
  if (!props || typeof props !== 'object') return null;
  const digest = canonicalHash({
    version: CONTEXT_CACHE_CONTRACT_VERSION,
    model: props['tokenizer.ggml.model'] ?? props.tokenizer?.model ?? null,
    vocabulary: props.n_vocab ?? props.tokenizer?.n_vocab ?? null,
    bos: props.bos_token ?? null,
    eos: props.eos_token ?? null,
    template: props.chat_template ?? props.default_generation_settings?.chat_template ?? null,
  });
  return `tok_${digest.slice(0, 32)}`;
}

/**
 * Create a recorder already bound to a request identity with the `received`
 * lifecycle mark taken, so handlers can start timing in one statement.
 *
 * @param {Object} input Recorder configuration and identity fields.
 * @param {string} [input.requestId] Opaque manager request identifier.
 * @param {string} [input.profile] One of {@link TIMING_EVIDENCE_PROFILES}.
 * @param {() => number} [input.clock] Injectable monotonic clock.
 * @param {() => Date} [input.wallClock] Injectable wall clock for correlation.
 * @returns {TimingEvidenceRecorder} A recorder with identity bound and receipt marked.
 * @throws {TypeError} When the profile or an identity field is unsupported.
 */
export function createRequestTimingRecorder({ requestId, profile, clock, wallClock, ...identity } = {}) {
  const recorder = new TimingEvidenceRecorder({ requestId, profile, clock, wallClock });
  recorder.setIdentity(identity);
  recorder.mark('received');
  return recorder;
}

/**
 * Round a millisecond duration to microsecond resolution.
 *
 * @param {number} ms Raw duration in milliseconds.
 * @returns {number} The duration rounded to three decimal places.
 */
function roundMs(ms) {
  return Math.round(ms * 1000) / 1000;
}

/**
 * Reject any object carrying keys outside an allow list. This is the privacy
 * boundary: prompt text, message content, and credentials can only enter the
 * record through an unexpected key, so unexpected keys are a hard error rather
 * than a silent drop.
 *
 * @param {Record<string, unknown>} value Caller-supplied fields.
 * @param {readonly string[]} allowed Permitted field names.
 * @param {string} label Human-readable field-group name used in the error.
 * @returns {Record<string, unknown>} The validated value.
 * @throws {TypeError} When the value is not a plain object or carries a key
 *   outside the allow list.
 */
function assertAllowedFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} fields must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`unsupported ${label} field: ${key}`);
    }
  }
  return value;
}

/** Build a measured dimension value. */
function measured(ms, origin, source) {
  const value = { supported: true, ms: roundMs(ms), origin };
  if (source) value.source = source;
  return value;
}

/** Build an unmeasurable dimension value carrying an explicit typed reason. */
function unsupported(reason) {
  return { supported: false, reason };
}

/**
 * Classify the cache outcome of one request from its token accounting and
 * lifecycle signals. Classification is deterministic and never depends on
 * timing values, so a slow warm request is still classified warm.
 *
 * @param {Object} [signals] Classification inputs.
 * @param {boolean} [signals.cancelled] Whether the request was cancelled or preempted.
 * @param {boolean} [signals.engineSupported=true] Whether the engine reports cache state.
 * @param {boolean} [signals.reloaded] Whether the slot or model was evicted and reloaded.
 * @param {number} [signals.exactInputTokens] Exact rendered input token count.
 * @param {number} [signals.cachedTokens=0] Reusable prefix tokens for this request.
 * @param {number|null} [signals.priorCachedTokens] Reusable prefix previously established
 *   for the same conversation lineage, used to detect a persona/prefix change.
 * @returns {'cold'|'warm_prefix'|'persona_change'|'eviction_reload'|'cancelled'|'unsupported'}
 *   The classification.
 */
export function classifyCacheOutcome({
  cancelled = false,
  engineSupported = true,
  reloaded = false,
  exactInputTokens = null,
  cachedTokens = 0,
  priorCachedTokens = null,
} = {}) {
  void exactInputTokens;
  if (cancelled) return 'cancelled';
  if (!engineSupported) return 'unsupported';
  if (reloaded) return 'eviction_reload';
  const cached = Number(cachedTokens) || 0;
  const prior = priorCachedTokens == null ? null : (Number(priorCachedTokens) || 0);
  if (prior != null && prior > 0 && cached < prior) return 'persona_change';
  return cached > 0 ? 'warm_prefix' : 'cold';
}

/**
 * Collects monotonic lifecycle marks for one request and builds the versioned
 * public timing-evidence record.
 *
 * The recorder is deliberately pure: it holds no request body, no headers, and
 * no engine handles. Callers push scalar identity, token accounting, cache
 * signals, and engine-reported timings; everything else is derived. `build()`
 * is non-destructive and may be called repeatedly as more marks arrive.
 */
export class TimingEvidenceRecorder {
  /**
   * Create a recorder for one request.
   *
   * @param {Object} [options] Recorder configuration.
   * @param {string} [options.requestId] Opaque manager request identifier.
   * @param {string} [options.profile] One of {@link TIMING_EVIDENCE_PROFILES}.
   * @param {() => number} [options.clock] Injectable monotonic clock returning
   *   milliseconds. Defaults to {@link monotonicClockMs}.
   * @param {() => Date} [options.wallClock] Injectable wall clock used only for
   *   the correlation timestamp; never used for duration arithmetic.
   * @throws {TypeError} When the profile is not a known certification profile.
   */
  constructor({
    requestId = null,
    profile = TIMING_EVIDENCE_PROFILES.GENERATION,
    clock = monotonicClockMs,
    wallClock = () => new Date(),
  } = {}) {
    if (!PROFILE_REQUIREMENTS[profile]) {
      throw new TypeError(`unknown timing-evidence profile: ${profile}`);
    }
    this.requestId = requestId;
    this.profile = profile;
    this.clock = clock;
    this.wallClock = wallClock;
    this.injectedClock = clock !== monotonicClockMs;
    this.marks = new Map();
    this.identity = {};
    this.tokenAccounting = null;
    this.cacheSignals = {};
    this.engineTimings = null;
    this.engineUnsupportedReason = null;
    this.clientFirstTokenMs = null;
    this.cancelled = false;
    this.cancellationReason = null;
    this.observedModel = null;
    this.startedAtIso = null;
    this.declaredUnsupported = new Map();
  }

  /**
   * Bind the manager request identifier after timing has already started, for
   * handlers that allocate their request id after receipt.
   *
   * @param {string|null} requestId Opaque manager request identifier.
   * @returns {TimingEvidenceRecorder} This recorder, for chaining.
   */
  setRequestId(requestId) {
    this.requestId = requestId ?? null;
    return this;
  }

  /**
   * Declare that one manager-observed dimension is structurally unobservable on
   * this serving path, with an explicit typed reason. A declaration never
   * overwrites a real measurement, so it is safe to declare a limit up front and
   * still record marks if they later become available.
   *
   * @param {string} dimension A member of the reported manager dimensions.
   * @param {string} reason A member of {@link TIMING_UNSUPPORTED_REASONS}.
   * @returns {TimingEvidenceRecorder} This recorder, for chaining.
   * @throws {TypeError} When the dimension is not part of the contract.
   */
  markDimensionUnsupported(dimension, reason) {
    if (!MANAGER_DIMENSIONS.includes(dimension)) {
      throw new TypeError(`unknown timing dimension: ${dimension}`);
    }
    this.declaredUnsupported.set(dimension, reason);
    return this;
  }

  /**
   * Record one lifecycle mark at the current monotonic time.
   *
   * @param {string} name A member of the contract lifecycle mark set.
   * @returns {number} The monotonic timestamp recorded, in milliseconds.
   * @throws {TypeError} When the mark name is not part of the contract.
   * @throws {RangeError} When the mark was already recorded, when `received`
   *   is not the first mark, or when the mark violates contract ordering.
   */
  mark(name) {
    if (!LIFECYCLE_MARKS.includes(name)) {
      throw new TypeError(`unknown lifecycle mark: ${name}`);
    }
    if (this.marks.has(name)) {
      throw new RangeError(`lifecycle mark already recorded: ${name}`);
    }
    if (name !== 'received' && !this.marks.has('received')) {
      throw new RangeError('lifecycle order violated: received must be marked first');
    }
    if (name === 'admitted' && POST_ADMISSION_MARKS.some(mark => this.marks.has(mark))) {
      throw new RangeError('lifecycle order violated: admitted must precede tokenization, prefill, and inference');
    }
    for (const [start, end] of Object.values(PHASE_INTERVALS)) {
      if (name === end && !this.marks.has(start)) {
        throw new RangeError(`lifecycle order violated: ${start} must precede ${end}`);
      }
    }
    if (name === 'first_content' && this.marks.has('inference_started') === false
      && this.profile === TIMING_EVIDENCE_PROFILES.GENERATION && this.marks.has('prefill_completed')) {
      throw new RangeError('lifecycle order violated: inference_started must precede first_content');
    }
    const at = this.clock();
    if (name === 'received') this.startedAtIso = this.wallClock().toISOString();
    this.marks.set(name, at);
    return at;
  }

  /**
   * Bind the record to one concrete resolved model and serving revision set.
   *
   * @param {Object} identity Scalar identity fields; see {@link IDENTITY_FIELDS}.
   * @returns {TimingEvidenceRecorder} This recorder, for chaining.
   * @throws {TypeError} When an unsupported identity field is supplied.
   */
  setIdentity(identity) {
    assertAllowedFields(identity, IDENTITY_FIELDS, 'identity');
    Object.assign(this.identity, identity);
    return this;
  }

  /**
   * Report the concrete model the engine actually served. A value differing
   * from the resolved model marks the record as a detected swap so an alias can
   * never certify a different concrete model.
   *
   * @param {string|null|undefined} model Concrete model reported by the engine.
   * @returns {TimingEvidenceRecorder} This recorder, for chaining.
   */
  noteObservedModel(model) {
    if (typeof model === 'string' && model.length > 0) this.observedModel = model;
    return this;
  }

  /**
   * Record exact and reused token counts from the canonical tokenizer contract.
   *
   * @param {Object} accounting Token accounting fields.
   * @param {number} accounting.exactInputTokens Exact rendered input tokens.
   * @param {number} accounting.cachedTokens Reusable prefix tokens.
   * @param {string} accounting.source Provenance of the counts.
   * @returns {TimingEvidenceRecorder} This recorder, for chaining.
   * @throws {TypeError} When an unsupported token accounting field is supplied.
   */
  setTokenAccounting(accounting) {
    assertAllowedFields(accounting, TOKEN_ACCOUNTING_FIELDS, 'token accounting');
    this.tokenAccounting = {
      exactInputTokens: Number(accounting.exactInputTokens),
      cachedTokens: Number(accounting.cachedTokens) || 0,
      source: accounting.source ?? null,
    };
    return this;
  }

  /**
   * Record cache lifecycle signals used for outcome classification.
   *
   * @param {Object} signals Cache signal fields; see {@link CACHE_SIGNAL_FIELDS}.
   * @returns {TimingEvidenceRecorder} This recorder, for chaining.
   * @throws {TypeError} When an unsupported cache signal field is supplied.
   */
  setCacheSignals(signals) {
    assertAllowedFields(signals, CACHE_SIGNAL_FIELDS, 'cache signal');
    Object.assign(this.cacheSignals, signals);
    return this;
  }

  /**
   * Record engine-reported timings. llama.cpp reports prompt-processing time
   * only; it does not separate input tokenization, so the engine tokenization
   * dimension stays explicitly unsupported rather than being inferred.
   *
   * @param {Object} timings Engine timing fields; see {@link ENGINE_TIMING_FIELDS}.
   * @returns {TimingEvidenceRecorder} This recorder, for chaining.
   * @throws {TypeError} When an unsupported engine timing field is supplied.
   */
  setEngineTimings(timings) {
    assertAllowedFields(timings, ENGINE_TIMING_FIELDS, 'engine timing');
    this.engineTimings = { ...timings };
    return this;
  }

  /**
   * Declare that the serving engine exposes no timing instrumentation.
   *
   * @param {string} [reason] A member of {@link TIMING_UNSUPPORTED_REASONS}.
   * @returns {TimingEvidenceRecorder} This recorder, for chaining.
   */
  markEngineUnsupported(reason = TIMING_UNSUPPORTED_REASONS.ENGINE_UNSUPPORTED) {
    this.engineUnsupportedReason = reason;
    return this;
  }

  /**
   * Record the caller's own wall-clock first-token latency. It is reported
   * separately from the manager-observed monotonic value and is never
   * substituted for it.
   *
   * @param {number} ms Client-measured milliseconds to first token.
   * @returns {TimingEvidenceRecorder} This recorder, for chaining.
   */
  setClientObservedFirstTokenMs(ms) {
    this.clientFirstTokenMs = Number.isFinite(Number(ms)) ? Number(ms) : null;
    return this;
  }

  /**
   * Mark the request cancelled or preempted. Phases already started but not
   * completed report `phase_not_reached` instead of a synthesized duration.
   *
   * @param {string} [reason] Safe cancellation reason.
   * @returns {TimingEvidenceRecorder} This recorder, for chaining.
   */
  cancel(reason = 'cancelled') {
    this.cancelled = true;
    this.cancellationReason = String(reason).slice(0, 120);
    return this;
  }

  /** Resolve one manager-observed dimension into a measured or typed value. */
  _managerDimension(dimension, required) {
    if (!required) return unsupported(TIMING_UNSUPPORTED_REASONS.PHASE_NOT_APPLICABLE);
    const interval = PHASE_INTERVALS[dimension];
    if (interval) {
      const [start, end] = interval;
      if (this.marks.has(start) && this.marks.has(end)) {
        const source = dimension === 'tokenization' ? 'manager_measured_tokenization_call' : undefined;
        return measured(this.marks.get(end) - this.marks.get(start), 'manager_monotonic', source);
      }
      if (this.marks.has(start)) return unsupported(TIMING_UNSUPPORTED_REASONS.PHASE_NOT_REACHED);
    } else {
      const offsetMark = PHASE_OFFSETS[dimension];
      if (this.marks.has(offsetMark) && this.marks.has('received')) {
        return measured(this.marks.get(offsetMark) - this.marks.get('received'), 'manager_monotonic');
      }
    }
    if (this.declaredUnsupported.has(dimension)) {
      return unsupported(this.declaredUnsupported.get(dimension));
    }
    return unsupported(
      this.cancelled ? TIMING_UNSUPPORTED_REASONS.PHASE_NOT_REACHED : TIMING_UNSUPPORTED_REASONS.MARK_MISSING,
    );
  }

  /** Resolve the engine-reported dimensions into measured or typed values. */
  _engineDimensions() {
    if (this.engineUnsupportedReason) {
      return {
        tokenization: unsupported(this.engineUnsupportedReason),
        prefill: unsupported(this.engineUnsupportedReason),
      };
    }
    const promptMs = Number(this.engineTimings?.promptMs);
    return {
      // llama.cpp folds tokenization into prompt processing; it is never split out.
      tokenization: unsupported(TIMING_UNSUPPORTED_REASONS.ENGINE_DOES_NOT_SEPARATE_TOKENIZATION),
      prefill: Number.isFinite(promptMs)
        ? measured(promptMs, 'engine_reported', 'llama_cpp_timings.prompt_ms')
        : unsupported(TIMING_UNSUPPORTED_REASONS.ENGINE_LACKS_PREFILL_INSTRUMENTATION),
    };
  }

  /** Detect a tokenization interval that overlaps the prefill interval. */
  _tokenizationOverlapsPrefill() {
    const [tokStart, tokEnd] = PHASE_INTERVALS.tokenization;
    const [preStart, preEnd] = PHASE_INTERVALS.prefill;
    if (![tokStart, tokEnd, preStart, preEnd].every(mark => this.marks.has(mark))) return false;
    return this.marks.get(tokStart) < this.marks.get(preEnd)
      && this.marks.get(preStart) < this.marks.get(tokEnd);
  }

  /**
   * Build the versioned public timing-evidence record.
   *
   * @returns {Record<string, unknown>} The complete record. `complete` is true
   *   only when every dimension required by the profile carries a real
   *   measurement, token accounting reconciles, no model swap was detected, and
   *   tokenization and prefill did not overlap.
   * @throws {TypeError} When no concrete resolved model has been bound.
   */
  build() {
    const resolvedModel = this.identity.resolvedModel;
    if (!resolvedModel) throw new TypeError('timing evidence requires a concrete resolvedModel');

    const required = PROFILE_REQUIREMENTS[this.profile];
    const managerObserved = {};
    for (const dimension of MANAGER_DIMENSIONS) {
      managerObserved[dimension] = this._managerDimension(dimension, required.includes(dimension));
    }
    const engineReported = this._engineDimensions();

    const modelSwapDetected = this.observedModel != null && this.observedModel !== resolvedModel;
    const cachedTokens = this.tokenAccounting?.cachedTokens ?? 0;
    const exactInputTokens = this.tokenAccounting?.exactInputTokens ?? null;
    const reconciled = this.tokenAccounting == null
      ? false
      : Number.isInteger(exactInputTokens) && exactInputTokens >= 0
        && Number.isInteger(cachedTokens) && cachedTokens >= 0
        && cachedTokens <= exactInputTokens;

    const classification = classifyCacheOutcome({
      cancelled: this.cancelled,
      engineSupported: this.engineUnsupportedReason == null,
      reloaded: this.cacheSignals.reloaded === true,
      exactInputTokens,
      cachedTokens,
      priorCachedTokens: this.cacheSignals.priorCachedTokens ?? null,
    });

    const incompleteReasons = [];
    for (const dimension of required) {
      const manager = managerObserved[dimension];
      const engine = engineReported[dimension];
      if (manager.supported || engine?.supported) continue;
      incompleteReasons.push(`${dimension}:${manager.reason}`);
    }
    if (this.tokenAccounting != null && !reconciled) {
      incompleteReasons.push(TIMING_UNSUPPORTED_REASONS.TOKEN_ACCOUNTING_UNRECONCILED);
    }
    if (modelSwapDetected) incompleteReasons.push(TIMING_UNSUPPORTED_REASONS.RESOLVED_MODEL_CHANGED);
    if (this._tokenizationOverlapsPrefill()) {
      incompleteReasons.push(TIMING_UNSUPPORTED_REASONS.OVERLAPPING_TOKENIZATION_AND_PREFILL);
    }
    if (this.cancelled && !incompleteReasons.includes(TIMING_UNSUPPORTED_REASONS.PHASE_NOT_REACHED)) {
      // A cancelled request is never a certifiable measurement even if every
      // required dimension happened to complete before the abort landed.
      if (incompleteReasons.length === 0) incompleteReasons.push(`request:${TIMING_UNSUPPORTED_REASONS.PHASE_NOT_REACHED}`);
    }

    return {
      object: 'llama_manager.timing_evidence',
      timing_evidence_version: TIMING_EVIDENCE_VERSION,
      context_cache_contract: CONTEXT_CACHE_CONTRACT_VERSION,
      profile: this.profile,
      request_id: this.requestId,
      identity: {
        requested_model: this.identity.requestedModel ?? null,
        resolved_model: resolvedModel,
        certified_model: resolvedModel,
        engine: this.identity.engine ?? null,
        engine_revision: this.identity.engineRevision ?? null,
        model_revision: this.identity.modelRevision ?? null,
        tokenizer_revision: this.identity.tokenizerRevision ?? null,
        priority: this.identity.priority ?? null,
        routing_policy: this.identity.routingPolicy ?? null,
        model_swap_detected: modelSwapDetected,
      },
      clocks: {
        unit: 'milliseconds',
        precision: 'microsecond',
        monotonic_source: this.injectedClock ? 'injected' : 'process.hrtime.bigint',
        started_at: this.startedAtIso,
      },
      manager_observed: managerObserved,
      engine_reported: engineReported,
      client_observed: {
        first_token: this.clientFirstTokenMs == null
          ? unsupported(TIMING_UNSUPPORTED_REASONS.CLIENT_CLOCK_NOT_REPORTED)
          : { supported: true, ms: roundMs(this.clientFirstTokenMs), origin: 'client_wall_clock' },
      },
      cache: {
        classification,
        hit_kind: this.cacheSignals.cacheHitKind ?? null,
        reloaded: this.cacheSignals.reloaded === true,
        prior_cached_tokens: this.cacheSignals.priorCachedTokens ?? null,
        token_accounting: {
          exact_input_tokens: exactInputTokens,
          cached_tokens: this.tokenAccounting == null ? null : cachedTokens,
          new_tokens: reconciled ? exactInputTokens - cachedTokens : null,
          reconciled,
          source: this.tokenAccounting?.source ?? null,
          tokenizer_revision: this.identity.tokenizerRevision ?? null,
          context_cache_contract: CONTEXT_CACHE_CONTRACT_VERSION,
        },
      },
      lifecycle: LIFECYCLE_MARKS.filter(mark => this.marks.has(mark)),
      cancelled: this.cancelled,
      cancellation_reason: this.cancellationReason,
      complete: incompleteReasons.length === 0,
      incomplete_reasons: incompleteReasons,
    };
  }
}
