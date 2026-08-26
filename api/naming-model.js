/**
 * Copyright (c) Llama Manager project. Use of this file is governed by the
 * LICENSE file in the repository root.
 *
 * Chooses which model the node-naming completion asks for. Split out because
 * the wrong answer here is invisible until an appliance tries to name itself
 * and the operator is told, misleadingly, that the model produced nothing
 * usable.
 */

/**
 * Resolves a model name for the naming completion.
 *
 * Prefers a model that is ACTUALLY LOADED over the `auto` alias. MEASURED on
 * the appliance: `auto` resolved to an alias named `default-small`, which the
 * appliance does not define, so every naming request failed upstream with
 *
 *   {"error":{"code":400,"message":"model 'default-small' not found"}}
 *
 * and the kiosk reported "The model returned no usable names" -- blaming the
 * model for a request that never reached one. The appliance ships exactly one
 * model, so asking for it by name is both correct and unambiguous.
 *
 * `auto` remains the fallback for installs that do define aliases and may have
 * nothing loaded at the moment of asking; letting the manager route is better
 * than inventing a name.
 *
 * @param {{models?: unknown[]}} params Engine report carrying loaded model ids.
 * @returns {string} A model name safe to send upstream.
 */
export function resolveNamingModel({ models } = {}) {
  if (!Array.isArray(models)) return 'auto';
  for (const model of models) {
    if (typeof model === 'string' && model.trim()) return model.trim();
  }
  return 'auto';
}
