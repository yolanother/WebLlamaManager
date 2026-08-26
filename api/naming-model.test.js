/**
 * Copyright (c) Llama Manager project. Use of this file is governed by the
 * LICENSE file in the repository root.
 *
 * Specifies which model the node-naming completion asks for. It cannot ask for
 * an alias the appliance does not define: doing so failed every naming request
 * on real hardware with "model 'default-small' not found", and the kiosk told
 * the operator the model had returned no usable names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNamingModel } from './naming-model.js';

test('a real loaded model is preferred over any alias', () => {
  // MEASURED: the appliance ships Qwen3-8B-Q4_K_M and defines no
  // "default-small" alias, so 'auto' resolved to a model that does not exist.
  assert.equal(resolveNamingModel({ models: ['Qwen3-8B-Q4_K_M'] }), 'Qwen3-8B-Q4_K_M');
});

test('the first model wins when several are present', () => {
  assert.equal(resolveNamingModel({ models: ['a-model', 'b-model'] }), 'a-model');
});

test('it falls back to auto when nothing is loaded', () => {
  // Better to let the manager route than to invent a name: on an install that
  // does define aliases, 'auto' is exactly right.
  assert.equal(resolveNamingModel({ models: [] }), 'auto');
  assert.equal(resolveNamingModel({}), 'auto');
});

test('junk entries are ignored rather than sent upstream', () => {
  assert.equal(resolveNamingModel({ models: [null, '', '  ', 'real-model'] }), 'real-model');
});
