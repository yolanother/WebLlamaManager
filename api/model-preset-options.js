// Llama Manager — operator per-model preset options for the router's models INI.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// `config.modelPresetOptions` maps a local model id to llama.cpp options for that model
// alone: `ctx-size` (its own context window) and `cache-ram` (its host prompt-cache cap in
// MiB; llama.cpp defaults to ~8 GiB per resident model, -1 = no limit, 0 = off). They are
// merged into the generated models-preset INI sections (operator value wins, other keys
// kept), a ctx-size override switches the router to preset context mode so it is honoured,
// and admission sizes the model at its own context. Only these two keys are accepted:
// anything else could name files or binaries the engine loads. Pure; see the tests.

const KEYS = Object.freeze({
  'ctx-size': (n) => Number.isInteger(n) && n >= 512,
  'cache-ram': (n) => Number.isInteger(n) && n >= -1,
});

/**
 * Validate `config.modelPresetOptions`.
 * @param {unknown} raw the stored value.
 * @returns {{options: Object<string, Object<string,string>>, warnings: string[]}} accepted options
 *   (values stringified for the INI) and a warning per dropped model or key.
 */
export function normalizeModelPresetOptions(raw) {
  const options = {};
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { options, warnings };
  for (const [model, opts] of Object.entries(raw)) {
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
      warnings.push(`modelPresetOptions.${model}: must be an object`);
      continue;
    }
    const kept = {};
    for (const [key, value] of Object.entries(opts)) {
      const n = Number(value);
      if (KEYS[key]?.(n)) kept[key] = String(n);
      else warnings.push(`modelPresetOptions.${model}.${key}: ${KEYS[key] ? 'invalid value' : 'unsupported key'} (allowed: ${Object.keys(KEYS).join(', ')})`);
    }
    if (Object.keys(kept).length) options[model] = kept;
  }
  return { options, warnings };
}

/**
 * Merge operator options into the generated preset sections.
 * @param {Array<{name:string, options:Object<string,string>}>} sections generated sections.
 * @param {Object<string, Object<string,string>>} options normalized operator options.
 * @returns {Array<{name:string, options:Object<string,string>}>} sections with operator values
 *   applied, plus a section per model that had none; the input itself when there are no options.
 */
export function applyModelPresetOptions(sections, options) {
  const entries = Object.entries(options || {});
  if (!entries.length) return sections;
  const out = sections.map((s) => (options[s.name] ? { ...s, options: { ...s.options, ...options[s.name] } } : s));
  const present = new Set(out.map((s) => s.name));
  for (const [name, opts] of entries) if (!present.has(name)) out.push({ name, options: { ...opts } });
  return out;
}

/**
 * @param {Object<string, Object<string,string>>} options normalized operator options.
 * @param {string} modelId exact local model id.
 * @returns {number|null} the model's own context window, or null when it uses the default.
 */
export function modelContextOverride(options, modelId) {
  const ctx = options?.[modelId]?.['ctx-size'];
  return ctx ? Number(ctx) : null;
}

/**
 * @param {Object<string, Object<string,string>>} options normalized operator options.
 * @returns {boolean} true when some model sets its own context, which the router only honours
 *   when the default context lives in the preset's [*] section rather than on its CLI.
 */
export function wantsPresetContextMode(options) {
  return Object.values(options || {}).some((o) => o['ctx-size']);
}
