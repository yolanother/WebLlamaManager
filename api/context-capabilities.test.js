// Llama Manager — context capability metadata tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Ensures engine declarations are explicit and versioned so clients never infer
// exact counting, KV preparation, persistence, or routing guarantees.

import assert from 'node:assert/strict';
import test from 'node:test';
import { contextCapabilities } from './context-capabilities.js';

test('llama advertises exact context management and bounded limits', () => {
  const capabilities = contextCapabilities('llama', { slotCacheEnabled: true });
  assert.equal(capabilities.version, 1);
  assert.equal(capabilities.exact_input_tokens, true);
  assert.equal(capabilities.prepared_context, true);
  assert.equal(capabilities.persisted_kv, true);
  assert.equal(capabilities.zero_decode_prefill, false);
  assert.equal(capabilities.discarded_prefill_decode_tokens, 1);
  assert.equal(capabilities.priority_classes.realtime, true);
  assert.equal(capabilities.routing.local_only, true);
  assert.equal(capabilities.limits.prepared_ttl_seconds, 900);
});

test('unsupported engines explicitly disable local context operations', () => {
  const capabilities = contextCapabilities('ds4');
  assert.equal(capabilities.exact_input_tokens, false);
  assert.equal(capabilities.prepared_context, false);
  assert.equal(capabilities.persisted_kv, false);
  assert.equal(capabilities.routing.local_only, true);
});
