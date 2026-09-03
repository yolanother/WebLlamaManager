// Llama Manager — public MCP inference and prepared-context tool contracts.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests verify the exported MCP tool catalog and its REST mapping. They
// exercise only the public tool descriptors and dispatcher, using a mocked HTTP
// boundary so no manager or model process is required.

import assert from 'node:assert/strict';
import test from 'node:test';

import { handleTool, tools } from './server.js';

/** Run a tool against a recording fetch boundary and restore the process global. */
async function captureToolCall(name, args) {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options = {}) => {
    captured = {
      url: String(url),
      method: options.method,
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    };
    return new Response(JSON.stringify({ ok: true, tool: name }), {
      status: name.includes('submit') || name.includes('prepare') ? 202 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await handleTool(name, args);
    return { captured, result };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('contract 10: MCP catalog exposes OpenAI Response and prepared-context tools', () => {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const expected = [
    'submit_response',
    'get_response',
    'cancel_response',
    'llama_prepare_context',
    'llama_get_prepared_context',
    'llama_release_prepared_context',
  ];
  for (const name of expected) {
    const tool = byName.get(name);
    assert.ok(tool, `missing MCP tool ${name}`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(Array.isArray(tool.inputSchema.required));
    assert.ok(tool.description.trim());
  }

  const submit = byName.get('submit_response');
  assert.deepEqual(submit.inputSchema.required, ['model', 'input']);
  for (const field of ['priority', 'routing', 'stream']) {
    assert.ok(submit.inputSchema.properties[field], `submit tool omits ${field}`);
  }
  assert.equal(submit.inputSchema.properties.prepared_context_id, undefined);
  assert.equal(submit.inputSchema.additionalProperties, false);
  assert.match(submit.description, /llama_chat/);
  assert.match(submit.description, /client|proxy/i);
  assert.match(submit.description, /budget/i);

  const chat = byName.get('llama_chat');
  assert.ok(chat.inputSchema.properties.prepared_context_id);
  assert.deepEqual(chat.inputSchema.properties.prepared_context_mode.enum, ['append']);
  assert.equal(chat.inputSchema.properties.context_cache_strict.type, 'boolean');

  const getResponse = byName.get('get_response');
  assert.deepEqual(getResponse.inputSchema.required, ['id']);
  assert.equal(getResponse.inputSchema.properties.stream.type, 'boolean');
  assert.equal(getResponse.inputSchema.properties.starting_after.type, 'integer');
  assert.match(getResponse.description, /sequence_number/);

  const prepare = byName.get('llama_prepare_context');
  assert.deepEqual(prepare.inputSchema.required, ['model', 'messages']);
  assert.deepEqual(prepare.inputSchema.properties.mode.enum, ['count', 'prefill']);
  assert.deepEqual(prepare.inputSchema.properties.priority.enum, ['interactive', 'background']);
  assert.equal(prepare.inputSchema.properties.resident_only.type, 'boolean');
});

test('contract 10: Response MCP tools mirror extensions and OpenAI-compatible REST methods', async () => {
  const argumentsBody = {
    model: 'voice-fast',
    input: [{ role: 'user', content: 'long request' }],
    temperature: 0.3,
    max_output_tokens: 50_000,
    priority: 'background',
    routing: 'local_only',
    stream: true,
  };
  const submitted = await captureToolCall('submit_response', argumentsBody);
  assert.equal(submitted.captured.url, 'http://localhost:5250/api/v1/responses');
  assert.equal(submitted.captured.method, 'POST');
  const { priority: _toolPriority, ...rest } = argumentsBody;
  assert.deepEqual(submitted.captured.body, { ...rest, request_priority: 'background', background: true });
  assert.equal(Object.hasOwn(submitted.captured.body, 'priority'), false, 'the inert tool-only name must not reach REST');
  assert.equal(submitted.result.data.ok, true);

  const chatted = await captureToolCall('llama_chat', {
    model: 'voice-fast',
    messages: [{ role: 'user', content: 'suffix' }],
    prepared_context_id: 'ctx_opaque',
    prepared_context_mode: 'append',
    context_cache_strict: true,
  });
  assert.equal(chatted.captured.url, 'http://localhost:5250/api/v1/chat/completions');
  assert.equal(chatted.captured.body.prepared_context_id, 'ctx_opaque');
  assert.equal(chatted.captured.body.prepared_context_mode, 'append');
  assert.equal(chatted.captured.body.context_cache_strict, true);

  const polled = await captureToolCall('get_response', { id: 'resp_opaque' });
  assert.equal(polled.captured.url, 'http://localhost:5250/api/v1/responses/resp_opaque');
  assert.equal(polled.captured.method, 'GET');
  assert.equal(polled.captured.body, undefined);

  const resumed = await captureToolCall('get_response', {
    id: 'resp_opaque', stream: true, starting_after: 17,
  });
  assert.equal(
    resumed.captured.url,
    'http://localhost:5250/api/v1/responses/resp_opaque?stream=true&starting_after=17',
  );

  const cancelled = await captureToolCall('cancel_response', { id: 'resp_opaque' });
  assert.equal(cancelled.captured.url, 'http://localhost:5250/api/v1/responses/resp_opaque/cancel');
  assert.equal(cancelled.captured.method, 'POST');
});

test('contract 10: context MCP tools map prepare, poll, and release without hidden waiting', async () => {
  const prepareBody = {
    model: 'voice-fast',
    messages: [{ role: 'system', content: 'Retain this prefix.' }],
    mode: 'prefill',
    priority: 'background',
    resident_only: true,
  };
  const prepared = await captureToolCall('llama_prepare_context', prepareBody);
  assert.equal(prepared.captured.url, 'http://localhost:5250/api/v1/context/prepare');
  assert.equal(prepared.captured.method, 'POST');
  assert.deepEqual(prepared.captured.body, prepareBody);
  assert.equal(prepared.result.status, 202);

  const polled = await captureToolCall('llama_get_prepared_context', { id: 'ctx_opaque' });
  assert.equal(polled.captured.url, 'http://localhost:5250/api/v1/context/ctx_opaque');
  assert.equal(polled.captured.method, 'GET');

  const released = await captureToolCall('llama_release_prepared_context', { id: 'ctx_opaque' });
  assert.equal(released.captured.url, 'http://localhost:5250/api/v1/context/ctx_opaque');
  assert.equal(released.captured.method, 'DELETE');
});
