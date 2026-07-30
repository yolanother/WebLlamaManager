// Llama Manager API documentation endpoint search behavior tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies that endpoint discovery searches the active API inventory across
// its user-visible method, path, summary, and description fields.

import test from 'node:test';
import assert from 'node:assert/strict';
import { filterApiEndpoints } from './api-docs-search.js';

const endpoints = [
  {
    id: 'get-/api/models',
    method: 'GET',
    path: '/api/models',
    summary: 'List managed models',
    description: 'Returns every model known to Llama Manager.'
  },
  {
    id: 'post-/v1/chat/completions',
    method: 'POST',
    path: '/v1/chat/completions',
    summary: 'Create chat completion',
    description: 'Runs inference for an OpenAI-compatible chat request.'
  }
];

test('filters endpoints case-insensitively across method, path, summary, and description', () => {
  assert.deepEqual(filterApiEndpoints(endpoints, 'post'), [endpoints[1]]);
  assert.deepEqual(filterApiEndpoints(endpoints, 'API/MODELS'), [endpoints[0]]);
  assert.deepEqual(filterApiEndpoints(endpoints, 'managed models'), [endpoints[0]]);
  assert.deepEqual(filterApiEndpoints(endpoints, 'OPENAI-COMPATIBLE'), [endpoints[1]]);
});

test('a blank query returns the original inventory without mutating it', () => {
  const snapshot = structuredClone(endpoints);

  assert.strictEqual(filterApiEndpoints(endpoints, '   '), endpoints);
  assert.deepEqual(endpoints, snapshot);
});
