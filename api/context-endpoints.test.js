// Llama Manager — contract tests for exact count and preparation upstream calls.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies that manager-only cache controls never reach untrusted upstreams and
// that native llama.cpp input-token responses retain exact model/engine metadata.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { requestExactInputTokens } from './context-endpoints.js';

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
