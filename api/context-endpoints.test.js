// Llama Manager — contract tests for exact count and preparation upstream calls.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies that manager-only cache controls never reach untrusted upstreams and
// that native llama.cpp input-token responses retain exact model/engine metadata.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  contextPrefixRequestHash,
  requestExactInputTokens,
  requestRenderedPrefix,
} from './context-endpoints.js';

test('requestExactInputTokens proxies the native endpoint with resolved model and strips slot controls', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 130 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await requestExactInputTokens({
    kind: 'chat',
    baseUrl: 'http://llama:5251',
    requestedModel: 'voice-fast',
    resolvedModel: 'gemma-real',
    engine: 'llama',
    body: {
      model: 'voice-fast', messages: [{ role: 'user', content: 'hello' }],
      id_slot: 9, cache_prompt: false, prepared_context_id: 'ctx-secret',
      conversation_cache_key: 'conversation-secret',
    },
    fetchImpl,
  });

  assert.equal(captured.url, 'http://llama:5251/v1/chat/completions/input_tokens');
  assert.equal(captured.body.model, 'gemma-real');
  assert.equal('id_slot' in captured.body, false);
  assert.equal('prepared_context_id' in captured.body, false);
  assert.equal('conversation_cache_key' in captured.body, false);
  assert.deepEqual(result, {
    object: 'response.input_tokens', input_tokens: 130,
    requested_model: 'voice-fast', resolved_model: 'gemma-real', engine: 'llama',
    context_cache_contract: 1,
  });
});

test('contextPrefixRequestHash ignores output controls but changes with prefix material', () => {
  const base = { model: 'a', messages: [{ role: 'user', content: 'hello' }], max_tokens: 10, stream: true };
  assert.equal(
    contextPrefixRequestHash(base, 'resolved'),
    contextPrefixRequestHash({ ...base, max_tokens: 100, stream: false }, 'resolved'),
  );
  assert.notEqual(
    contextPrefixRequestHash(base, 'resolved'),
    contextPrefixRequestHash({ ...base, messages: [{ role: 'user', content: 'changed' }] }, 'resolved'),
  );
});

test('requestRenderedPrefix hashes the exact upstream template without returning prompt text', async () => {
  const result = await requestRenderedPrefix({
    baseUrl: 'http://llama:5251',
    resolvedModel: 'gemma-real',
    body: { messages: [{ role: 'user', content: 'secret' }], tools: [{ type: 'function' }] },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'gemma-real');
      return new Response(JSON.stringify({ prompt: '<bos>rendered secret prompt' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(result.prefix_hash.startsWith('prefix_'), true);
  assert.equal('prompt' in result, false);
});
