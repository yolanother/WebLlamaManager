// Llama Manager — one-time seed of the Strata preset and the default aliases.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Recreates a Strata host's serving state on a fresh install: the
// `strata-qwen38-flash-iq3s` preset (Qwen3.8-Flash-Next IQ3_S, 131072 context),
// `default-big` and `default-small` pointing at it, and boot re-activation of it.
// drakemore carried all of that only in a hand-edited config.json, so an ISO reflash
// came up unable to serve the aliases Frostburn forwards to it. Seeds once, only when
// Strata is configured (the llama-manager-strata package's defaults or an operator
// block) and every file the preset loads exists under the documented host layout
// (docs/strata-engine.md "Host setup"); otherwise it reports what is missing and the
// next boot tries again. Pure: the caller injects the file check and persists.

export const STRATA_PRESET_ID = 'strata-qwen38-flash-iq3s';

const PACK = '/volumes/models/strata/packs/iq3_s';
const NATIVE = '/volumes/models/IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00001-of-00002.gguf';
const PLE = '/volumes/models/IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00002-of-00002.gguf';
const PROFILE = '/opt/strata/src/data/expert-profile.bin';
const MTP = '/volumes/models/strata/mtp/rt';
const TOKENIZER = `${PACK}/tokenizer`;

/** @returns {object} the Strata preset drakemore serves (live config 2026-10-31). */
export function strataDefaultPreset() {
  return {
    id: STRATA_PRESET_ID,
    name: 'Qwen3.8 Flash Next (Strata IQ3_S)',
    engine: 'strata',
    description: 'Qwen3.8-Flash-Next GSQ-RCO IQ3_S on Strata (Strix Halo iGPU / HIP)',
    context: 131072,
    strata: {
      args: ['--pack', PACK, '--native', NATIVE, '--ple-gguf', PLE, '--expert-profile', PROFILE,
        '--prefill', '16384', '--spec', '5', '--spec-min-p', '0.5', '--mtp', MTP, '--kv', 'int8',
        '--kv-resident', '32768', '--mtp-window', '8192', '--lookup-chain', '3', '--mtp-q4', 'all'],
      tokenizer: TOKENIZER,
      modelName: 'Qwen3.8-Flash-Next',
    },
  };
}

/**
 * Seed once. Overwrites `default-big`/`default-small` on that first seed (on a fresh box
 * the duo seed may already have claimed them); keeps an existing preset with the same id
 * and an existing boot preset.
 * @param {object} config Manager config, mutated in place.
 * @param {{strataEnabled: boolean, exists: (path: string) => boolean}} deps whether Strata
 *   resolves to a usable config, and a file-existence check.
 * @returns {{changed: boolean, missing: string[]}} whether to persist, and the files that
 *   held the seed back.
 */
export function seedStrataPreset(config, { strataEnabled, exists }) {
  if (config.strataSeeded || !strataEnabled) return { changed: false, missing: [] };
  const missing = [PACK, NATIVE, PLE, PROFILE, MTP, TOKENIZER].filter((p) => !exists(p));
  if (missing.length) return { changed: false, missing };
  config.presets = { ...config.presets };
  config.presets[STRATA_PRESET_ID] ??= strataDefaultPreset();
  config.aliases = { ...config.aliases };
  for (const name of ['default-big', 'default-small']) {
    config.aliases[name] = { targets: [{ host: 'local', model: STRATA_PRESET_ID }] };
  }
  config.lastExclusivePreset ??= STRATA_PRESET_ID;
  config.strataSeeded = true;
  return { changed: true, missing: [] };
}
