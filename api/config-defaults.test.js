// Llama Manager — configuration-default merge contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Proves package/environment defaults populate an empty persisted config while
// explicit operator values always remain authoritative — except autoStart,
// where AUTO_START=false is a fail-safe veto over a persisted autoStart:true
// (T31079087d6a20: a persisted autoStart:true from a prior run silently
// defeated a boot-time AUTO_START=false override, letting an instance
// auto-start an engine it wasn't supposed to).

import assert from 'node:assert/strict';
import test from 'node:test';

import { applyConfigDefaults,
  DEFAULT_MODEL_REASONING_EFFORT,
  modelPatternMatches,
} from './config-defaults.js';

test('empty persisted config inherits packaged environment defaults', () => {
  assert.deepEqual(applyConfigDefaults({}, {
    AUTO_START: 'true',
    MODELS_MAX: '3',
    CONTEXT_SIZE: '16384',
  }), {
    autoStart: true,
    modelsMax: 3,
    contextSize: 16384,
    logFilters: [],
    requestLogging: false,
    maxConcurrentRequests: 1,
    modelReasoningEffort: DEFAULT_MODEL_REASONING_EFFORT,
  });
});

test('absent environment values retain stable source defaults', () => {
  const config = applyConfigDefaults({}, {});
  assert.equal(config.autoStart, true);
  assert.equal(config.modelsMax, 2);
  assert.equal(config.contextSize, 8192);
});

test('explicit persisted values override every environment default', () => {
  const config = applyConfigDefaults({
    autoStart: false,
    modelsMax: 7,
    contextSize: 32768,
  }, {
    AUTO_START: 'true',
    MODELS_MAX: '3',
    CONTEXT_SIZE: '16384',
  });
  assert.equal(config.autoStart, false);
  assert.equal(config.modelsMax, 7);
  assert.equal(config.contextSize, 32768);
});

test('AUTO_START=false vetoes autoStart even over a persisted autoStart:true', () => {
  const config = applyConfigDefaults({ autoStart: true }, { AUTO_START: 'false' });
  assert.equal(config.autoStart, false);
});

test('AUTO_START=false vetoes autoStart with no persisted autoStart key at all', () => {
  const config = applyConfigDefaults({}, { AUTO_START: 'false' });
  assert.equal(config.autoStart, false);
});

// --- default reasoning effort for models that reason unboundedly ------------------
//
// api/duo-chain.js records the measurement, same model and prompt, only this varying:
//   default          finish=length content=0     reasoning=17,145 chars (max_tokens 4096)
//   default          finish=length content=0     reasoning=51,763 chars (max_tokens 12000)
//   reasoning_effort finish=stop   content=6,895 reasoning= 1,211 chars (max_tokens 3000)
// duo applies a bounded effort to every step and is protected. The DIRECT path was not,
// and a real consumer hit exactly the middle row: 12,000 output tokens, no verdict JSON
// (T312677f9f21cc). Raising max_tokens makes it WORSE, not better.

test('reasoning models get a bounded effort by default', () => {
  const c = applyConfigDefaults({});
  assert.equal(c.modelReasoningEffort['*qwen3.6-35b*'], 'medium');
  assert.equal(c.modelReasoningEffort['*qwen3.8-flash-next*'], 'medium');
  assert.equal(c.modelReasoningEffort['*qwen3.8-27b*'], 'medium');
});

test('an operator value overrides that pattern and keeps the rest of the defaults', () => {
  const c = applyConfigDefaults({ modelReasoningEffort: { '*qwen3.6-35b*': 'low' } });
  assert.equal(c.modelReasoningEffort['*qwen3.6-35b*'], 'low', 'the operator wins');
  assert.equal(c.modelReasoningEffort['*qwen3.8-27b*'], 'medium', 'the others still apply');
});

test('an EMPTY persisted map still gets the defaults', () => {
  // Reversal of an earlier decision here, on evidence. Treating {} as "deliberately
  // cleared" made the defaults inert on exactly the box that needed them: drakemore had
  // `modelReasoningEffort: {}` persisted from initialisation, never an operator choice,
  // so the fix silently did nothing there while working on a fresh install. {} is what an
  // uninitialised box looks like, not an instruction.
  assert.deepEqual(applyConfigDefaults({ modelReasoningEffort: {} }).modelReasoningEffort,
    { ...DEFAULT_MODEL_REASONING_EFFORT });
});

