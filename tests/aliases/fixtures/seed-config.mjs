// Llama Manager — pre-alias config fixture writer for the alias API smoke suite.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Writes a throwaway `config.json` that reproduces the shape of a real
// pre-migration operator config: remote backends carrying `modelMapping`
// (including one `{"*": ...}` catch-all host) plus the legacy top-level
// `defaultBigModel` / `defaultSmallModel` keys. The alias API smoke suite boots
// api/server.js against this file so it can assert that the one-time alias
// migration folds the mappings into `config.aliases`, diverts `*` to
// `backend.acceptsAny`, and drops the two legacy keys. Kept as a script rather
// than a static .json so the fixture can carry a project code header.

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/** Backend id of the two-mapping remote host used by the mapping assertions. */
export const BORETHRAX = 'borethrax-ollama-mnfmirep';

/** Backend id of the single-mapping remote host that back-compat writes target. */
export const DAHAKA = 'dahaka-ollama-mngx88pk';

/** Backend id of the `{"*": ...}` catch-all host that must become `acceptsAny`. */
export const EMBER = 'ember-mpleee8f';

/** Legacy `defaultBigModel` value the migration must seed into `default-big`. */
export const BIG_TARGET = 'Unsloth_gpt-oss-120b-GGUF_Q5_K_M_gpt-oss-120b-Q5_K_M';

/** Legacy `defaultSmallModel` value the migration must seed into `default-small`. */
export const SMALL_TARGET = 'Qwen_Qwen3-8B-GGUF';

/** Model name rewritten to by the catch-all host, expected as `acceptsAny`. */
export const ACCEPTS_ANY_TARGET = 'qwen3-8b-jetson:latest';

/**
 * Build the pre-alias configuration object.
 *
 * `autoStart` and `presetsSeeded` are pinned so booting the server neither
 * launches a llama engine nor rewrites the file with seeded presets, keeping the
 * only boot-time config mutation the alias migration under test. Remote routing
 * is left disabled so no background backend probe writes `lastTestTime` and
 * breaks the restart-idempotency comparison.
 *
 * @returns {object} A fresh pre-migration config document.
 */
export function preAliasConfig() {
  return {
    autoStart: false,
    presetsSeeded: true,
    modelsMax: 2,
    contextSize: 8192,
    requestLogging: false,
    maxConcurrentRequests: 1,
    logFilters: [],
    presets: {
      'gemma4-12b-chat': { model: 'gemini-4-12b', contextSize: 8192, args: [] },
    },
    defaultBigModel: BIG_TARGET,
    defaultSmallModel: SMALL_TARGET,
    backends: {
      enabled: false,
      offloadPolicy: 'overflow',
      offloadThresholdQueueDepth: 2,
      offloadThresholdWaitMs: 5000,
      offloadPercentage: 0,
      preferLocal: false,
      directory: [
        {
          id: BORETHRAX,
          name: 'Borethrax Ollama',
          url: 'http://borethrax.invalid:11434/v1',
          enabled: true,
          priority: 10,
          apiKeyEnvVar: '',
          modelMapping: { 'Qwen_Qwen3-8B-GGUF': 'qwen3-vl:8b', 'gemini-4-12b': 'gemma4:12b' },
          supportedEndpoints: ['chat/completions', 'completions', 'embeddings'],
          costs: { inputTokenCostPer1M: 0, outputTokenCostPer1M: 0, currency: 'USD' },
          sharedResourceWeight: 0,
          maxConcurrentRequests: 1,
          timeoutMs: 120000,
          tested: true,
          lastTestTime: 1779724373084,
        },
        {
          id: DAHAKA,
          name: 'Dahaka Ollama',
          url: 'http://dahaka.invalid:11434/v1',
          enabled: true,
          priority: 10,
          apiKeyEnvVar: '',
          modelMapping: { 'Qwen_Qwen3-8B-GGUF': 'qwen3:8b' },
          supportedEndpoints: ['chat/completions', 'completions', 'embeddings'],
          costs: { inputTokenCostPer1M: 0, outputTokenCostPer1M: 0, currency: 'USD' },
          sharedResourceWeight: 0,
          maxConcurrentRequests: 1,
          timeoutMs: 120000,
          tested: true,
          lastTestTime: 1775100964191,
        },
        {
          id: EMBER,
          name: 'Ember',
          url: 'http://ember.invalid:11434/v1',
          enabled: true,
          priority: 10,
          apiKeyEnvVar: '',
          modelMapping: { '*': ACCEPTS_ANY_TARGET },
          supportedEndpoints: ['chat/completions', 'completions', 'embeddings'],
          costs: { inputTokenCostPer1M: 0, outputTokenCostPer1M: 0, currency: 'USD' },
          sharedResourceWeight: 0,
          maxConcurrentRequests: 5,
          timeoutMs: 300000,
          tested: false,
          lastTestTime: 1779731382608,
        },
      ],
    },
  };
}

const dest = process.argv[2];
if (!dest) {
  console.error('usage: seed-config.mjs <dest-config.json>');
  process.exit(2);
}
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(preAliasConfig(), null, 2));
