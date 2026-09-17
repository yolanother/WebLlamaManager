// Llama Manager — tests for alias-aware reasoning-effort target matching.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// The bug these pin: reasoning bounds are keyed by model family, callers ask by alias, and
// an alias name matches no family pattern — so `default-big` reached Qwen3.6-35B-A3B with
// no bound and spent its whole output budget reasoning. Pure input/output: no server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reasoningEffortMatchNames } from './reasoning-effort-targets.js';
import { modelPatternMatches } from './config-defaults.js';

/** The real Frostburn shape: `default-big` fronting the 35B, warm locally and on drakemore. */
const resolveBig = (name) =>
  name === 'default-big'
    ? {
        candidates: [
          { model: 'unsloth_Qwen3.6-35B-A3B-GGUF', host: 'local' },
          { model: 'unsloth_Qwen3.6-35B-A3B-GGUF', host: 'drakemore' },
        ],
      }
    : null;

test('an alias matches the family pattern of the model it resolves to', () => {
  const names = reasoningEffortMatchNames('default-big', resolveBig);
  // The exact production pattern from DEFAULT_MODEL_REASONING_EFFORT.
  assert.ok(
    names.some((n) => modelPatternMatches('*qwen3.6-35b*', n)),
    'default-big must match *qwen3.6-35b* via its resolved target',
  );
});

test('the requested name comes first and duplicates collapse', () => {
  assert.deepEqual(reasoningEffortMatchNames('default-big', resolveBig), [
    'default-big',
    'unsloth_Qwen3.6-35B-A3B-GGUF',
  ]);
});

test('a literal model id still matches with no alias routing', () => {
  const names = reasoningEffortMatchNames('unsloth_Qwen3.6-35B-A3B-GGUF', () => null);
  assert.deepEqual(names, ['unsloth_Qwen3.6-35B-A3B-GGUF']);
  assert.ok(names.some((n) => modelPatternMatches('*qwen3.6-35b*', n)));
});

test('an unrelated alias does not pick up another family bound', () => {
  const names = reasoningEffortMatchNames('default-small', (n) =>
    n === 'default-small' ? { candidates: [{ model: 'Qwen_Qwen3-8B-GGUF' }] } : null,
  );
  assert.equal(names.some((n) => modelPatternMatches('*qwen3.6-35b*', n)), false);
});

test('a throwing resolver degrades to the literal name', () => {
  const names = reasoningEffortMatchNames('default-big', () => {
    throw new Error('alias inventory unavailable');
  });
  assert.deepEqual(names, ['default-big']);
});

test('malformed candidates are ignored rather than thrown on', () => {
  const names = reasoningEffortMatchNames('a', () => ({
    candidates: [null, {}, { model: '' }, { model: 'real-model' }],
  }));
  assert.deepEqual(names, ['a', 'real-model']);
});
