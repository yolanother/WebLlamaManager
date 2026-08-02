// Llama Manager — admission policy for prepared-context measurement and prewarming.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Decides, as pure data, whether a `POST /api/v1/context/prepare` request may
// touch the local inference lane: which scheduling class it may claim, whether
// it is allowed to load or evict a model, and whether the concrete resolved
// model is still eligible after the lane has been acquired. Keeping the decision
// here lets the residency and model-swap race rules be verified without booting
// the server, and guarantees preflight and post-admission checks share one rule.

/**
 * Scheduling classes a prepared-context request may select. `realtime` is
 * deliberately excluded: preparation is measurement and prewarming work and must
 * never claim the latency class reserved for live inference.
 */
export const CONTEXT_PREPARE_PRIORITIES = Object.freeze(['interactive', 'background']);

/**
 * Validate and normalize a caller-supplied prepared-context priority.
 *
 * @param {unknown} value Requested priority; nullish selects the compatible default.
 * @returns {'interactive'|'background'} The normalized scheduling class.
 * @throws {TypeError} With `code` `CONTEXT_PREPARE_INVALID_PRIORITY` when the
 *   value is not a supported prepared-context priority.
 */
export function normalizeContextPreparePriority(value) {
  if (value == null || value === '') return 'interactive';
  const normalized = typeof value === 'string' ? value.toLowerCase() : null;
  if (!normalized || !CONTEXT_PREPARE_PRIORITIES.includes(normalized)) {
    const error = new TypeError(
      `context preparation priority must be one of ${CONTEXT_PREPARE_PRIORITIES.join(', ')}`,
    );
    error.code = 'CONTEXT_PREPARE_INVALID_PRIORITY';
    throw error;
  }
  return normalized;
}

/**
 * Resolve whether a prepared-context request is restricted to an already
 * resident model. The explicit `resident_only` extension always fails closed
 * when set, background maintenance work is unconditionally resident-only, and
 * the remaining branches reproduce the documented legacy defaults so existing
 * callers keep working.
 *
 * @param {Object} [input] Residency inputs.
 * @param {'count'|'prefill'} [input.mode='count'] Requested preparation mode.
 * @param {'interactive'|'background'} [input.priority='interactive'] Normalized scheduling class.
 * @param {boolean} [input.residentOnly] Explicit `resident_only` request field.
 * @param {boolean} [input.allowModelLoad] Legacy `allow_model_load` opt-out.
 * @returns {{residentOnly: boolean, source: 'explicit'|'background_priority'|'legacy_prefill_default'|'legacy_allow_model_load'|'legacy_default'}}
 *   The effective residency restriction and the rule that produced it.
 */
export function resolveContextResidency({
  mode = 'count',
  priority = 'interactive',
  residentOnly,
  allowModelLoad,
} = {}) {
  if (residentOnly === true) return { residentOnly: true, source: 'explicit' };
  if (priority === 'background') return { residentOnly: true, source: 'background_priority' };
  if (residentOnly === false) return { residentOnly: false, source: 'explicit' };
  if (mode === 'prefill' && allowModelLoad !== true) {
    return { residentOnly: true, source: 'legacy_prefill_default' };
  }
  if (allowModelLoad === true) return { residentOnly: false, source: 'legacy_allow_model_load' };
  return { residentOnly: false, source: 'legacy_default' };
}

/**
 * Decide the engine gate on its own, before any upstream probe. Kept separate
 * from {@link contextPrepareAdmission} so a handler can refuse an engine that
 * cannot prepare contexts at all without accidentally applying the mode-specific
 * slot-capability rule, which needs a probe result the handler does not yet have.
 *
 * @param {string|null} engine Active engine identifier.
 * @returns {{decision:'unsupported', status:string, httpStatus:number, code:string, reason:string, message:string}|null}
 *   An unsupported decision, or null when the engine can prepare contexts.
 */
export function contextPrepareEngineDecision(engine) {
  if (engine === 'llama') return null;
  return {
    decision: 'unsupported',
    status: 'unsupported',
    httpStatus: 501,
    code: 'CONTEXT_PREPARE_UNSUPPORTED',
    reason: 'engine_unsupported',
    message: `prepared contexts are unsupported by ${engine || 'the active engine'}`,
  };
}

/**
 * Decide whether a prepared-context request may proceed against the concrete
 * resolved model. The same rule runs twice: once before the local lane is
 * requested, and again after it has been acquired, so a model swap or unload
 * that races the preflight cannot cause the manager to certify a model it is no
 * longer serving.
 *
 * @param {Object} [input] Admission inputs.
 * @param {'count'|'prefill'} [input.mode='count'] Requested preparation mode.
 * @param {string|null} [input.engine] Active engine identifier; only `llama` supports preparation.
 * @param {boolean} [input.slotOperationsSupported=false] Whether the concrete child implements `/slots`.
 * @param {boolean} [input.residentOnly=false] Effective residency restriction from {@link resolveContextResidency}.
 * @param {boolean} [input.isResident=false] Whether the concrete resolved model is currently loaded.
 * @param {'preflight'|'post_admission'} [input.stage='preflight'] Which check is running.
 * @returns {{decision:'admit'|'skip'|'unsupported', status:string, httpStatus:number, preparationOutcome?:string, code?:string, reason?:string, message?:string}}
 *   A typed decision carrying the HTTP status and public outcome to report.
 */
export function contextPrepareAdmission({
  mode = 'count',
  engine = null,
  slotOperationsSupported = false,
  residentOnly = false,
  isResident = false,
  stage = 'preflight',
} = {}) {
  const engineDecision = contextPrepareEngineDecision(engine);
  if (engineDecision) return engineDecision;
  if (mode === 'prefill' && !slotOperationsSupported) {
    return {
      decision: 'unsupported',
      status: 'unsupported',
      httpStatus: 501,
      code: 'CONTEXT_PREFILL_UNSUPPORTED',
      reason: 'slot_operations_unsupported',
      message: 'KV prefill is unsupported by this concrete llama.cpp model child',
    };
  }
  if (residentOnly && !isResident) {
    return {
      decision: 'skip',
      status: 'skipped',
      httpStatus: 200,
      preparationOutcome: stage === 'post_admission' ? 'model_no_longer_resident' : 'model_not_resident',
    };
  }
  return {
    decision: 'admit',
    status: mode === 'prefill' ? 'queued' : 'ready',
    httpStatus: mode === 'prefill' ? 202 : 201,
  };
}
