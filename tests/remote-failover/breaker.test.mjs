// Llama Manager — black-box test: caller-side errors never trip a backend's circuit breaker.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// W1 evidence 2026-10-31 02:32Z: drakemore served narration (default-small) and the podcast
// (default-big). Three narration calls in a row ended REASONING_EXHAUSTED (the caller's
// 250-token budget spent on thinking), Frostburn counted them as backend failures, tripped
// drakemore for 60 s, and the podcast's default-big got 503 "all remote members down or
// tripped" while Strata was serving. Real api/server.js in front of one fake drakemore
// that answers model `small` with REASONING_EXHAUSTED and `big` with 200.
// Run: node --test tests/remote-failover/breaker.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from './harness.mjs';

let stack;

before(async () => {
  stack = await startStack({
    backends: [{ id: 'drakemore', priority: 10, reasoningModel: 'small' }],
    aliases: {
      'default-small': { targets: [{ host: 'drakemore', model: 'small' }] },
      'default-big': { targets: [{ host: 'drakemore', model: 'big' }] },
    },
  });
});

after(() => stack?.stop());

test('five REASONING_EXHAUSTED 502s in a row do not trip the backend', async () => {
  for (let i = 0; i < 5; i++) {
    const res = await stack.chat('default-small');
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'REASONING_EXHAUSTED');
  }
  const res = await stack.chat('default-big');
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.choices[0].message.content, 'from drakemore');
  assert.equal(stack.hits.drakemore, 6, 'every call reached drakemore: nothing was short-circuited');
});
