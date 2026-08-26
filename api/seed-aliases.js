/**
 * Copyright (c) Llama Manager project. Use of this file is governed by the
 * LICENSE file in the repository root.
 *
 * Gives a fresh appliance the routing aliases it needs to answer its own
 * requests. An appliance ships one model and an empty configuration, so the
 * `default-small` alias that `auto` routing resolves to pointed at nothing.
 */

/** The routing alias `auto` resolves to for ordinary requests. */
export const SMALL_ALIAS = 'default-small';

/**
 * Extracts a parameter count from a model name, in billions.
 *
 * Names carry it by convention -- Qwen3-8B, gpt-oss-120b, gemma-27b -- and it
 * is the only size signal available without loading the file.
 *
 * @param {string} name Model identifier.
 * @returns {number} Parameters in billions, or Infinity when unknown so an
 *   unlabelled model never wins a "smallest" comparison by accident.
 */
function parameterBillions(name) {
  const match = /(\d+(?:\.\d+)?)\s*b\b/i.exec(name);
  return match ? Number(match[1]) : Infinity;
}

/**
 * Points `default-small` at a real model when nothing has claimed it yet.
 *
 * MEASURED ON THE APPLIANCE: `auto` resolves to `default-small`, the shipped
 * config was empty, and every request that routed through it failed upstream
 * with `{"code":400,"message":"model 'default-small' not found"}`. Node naming
 * was the visible casualty -- the kiosk reported that the model had returned no
 * usable names, for a request that never reached a model.
 *
 * An alias the operator has already set is NEVER overwritten, even when its
 * target is not currently loaded: they may be pointing at a model they are
 * about to install, and silently retargeting it would be worse than the error.
 *
 * @param {object} config Manager configuration, mutated in place.
 * @param {string[]} models Model identifiers currently available locally.
 * @returns {boolean} True when the config was changed and should be persisted.
 */
export function seedDefaultAliases(config, models) {
  if (!config || typeof config !== 'object') return false;
  const usable = (Array.isArray(models) ? models : []).filter(
    (model) => typeof model === 'string' && model.trim(),
  );
  if (!usable.length) return false;
  if (config.aliases && config.aliases[SMALL_ALIAS]) return false;

  const smallest = usable
    .slice()
    .sort((a, b) => parameterBillions(a) - parameterBillions(b))[0];

  // The router advertises model IDS, not filenames. scanLocalModels() yields
  // "Qwen3-8B-Q4_K_M.gguf" while /v1/models reports "Qwen3-8B-Q4_K_M", and
  // seeding the raw filename produced an alias that resolved to nothing --
  // "model 'Qwen3-8B-Q4_K_M.gguf' not found", the very failure this seeding
  // exists to prevent, one layer further along.
  const target = smallest.replace(/\.gguf$/i, '');

  config.aliases = config.aliases || {};
  config.aliases[SMALL_ALIAS] = { targets: [{ host: 'local', model: target }] };
  return true;
}
