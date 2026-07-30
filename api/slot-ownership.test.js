// Llama Manager — tests for safe llama.cpp slot ownership transitions.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies that a newly assigned conversation slot is erased before use, that
// erase failure is fail-closed, and that router child-loading responses are
// awaited and retried before durable slot restore inspects resident state.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  eraseSlotForColdAssignment,
  fetchModelSlotsWhenReady,
  SlotOwnershipError,
} from './slot-ownership.js';

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

test('fetchModelSlotsWhenReady waits and retries when the router child is loading', async () => {
  const responses = [
    new Response('proxy error: Could not establish connection', { status: 500 }),
    new Response(JSON.stringify([{ id: 0, n_prompt_tokens_processed: 0 }]), { status: 200 }),
  ];
  const waited = [];
  const slots = await fetchModelSlotsWhenReady({
    baseUrl: 'http://localhost:5251',
    model: 'tinyllama',
    fetchImpl: async () => responses.shift(),
    waitForReady: async model => { waited.push(model); return true; },
  });

  assert.deepEqual(waited, ['tinyllama']);
  assert.deepEqual(slots, [{ id: 0, n_prompt_tokens_processed: 0 }]);
  assert.equal(responses.length, 0);
});

test('fetchModelSlotsWhenReady does not wait for non-loading slot failures', async () => {
  let waited = false;
  const slots = await fetchModelSlotsWhenReady({
    baseUrl: 'http://localhost:5251',
    model: 'multimodal',
    fetchImpl: async () => new Response('feature not supported', { status: 501 }),
    waitForReady: async () => { waited = true; return true; },
  });

  assert.equal(slots, null);
  assert.equal(waited, false);
});
