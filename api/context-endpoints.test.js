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
import { TimingEvidenceRecorder, TIMING_EVIDENCE_PROFILES } from './timing-evidence.js';

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

test('requestExactInputTokens brackets only the tokenization call on an optional recorder', async () => {
  const state = { t: 0 };
  const clock = () => state.t;
  const recorder = new TimingEvidenceRecorder({
    requestId: 'req_count',
    profile: TIMING_EVIDENCE_PROFILES.COUNT,
    clock,
  });
  recorder.setIdentity({ requestedModel: 'voice-fast', resolvedModel: 'gemma-real', engine: 'llama' });
  recorder.mark('received');
  recorder.mark('admitted');

  const fetchImpl = async () => {
    state.t += 17;
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
    body: { messages: [{ role: 'user', content: 'hello' }] },
    fetchImpl,
    recorder,
  });

  const record = recorder.build();
  assert.equal(record.manager_observed.tokenization.ms, 17);
  assert.equal(record.manager_observed.tokenization.source, 'manager_measured_tokenization_call');
  // The public count payload shape is unchanged by recording.
  assert.equal(result.input_tokens, 130);
  assert.equal('timing_evidence' in result, false);
});

test('requestExactInputTokens leaves tokenization unmeasured when the upstream call fails', async () => {
  const recorder = new TimingEvidenceRecorder({
    requestId: 'req_fail',
    profile: TIMING_EVIDENCE_PROFILES.COUNT,
    clock: () => 0,
  });
  recorder.setIdentity({ resolvedModel: 'gemma-real', engine: 'llama' });
  recorder.mark('received');
  recorder.mark('admitted');

  const fetchImpl = async () => new Response('upstream exploded', { status: 500 });
  await assert.rejects(() => requestExactInputTokens({
    kind: 'chat',
    baseUrl: 'http://llama:5251',
    resolvedModel: 'gemma-real',
    engine: 'llama',
    body: {},
    fetchImpl,
    recorder,
  }));

  const record = recorder.build();
  assert.equal(record.manager_observed.tokenization.supported, false);
  assert.equal(record.manager_observed.tokenization.reason, 'phase_not_reached');
  assert.equal(record.complete, false);
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

test('contextPrefixRequestHash pins the documented canonical request-hash algorithm', () => {
  // Pinned vector: the exact downstream certification probe. Changing this value
  // is a breaking contract change and must bump the context-cache contract.
  const hash = contextPrefixRequestHash({
    model: 'alias-ignored',
    messages: [
      { role: 'system', content: 'Live contract probe.' },
      { role: 'developer', content: 'Count only.' },
    ],
  }, 'google_gemma-4-E2B-it-qat-q4_0-gguf');

  assert.equal(hash, 'request_420109ab0e99f605a112758cc53f33a73311544d');
  assert.equal(/^request_[0-9a-f]{40}$/.test(hash), true);
});

test('contextPrefixRequestHash is stable across key order and exact over Unicode', () => {
  const ordered = contextPrefixRequestHash({
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'a' } }],
    response_format: { type: 'json_object' },
  }, 'gemma-real');
  const reordered = contextPrefixRequestHash({
    response_format: { type: 'json_object' },
    tools: [{ type: 'function', function: { name: 'a' } }],
    messages: [{ role: 'user', content: 'hello' }],
  }, 'gemma-real');
  assert.equal(ordered, reordered);

  assert.equal(
    contextPrefixRequestHash({ messages: [{ role: 'user', content: 'héllo — ünïcode ✅' }] }, 'gemma-real'),
    'request_85e1049e2e481490b8cb2f769ec06f6233e44161',
  );
  assert.notEqual(
    contextPrefixRequestHash({ messages: [{ role: 'user', content: 'héllo' }] }, 'gemma-real'),
    contextPrefixRequestHash({ messages: [{ role: 'user', content: 'hello' }] }, 'gemma-real'),
  );
});

test('contextPrefixRequestHash binds input-affecting fields and the resolved model only', () => {
  const body = { messages: [{ role: 'user', content: 'hello' }] };
  const base = contextPrefixRequestHash(body, 'gemma-real');

  // Input mutation changes identity.
  assert.notEqual(base, contextPrefixRequestHash({ messages: [{ role: 'user', content: 'hello!' }] }, 'gemma-real'));
  assert.notEqual(base, contextPrefixRequestHash({ ...body, tools: [{ type: 'function' }] }, 'gemma-real'));
  assert.notEqual(base, contextPrefixRequestHash({ ...body, chat_template_kwargs: { thinking: true } }, 'gemma-real'));

  // Resolved-model mutation changes identity even when the alias is unchanged.
  assert.notEqual(base, contextPrefixRequestHash(body, 'gemma-other'));

  // Output-only and transport-only controls do not: they are published separately
  // as priority / residentOnly / residencySource.
  assert.equal(base, contextPrefixRequestHash({
    ...body, model: 'voice-fast', stream: true, max_tokens: 128, temperature: 0.9,
    priority: 'background', request_priority: 'background', resident_only: true,
    routing: 'local_only', mode: 'count', id_slot: 3, prepared_context_id: 'ctx-secret',
  }, 'gemma-real'));

  // The hash is opaque: no prompt text or credential material survives into it.
  assert.equal(base.includes('hello'), false);
  assert.equal(base.includes('gemma-real'), false);
});
