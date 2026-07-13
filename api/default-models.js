// Llama Manager — default-big / default-small model alias resolution.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Provides the request-time aliases `default-big` and `default-small`, which the
// server resolves to operator-configured real model targets (config.defaultBigModel
// and config.defaultSmallModel). This lets clients pin a stable alias instead of a
// concrete model name, so the operator can retarget the "ideal" big/small model
// centrally without clients triggering unnecessary model load/unload shifts.
//
// A default target may name a llama model (the historical behavior) OR a ds4-engine
// preset id — pointing default-big at a ds4 preset is how every default-big client
// migrates onto DeepSeek V4 Flash at once. These helpers classify/validate a target
// so server.js can trigger the exclusive DS4 activation for a ds4-backed default-big.
//
// Pure helpers only (no I/O), so the routing and model-listing behavior is unit
// testable in isolation, mirroring api/embeddings.js and api/resource-guard.js.

import { isDs4Preset } from './engines.js';

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
 * Classify a resolved model name against the configured presets: when it names an
 * existing ds4-engine preset, return the activation ref so callers (server.js) can
 * trigger exclusive DS4 activation instead of a llama load; otherwise return null
 * (a llama model name or a non-ds4 preset takes the normal llama path).
 *
 * @param {{presets?: Object<string, object>}|null|undefined} config server config
 * @param {string} modelName the (already alias-resolved) model name to classify
 * @returns {{presetId: string, preset: object}|null}
 */
export function ds4PresetForModel(config, modelName) {
  if (!config || typeof modelName !== 'string') return null;
  const preset = config.presets?.[modelName];
  if (preset && isDs4Preset(preset)) return { presetId: modelName, preset };
  return null;
}

/**
 * Validate a default-big/default-small target for the config API. A target is one of:
 *   - empty/blank/null → clears the alias (value null).
 *   - a ds4 preset id → accepted (engine 'ds4'); this migrates default clients to ds4.
 *   - a plain llama model name (not a preset id) → accepted unchanged (engine 'llama'),
 *     even if not currently downloaded, matching direct requests to such a model.
 * The only rejections are a non-string, non-null value and a target that names an
 * EXISTING non-ds4 (llama) preset — a llama preset id is not a valid default target
 * (default-big maps to a model name or a ds4 preset id, never a llama preset id).
 *
 * @param {{presets?: Object<string, object>}|null|undefined} config server config
 * @param {*} target the requested default-model target
 * @returns {{ok:true, value:(string|null), engine?:('ds4'|'llama'), presetId?:string}|{ok:false, error:string}}
 */
export function validateDefaultModelTarget(config, target) {
  if (target === null || target === undefined) return { ok: true, value: null };
  if (typeof target !== 'string') return { ok: false, error: 'target must be a string or null' };
  const v = target.trim();
  if (!v) return { ok: true, value: null };
  const preset = config?.presets?.[v];
  if (preset) {
    if (isDs4Preset(preset)) return { ok: true, value: v, engine: 'ds4', presetId: v };
    return { ok: false, error: `'${v}' is a llama preset, not a valid default-model target — use a model name or a ds4 preset id` };
  }
  return { ok: true, value: v, engine: 'llama' };
}

/**
 * Build synthetic `/v1/models` entries advertising the configured aliases so
 * clients can discover them. Only aliases with a configured target are listed;
 * an unset alias is not advertised. Each entry carries an `engine` field ('ds4'
 * when the target names a ds4 preset, else 'llama') so clients can see a
 * ds4-backed default-big at a glance.
 *
 * @param {{defaultBigModel?: string, defaultSmallModel?: string, presets?: Object<string, object>}|null|undefined} config server config
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
    aliasTarget: target,
    engine: ds4PresetForModel(config, target) ? 'ds4' : 'llama'
  });
  const big = cleanTarget(config.defaultBigModel);
  if (big) entries.push(make(BIG_ALIAS, big));
  const small = cleanTarget(config.defaultSmallModel);
  if (small) entries.push(make(SMALL_ALIAS, small));
  return entries;
}