test('a pattern can be disabled explicitly with a null value', () => {
  // The escape hatch the empty map used to be, made unambiguous.
  const c = applyConfigDefaults({ modelReasoningEffort: { '*qwen3.6-35b*': null } });
  assert.equal(c.modelReasoningEffort['*qwen3.6-35b*'], null);
  assert.equal(c.modelReasoningEffort['*qwen3.8-27b*'], 'medium');
});

test('defaultReasoningEffort is NOT set globally', () => {
  // A global default would hit non-reasoning models too, where the kwarg is meaningless.
  // The patterns are deliberately narrow.
  assert.equal(applyConfigDefaults({}).defaultReasoningEffort, undefined);
});

test('the seeded patterns match the real model ids and nothing else', () => {
  const pats = Object.keys(applyConfigDefaults({}).modelReasoningEffort);
  const rx = (p) => new RegExp('^' + p.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  const hits = (id) => pats.some((p) => rx(p).test(id));
  assert.ok(hits('unsloth_Qwen3.6-35B-A3B-GGUF'), 'the duo worker');
  assert.ok(hits('unsloth_Qwen3.8-Flash-Next-GGUF'), 'the duo planner');
  assert.ok(hits('unsloth_Qwen3.8-27B-GGUF'), 'the 27B');
  assert.equal(hits('Qwen_Qwen3-8B-GGUF'), false, 'Qwen3-8B is a different family');
  assert.equal(hits('unsloth_Muse-Glimmer-30B-GGUF'), false, 'unrelated model');
});

// --- the glob matcher itself ------------------------------------------------------
//
// Two footguns found while seeding the defaults above, both silent:
//   1. metacharacters were not escaped, so the '.' in 'qwen3.8' was a WILDCARD and
//      '*qwen3.8*' also matched 'Qwen3-8B' — an unrelated model family.
//   2. matching was case-SENSITIVE, so a lowercase pattern never matched a real model id
//      like 'unsloth_Qwen3.6-35B-A3B-GGUF'. An operator's pattern would simply do nothing.

test('modelPatternMatches treats . as a literal, not a wildcard', () => {
  assert.equal(modelPatternMatches('*qwen3.8*', 'unsloth_Qwen3.8-27B-GGUF'), true);
  assert.equal(modelPatternMatches('*qwen3.8*', 'Qwen_Qwen3-8B-GGUF'), false,
    'a dash is not a dot; this collision is the bug');
});

test('modelPatternMatches is case-insensitive, as model ids are mixed case', () => {
  assert.equal(modelPatternMatches('*qwen3.6-35b*', 'unsloth_Qwen3.6-35B-A3B-GGUF'), true);
  assert.equal(modelPatternMatches('*QWEN3.6-35B*', 'unsloth_qwen3.6-35b-a3b-gguf'), true);
});

test('modelPatternMatches keeps * and ? working as globs', () => {
  assert.equal(modelPatternMatches('gpt-oss*', 'gpt-oss-2025'), true);
  assert.equal(modelPatternMatches('gpt-os?', 'gpt-oss'), true);
  assert.equal(modelPatternMatches('gpt-oss*', 'other-model'), false);
});

test('other regex metacharacters are literal too', () => {
  assert.equal(modelPatternMatches('a+b', 'a+b'), true);
  assert.equal(modelPatternMatches('a+b', 'aab'), false);
  assert.equal(modelPatternMatches('m(1)', 'm(1)'), true);
});

test('the seeded defaults match their real model ids through the REAL matcher', () => {
  const seeded = DEFAULT_MODEL_REASONING_EFFORT;
  const effortFor = (id) => {
    for (const [p, v] of Object.entries(seeded)) if (modelPatternMatches(p, id)) return v;
    return null;
  };
  assert.equal(effortFor('unsloth_Qwen3.6-35B-A3B-GGUF'), 'medium');
  assert.equal(effortFor('unsloth_Qwen3.8-Flash-Next-GGUF'), 'medium');
  assert.equal(effortFor('unsloth_Qwen3.8-27B-GGUF'), 'medium');
  assert.equal(effortFor('Qwen_Qwen3-8B-GGUF'), null, 'a different family, must be untouched');
  assert.equal(effortFor('unsloth_Muse-Glimmer-30B-GGUF'), null);
});
