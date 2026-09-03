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
export function applyConfigDefaults(config = {}, env = process.env) {
  const merged = {
    autoStart: true,
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
