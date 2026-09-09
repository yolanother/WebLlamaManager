// Llama Manager — persisted configuration default resolution.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Merges service/package environment defaults underneath persisted JSON
// configuration. This keeps package-created empty config files functional while
// preserving every explicit operator value. autoStart is the one exception:
// AUTO_START=false is a fail-safe veto that always wins, even over a persisted
// autoStart:true, so a boot-time override can stop an engine from auto-starting
// regardless of what a prior run already saved to disk (previously an
// AUTO_START=false env var was silently ignored once any settings save had
// persisted autoStart:true, which let a throwaway test instance auto-start and
// collide with a production engine).

/**
 * Apply environment-backed service defaults beneath persisted configuration.
 *
 * @param {Record<string, unknown>} config Parsed persisted configuration.
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env Environment
 *   containing optional package/source defaults.
 * @returns {Record<string, unknown>} A new configuration object whose explicit
 *   persisted keys override all defaults, except autoStart: env AUTO_START=false
 *   always forces autoStart to false, and a persisted autoStart:false is equally
 *   authoritative in the other direction (an unset or true env var never turns it
 *   back on) — either source saying "don't start" wins.
 */
/**
 * Models that reason unboundedly unless an effort is set, and the bound to apply.
 *
 * api/duo-chain.js records the measurement behind this, same model and prompt with only
 * `reasoning_effort` varying: unbounded, the model spends its WHOLE budget thinking and
 * returns empty content on `length` (17,145 chars of reasoning at max_tokens 4096; 51,763
 * at 12000 — raising the budget makes it worse, not better). Bounded, it terminates with a
 * real answer and is ~6x faster.
 *
 * duo applies that bound to every chain step and is protected. The DIRECT path was not, and
 * a downstream consumer hit exactly the documented failure — 12,000 output tokens consumed
 * by reasoning, no JSON (T312677f9f21cc). Seeding it here fixes that for every caller
 * without their having to know any of it.
 *
 * Deliberately NARROW: a global default would reach non-reasoning models, where the kwarg
 * is meaningless. Patterns are glob-style and matched case-insensitively against the
 * requested model id.
 * @type {Object<string,string>}
 */
export const DEFAULT_MODEL_REASONING_EFFORT = Object.freeze({
  // Deliberately SPECIFIC rather than '*qwen3.6*' / '*qwen3.8*'. The pattern matcher in
  // api/server.js converts a glob with `.replace(/\*/g,'.*')` and does NOT escape regex
  // metacharacters, so the '.' in 'qwen3.8' is a WILDCARD -- '*qwen3.8*' also matches
  // 'Qwen3-8B', an unrelated model. Naming the size keeps each pattern to its own family.
  '*qwen3.6-35b*': 'medium',
  '*qwen3.8-flash-next*': 'medium',
  '*qwen3.8-27b*': 'medium',
});

export function applyConfigDefaults(config = {}, env = process.env) {
  const merged = {
    autoStart: true,
    // Replaced wholesale by a persisted map rather than merged, so an operator can clear
    // an entry by omitting it instead of fighting a default they cannot remove.
    modelReasoningEffort: { ...DEFAULT_MODEL_REASONING_EFFORT },
    modelsMax: Number.parseInt(env.MODELS_MAX, 10) || 2,
    contextSize: Number.parseInt(env.CONTEXT_SIZE, 10) || 8192,
    logFilters: [],
    requestLogging: false,
    maxConcurrentRequests: 1,
    ...config,
  };
  if (env.AUTO_START === 'false') merged.autoStart = false;
  return merged;
}

/**
 * Match a model id against an operator's glob pattern.
 *
 * `*` and `?` are the wildcards; EVERYTHING ELSE IS LITERAL, and matching ignores case.
 * Both of those were bugs before this existed, and both failed silently:
 *
 *   - Metacharacters were not escaped, so the `.` in a pattern like `*qwen3.8*` matched any
 *     character and the pattern also caught `Qwen3-8B` — a different model family, given a
 *     setting meant for another. A pattern that matches too much is worse than one that
 *     matches nothing, because nothing looks broken.
 *   - Matching was case-sensitive while real model ids are mixed case
 *     (`unsloth_Qwen3.6-35B-A3B-GGUF`), so an operator's lowercase pattern simply never
 *     fired and their configuration appeared to be ignored.
 *
 * @param {string} pattern Glob-style pattern, e.g. `*qwen3.6-35b*` or `gpt-oss*`.
 * @param {string} model The requested model id.
 * @returns {boolean} Whether the pattern matches the whole id.
 */
export function modelPatternMatches(pattern, model) {
  if (typeof pattern !== 'string' || typeof model !== 'string') return false;
  // Escape every regex metacharacter, then re-introduce ONLY the two glob wildcards.
  const rx = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*/g, '.*')
    .replace(/\\\?/g, '.');
  return new RegExp(`^${rx}$`, 'i').test(model);
}
