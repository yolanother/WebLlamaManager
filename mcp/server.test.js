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

test('contract 11: MCP catalog exposes the six async job and prepared-context tools', () => {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const expected = [
    'llama_submit_chat_job',
    'llama_get_chat_job',
    'llama_cancel_chat_job',
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

  const submit = byName.get('llama_submit_chat_job');
  assert.deepEqual(submit.inputSchema.required, ['model', 'messages']);
  for (const field of [
    'prepared_context_id', 'prepared_context_mode', 'context_cache_strict',
    'priority', 'routing',
  ]) {
    assert.ok(submit.inputSchema.properties[field], `submit tool omits ${field}`);
  }
  assert.deepEqual(submit.inputSchema.properties.prepared_context_mode.enum, ['append']);
  assert.match(submit.description, /llama_chat/);
  assert.match(submit.description, /client|proxy/i);
  assert.match(submit.description, /budget/i);

  const prepare = byName.get('llama_prepare_context');
  assert.deepEqual(prepare.inputSchema.required, ['model', 'messages']);
  assert.deepEqual(prepare.inputSchema.properties.mode.enum, ['count', 'prefill']);
  assert.deepEqual(prepare.inputSchema.properties.priority.enum, ['interactive', 'background']);
  assert.equal(prepare.inputSchema.properties.resident_only.type, 'boolean');
});

test('contract 11: chat-job MCP tools mirror manager extensions and REST methods', async () => {
  const argumentsBody = {
    model: 'voice-fast',
    messages: [{ role: 'user', content: 'long request' }],
    temperature: 0.3,
    max_tokens: 50_000,
    prepared_context_id: 'ctx_opaque',
    prepared_context_mode: 'append',
    context_cache_strict: true,
    priority: 'background',
    routing: 'local_only',
  };
  const submitted = await captureToolCall('llama_submit_chat_job', argumentsBody);
  assert.equal(submitted.captured.url, 'http://localhost:5250/api/v1/chat/completions/jobs');
  assert.equal(submitted.captured.method, 'POST');
  const { priority: _toolPriority, ...rest } = argumentsBody;
  assert.deepEqual(submitted.captured.body, { ...rest, request_priority: 'background', stream: false });
  assert.equal(Object.hasOwn(submitted.captured.body, 'priority'), false, 'the inert tool-only name must not reach REST');
  assert.equal(submitted.result.status, 202);

  const polled = await captureToolCall('llama_get_chat_job', { id: 'job_opaque' });
  assert.equal(polled.captured.url, 'http://localhost:5250/api/v1/chat/completions/jobs/job_opaque');
  assert.equal(polled.captured.method, 'GET');
  assert.equal(polled.captured.body, undefined);

  const cancelled = await captureToolCall('llama_cancel_chat_job', { id: 'job_opaque' });
  assert.equal(cancelled.captured.url, 'http://localhost:5250/api/v1/chat/completions/jobs/job_opaque');
  assert.equal(cancelled.captured.method, 'DELETE');
});

test('contract 11: context MCP tools map prepare, poll, and release without hidden waiting', async () => {
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
