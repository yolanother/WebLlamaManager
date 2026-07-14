// Llama Manager — persisted configuration default resolution.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Merges service/package environment defaults underneath persisted JSON
// configuration. This keeps package-created empty config files functional while
// preserving every explicit operator value.

/**
 * Apply environment-backed service defaults beneath persisted configuration.
 *
 * @param {Record<string, unknown>} config Parsed persisted configuration.
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env Environment
 *   containing optional package/source defaults.
 * @returns {Record<string, unknown>} A new configuration object whose explicit
 *   persisted keys override all defaults.
 */
export function applyConfigDefaults(config = {}, env = process.env) {
  return {
    autoStart: env.AUTO_START !== 'false',
    modelsMax: Number.parseInt(env.MODELS_MAX, 10) || 2,
    contextSize: Number.parseInt(env.CONTEXT_SIZE, 10) || 8192,
    logFilters: [],
    requestLogging: false,
    maxConcurrentRequests: 1,
    ...config,
  };
}
