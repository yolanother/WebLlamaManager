// Llama Manager — manager request extension policy tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies parsing and upstream removal of routing and priority extensions so
// privacy pins and scheduling intent remain manager-owned controls.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { managerRequestPolicy, stripManagerRequestFields } from './request-policy.js';

test('reads priority and local-only routing from body extensions', () => {
  assert.deepEqual(
    managerRequestPolicy({ request_priority: 'realtime', routing: 'local_only' }),
    { priority: 'realtime', routing: 'local_only', localOnly: true, cachePrompt: undefined },
  );
});

test('headers override body values and invalid values fail clearly', () => {
  assert.deepEqual(
    managerRequestPolicy(
      { request_priority: 'background', routing: 'auto' },
      { 'x-llama-priority': 'interactive', 'x-llama-routing': 'local_only' },
    ),
    { priority: 'interactive', routing: 'local_only', localOnly: true, cachePrompt: undefined },
  );
  assert.throws(() => managerRequestPolicy({ routing: 'cloud_if_busy' }), /routing/);
});

test('removes manager-only controls and untrusted raw slot ids upstream', () => {
  assert.deepEqual(stripManagerRequestFields({
    model: 'model-a', messages: [], id_slot: 3, cache_prompt: false,
    request_priority: 'realtime', routing: 'local_only', prepared_context_id: 'ctx_1',
  }), { model: 'model-a', messages: [] });
});

// --- caller opt-out of prompt caching ---------------------------------------
//
// cache_prompt is a manager-owned field: it is stripped from the caller body and
// then forced to true whenever a slot is assigned. That left callers with no way to
// turn prompt reuse off, which matters for agentic callers whose turns must not
// inherit a previous turn's context, and it removed the one control needed to
// isolate a suspected cross-request contamination (task T312355e5c5620).
//
// Opting OUT is the only thing a caller may do. Forcing caching ON stays a manager
// decision, so an explicit true is not honoured as an override.

test('a caller can opt out of prompt caching from the body', () => {
  assert.equal(managerRequestPolicy({ cache_prompt: false }, {}).cachePrompt, false);
});

test('a caller can opt out with a header, which wins over the body', () => {
  assert.equal(
    managerRequestPolicy({ cache_prompt: true }, { 'x-llama-cache-prompt': 'false' }).cachePrompt,
    false,
  );
});

test('saying nothing leaves the decision to the manager', () => {
  assert.equal(managerRequestPolicy({}, {}).cachePrompt, undefined);
});

test('an explicit true is not an override, only opting out is honoured', () => {
  assert.equal(managerRequestPolicy({ cache_prompt: true }, {}).cachePrompt, undefined);
});

test('a non-boolean cache_prompt is ignored rather than treated as opting out', () => {
  for (const value of ['no', 0, null, {}, 'false']) {
    assert.equal(managerRequestPolicy({ cache_prompt: value }, {}).cachePrompt, undefined,
      `${JSON.stringify(value)} must not be read as false`);
  }
});

test('cache_prompt is still stripped from the upstream body', () => {
  // The manager sets the real value itself; the caller's copy must never pass through.
  assert.equal('cache_prompt' in stripManagerRequestFields({ cache_prompt: false, model: 'm' }), false);
});

test('the chat proxy honours the opt-out instead of forcing cache_prompt true', () => {
  // Regression pin: this was `proxyBody.cache_prompt = true;` unconditionally, which
  // left callers no way to disable prompt reuse and removed the control needed to
  // isolate a suspected cross-request contamination.
  const source = readFileSync(fileURLToPath(new URL('./server.js', import.meta.url)), 'utf8');
  assert.match(source, /proxyBody\.cache_prompt = requestPolicy\?\.cachePrompt !== false;/);
  assert.doesNotMatch(source, /proxyBody\.cache_prompt = true;/);
});
