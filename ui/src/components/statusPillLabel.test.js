// Llama Manager — status pill label logic tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies the healthy/starting/stopped state and the single-model vs.
// router label branches, with no browser dependency.

import test from 'node:test';
import assert from 'node:assert/strict';

import { statusPillLabel } from './statusPillLabel.js';

test('reports Stopped and Router (Multi) with no stats', () => {
  assert.deepEqual(statusPillLabel(null), {
    healthy: false,
    state: 'Stopped',
    modelLabel: 'Router (Multi)',
  });
});

test('reports Starting while a mode is set but nothing is healthy yet', () => {
  const result = statusPillLabel({ mode: 'router' });
  assert.equal(result.healthy, false);
  assert.equal(result.state, 'Starting');
  assert.equal(result.modelLabel, 'Router (Multi)');
});

test('reports Running with the formatted active model in single mode', () => {
  const result = statusPillLabel({
    mode: 'single',
    llama: { status: 'ok' },
    activeModel: 'qwen3-coder-next-00001-of-00002.gguf',
  });
  assert.equal(result.healthy, true);
  assert.equal(result.state, 'Running');
  assert.equal(result.modelLabel, 'qwen3-coder-next');
});

test('reports Router (Multi) in router mode even with an active model', () => {
  const result = statusPillLabel({
    mode: 'router',
    llama: { status: 'ok' },
    activeModel: 'qwen3-coder-next.gguf',
  });
  assert.equal(result.modelLabel, 'Router (Multi)');
});

test('is healthy via the ds4 engine even when llama is intentionally stopped', () => {
  const result = statusPillLabel({ mode: 'single', ds4: { status: 'ok' } });
  assert.equal(result.healthy, true);
  assert.equal(result.state, 'Running');
});
