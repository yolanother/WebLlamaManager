// Llama Manager — Strata preset form helpers.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Pure helpers that turn the Presets page's Strata form (whitespace-separated
// args textarea, tokenizer, model name) into the POST /api/presets body the
// backend's strata validator expects. Ceiling: args are split on whitespace,
// so paths containing spaces are not supported.

/**
 * Split an args textarea into an argv array.
 * @param {string} text - Raw textarea contents (spaces and/or newlines).
 * @returns {string[]} Non-empty whitespace-separated tokens.
 */
export function parseStrataArgs(text) {
  return String(text ?? '').split(/\s+/).filter(Boolean);
}

/**
 * Build the POST /api/presets body for a Strata preset.
 * @param {{name: string, description?: string, context?: number|string,
 *   args: string, tokenizer: string, modelName?: string}} form - Form state.
 * @returns {{name: string, description: string|undefined, engine: 'strata',
 *   context: number, strata: {args: string[], tokenizer: string, modelName: string}}}
 */
export function buildStrataPresetBody(form) {
  return {
    name: form.name,
    description: form.description,
    engine: 'strata',
    context: Number(form.context) || 262144,
    strata: {
      args: parseStrataArgs(form.args),
      tokenizer: form.tokenizer,
      modelName: form.modelName,
    },
  };
}
