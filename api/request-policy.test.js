// Llama Manager — manager request extension policy tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies parsing and upstream removal of routing and priority extensions so
// privacy pins and scheduling intent remain manager-owned controls.

import assert from 'node:assert/strict';
import test from 'node:test';
import { managerRequestPolicy, stripManagerRequestFields } from './request-policy.js';

test('reads priority and local-only routing from body extensions', () => {
  assert.deepEqual(
    managerRequestPolicy({ request_priority: 'realtime', routing: 'local_only' }),
    { priority: 'realtime', routing: 'local_only', localOnly: true },
  );
});

test('headers override body values and invalid values fail clearly', () => {
  assert.deepEqual(
    managerRequestPolicy(
      { request_priority: 'background', routing: 'auto' },
      { 'x-llama-priority': 'interactive', 'x-llama-routing': 'local_only' },
    ),
    { priority: 'interactive', routing: 'local_only', localOnly: true },
  );
  assert.throws(() => managerRequestPolicy({ routing: 'cloud_if_busy' }), /routing/);
});

test('removes manager-only controls and untrusted raw slot ids upstream', () => {
  assert.deepEqual(stripManagerRequestFields({
    model: 'model-a', messages: [], id_slot: 3, cache_prompt: false,
    request_priority: 'realtime', routing: 'local_only', prepared_context_id: 'ctx_1',
  }), { model: 'model-a', messages: [] });
});
