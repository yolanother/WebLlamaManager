// Llama Manager — default-big / default-small model alias resolution.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Provides the request-time aliases `default-big` and `default-small`, which the
// server resolves to operator-configured real model targets (config.defaultBigModel
// and config.defaultSmallModel). This lets clients pin a stable alias instead of a
// concrete model name, so the operator can retarget the "ideal" big/small model
// centrally without clients triggering unnecessary model load/unload shifts.
//
// Pure helpers only (no I/O), so the routing and model-listing behavior is unit
// testable in isolation, mirroring api/embeddings.js and api/resource-guard.js.

/** Request-time model name that resolves to config.defaultBigModel. */
export const BIG_ALIAS = 'default-big';

/** Request-time model name that resolves to config.defaultSmallModel. */
export const SMALL_ALIAS = 'default-small';

/**
 * Returns a non-empty trimmed string, or null when the value is unusable.
 * @param {*} v candidate target model name
 * @returns {string|null}
 */
function cleanTarget(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

/**
 * Resolve a requested model name through the default-big/default-small aliases.
 *
 * When `requestedModel` exactly matches `default-big` (or `default-small`) and the
 * corresponding configured target is a non-empty string, the configured target
 * (trimmed) is returned. In every other case — a non-alias name, an unset/blank
 * target, or odd input — the original `requestedModel` is returned unchanged, so
 * callers can apply this unconditionally as a no-op for normal traffic.
 *
 * @param {string} requestedModel the model name from the incoming request
 * @param {{defaultBigModel?: string, defaultSmallModel?: string}|null|undefined} config server config
 * @returns {string} the resolved model name (the original value when no alias applies)
 */
export function resolveDefaultModel(requestedModel, config) {
  if (!config) return requestedModel;
  if (requestedModel === BIG_ALIAS) {
    return cleanTarget(config.defaultBigModel) ?? requestedModel;
  }
  if (requestedModel === SMALL_ALIAS) {
    return cleanTarget(config.defaultSmallModel) ?? requestedModel;
  }
  return requestedModel;
}

/**
 * Build synthetic `/v1/models` entries advertising the configured aliases so
 * clients can discover them. Only aliases with a configured target are listed;
 * an unset alias is not advertised.
 *
 * @param {{defaultBigModel?: string, defaultSmallModel?: string}|null|undefined} config server config
 * @param {number} nowSeconds current unix time in seconds (passed in to keep this pure)
 * @returns {Array<object>} OpenAI-style model entries (possibly empty)
 */
export function defaultModelListEntries(config, nowSeconds) {
  if (!config) return [];
  const entries = [];
  const make = (id, target) => ({
    id,
    object: 'model',
    created: nowSeconds,
    owned_by: 'llamacpp',
    meta: null,
    n_ctx: null,
    displayName: id,
    status: 'alias',
    alias: null,
    aliasTarget: target
  });
  const big = cleanTarget(config.defaultBigModel);
  if (big) entries.push(make(BIG_ALIAS, big));
  const small = cleanTarget(config.defaultSmallModel);
  if (small) entries.push(make(SMALL_ALIAS, small));
  return entries;
}
