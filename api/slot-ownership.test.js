// Llama Manager — tests for safe llama.cpp slot ownership transitions.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies that a newly assigned conversation slot is erased before use and
// that an erase failure is fail-closed instead of allowing stale cross-scope KV
// state to participate in prompt matching.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { eraseSlotForColdAssignment, SlotOwnershipError } from './slot-ownership.js';

test('eraseSlotForColdAssignment clears the concrete model slot before cold use', async () => {
  let captured;
  const erased = await eraseSlotForColdAssignment({
    baseUrl: 'http://localhost:5251/',
    model: 'gemma-real',
    slotId: 2,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    },
  });

  assert.equal(erased, true);
  assert.equal(captured.url, 'http://localhost:5251/slots/2?action=erase');
  assert.equal(captured.init.method, 'POST');
  assert.deepEqual(JSON.parse(captured.init.body), { model: 'gemma-real' });
});

test('eraseSlotForColdAssignment fails closed when stale KV cannot be erased', async () => {
  await assert.rejects(
    eraseSlotForColdAssignment({
      baseUrl: 'http://localhost:5251',
      model: 'gemma-real',
      slotId: 0,
      fetchImpl: async () => new Response('slot busy', { status: 409 }),
    }),
    error => error instanceof SlotOwnershipError && error.status === 503,
  );
});
