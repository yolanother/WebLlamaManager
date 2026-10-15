// Llama Manager — Strata preset form helper tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies parseStrataArgs (whitespace/newline splitting, empties dropped) and
// buildStrataPresetBody (form -> engine:'strata' preset body per
// docs/Designs/StrataEngine.md section 5.1, context default 262144).

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseStrataArgs, buildStrataPresetBody } from './strata-preset.js';

test('parseStrataArgs splits on any whitespace including newlines', () => {
  assert.deepEqual(parseStrataArgs('--spec 5\n--kv  int8\t--mtp-q4\r\nall'),
    ['--spec', '5', '--kv', 'int8', '--mtp-q4', 'all']);
});

test('parseStrataArgs drops empties and handles empty input', () => {
  assert.deepEqual(parseStrataArgs(''), []);
  assert.deepEqual(parseStrataArgs('  \n \t '), []);
  assert.deepEqual(parseStrataArgs('  --a   \n\n --b  '), ['--a', '--b']);
});

const form = {
  id: 'strata-x',
  name: 'Strata X',
  description: 'desc',
  context: '131072',
  argsText: '--pack /p\n--spec 5',
  tokenizer: '/abs/tok',
  modelName: 'Qwen3.8-Flash-Next',
};

test('buildStrataPresetBody builds the section 5.1 shape', () => {
  const body = buildStrataPresetBody(form);
  assert.equal(body.engine, 'strata');
  assert.equal(body.name, 'Strata X');
  assert.equal(body.context, 131072);
  assert.deepEqual(body.strata.args, ['--pack', '/p', '--spec', '5']);
  assert.equal(body.strata.tokenizer, '/abs/tok');
  assert.equal(body.strata.modelName, 'Qwen3.8-Flash-Next');
  assert.equal(body.description, 'desc');
});

test('buildStrataPresetBody defaults context to 262144', () => {
  for (const context of ['', undefined, 'abc', 0]) {
    assert.equal(buildStrataPresetBody({ ...form, context }).context, 262144);
  }
});

test('buildStrataPresetBody tolerates omitted optional fields', () => {
  const body = buildStrataPresetBody({ name: 'N', context: '', argsText: '', tokenizer: '/t' });
  assert.equal(body.engine, 'strata');
  assert.equal(body.context, 262144);
  assert.deepEqual(body.strata.args, []);
  assert.equal(body.strata.tokenizer, '/t');
});
