#!/usr/bin/env node
// Llama Manager — end-to-end conversation context cache benchmark.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Exercises cold identities, growing and interleaved conversations, changing
// RAG suffixes, prepared prefill, scope invalidation, durable reload/restore,
// and realtime-over-background contention against a running manager. It reports
// p50/p95 latency and reuse evidence plus the documented prefill go/no-go gate.

import { randomUUID } from 'node:crypto';
import {
  benchmarkDecision,
  localBenchmarkChatBody,
  summarizeSamples,
  waitForPreparedContext,
} from '../api/context-benchmark.js';

/**
 * Parse the supported command-line options.
 * @param {string[]} argv Process arguments excluding node/script paths.
 * @returns {{baseUrl:string,model:string|null,samples:number,reloadModel:string|null}} Benchmark options.
 */
function parseArguments(argv) {
  const options = {
    baseUrl: 'http://localhost:5250/api/v1',
    model: null,
    samples: 20,
    reloadModel: null,
  };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--base-url') options.baseUrl = argv[++index];
    else if (argv[index] === '--model') options.model = argv[++index];
    else if (argv[index] === '--samples') options.samples = Math.max(3, Number(argv[++index]) || 20);
    else if (argv[index] === '--exercise-reload') options.reloadModel = argv[++index];
  }
  return options;
}

/**
 * Read an SSE completion and capture first-token latency, queue wait, and text.
 * @param {string} baseUrl Llama Manager `/api/v1` base URL.
 * @param {Record<string,unknown>} body OpenAI-compatible chat body.
 * @param {Record<string,string>} [headers] Scope-preserving request headers.
 * @returns {Promise<{ttftMs:number,queueWaitMs:number,cachedTokens:number,cacheKind:string,text:string}>} Sample.
 */
async function streamingChat(baseUrl, body, headers = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(localBenchmarkChatBody(body)),
  });
  if (!response.ok) throw new Error(`chat failed: ${response.status} ${await response.text()}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let firstTokenAt = null;
  let queueWaitMs = 0;
  let cachedTokens = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const queueMatch = line.match(/^: manager queue-wait-ms=(\d+)/);
      if (queueMatch) queueWaitMs = Number(queueMatch[1]);
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const event = JSON.parse(line.slice(6));
      if (event.error) throw new Error(event.error.message || 'stream failed');
      const delta = event.choices?.[0]?.delta || {};
      const chunk = delta.content || delta.reasoning_content || delta.reasoning || delta.thinking || delta.text || '';
      if (chunk && firstTokenAt == null) firstTokenAt = performance.now();
      text += chunk;
      cachedTokens = event.usage?.prompt_tokens_details?.cached_tokens || event.timings?.cache_n || cachedTokens;
    }
  }
  return {
    ttftMs: Math.round((firstTokenAt || performance.now()) - startedAt),
    queueWaitMs,
    cachedTokens,
    cacheKind: response.headers.get('x-llama-manager-cache') || 'none',
    text,
  };
}

/**
 * Run a non-streaming local completion so post-restore metadata is available in
 * the response body after the manager has completed its slot-restore attempt.
 * @param {string} baseUrl Llama Manager `/api/v1` base URL.
 * @param {Record<string,unknown>} body OpenAI-compatible chat body.
 * @param {Record<string,string>} [headers] Scope-preserving request headers.
 * @returns {Promise<{ttftMs:number,cachedTokens:number,cacheKind:string}>} Sample.
 */
async function nonStreamingChat(baseUrl, body, headers = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ ...localBenchmarkChatBody(body), stream: false }),
  });
  if (!response.ok) throw new Error(`chat failed: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  return {
    ttftMs: Math.round(performance.now() - startedAt),
    cachedTokens: payload._llama_manager?.cache?.reusedPrefixTokens || 0,
    cacheKind: payload._llama_manager?.cache?.hitKind || 'none',
  };
}

/**
 * Wait until the selected manager queue has no pending/active background save.
 * @param {string} baseUrl Llama Manager `/api/v1` base URL.
 * @param {number} [timeoutMs=120000] Maximum wait duration.
 * @returns {Promise<void>} Resolves when persistence work has drained.
 */
async function waitForSlotSaves(baseUrl, timeoutMs = 120_000) {
  const queueUrl = new URL('/api/queue', baseUrl).toString();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(queueUrl);
    if (!response.ok) throw new Error(`queue status failed: ${response.status}`);
    const payload = await response.json();
    if (!(payload.items || []).some(item => item.endpoint === 'slot-cache/save')) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('slot-cache saves did not drain before reload probe');
}

/**
 * Optionally exercise durable slot restore across an explicit model unload.
 * This is opt-in because unloading a shared development model is disruptive.
 * @param {Object} options Parsed benchmark options.
 * @param {Record<string,string>} headers Scope-preserving request headers.
 * @returns {Promise<Record<string,unknown>>} Reload/restore conformance result.
 */
async function reloadRestoreProbe(options, headers) {
  if (!options.reloadModel) {
    return { status: 'skipped', reason: 'pass --exercise-reload <model> on an isolated maintenance server' };
  }
  const key = `benchmark-reload-${randomUUID()}`;
  const messages = [
    { role: 'system', content: `Retain this durable prefix. ${'cache-state '.repeat(128)}` },
    { role: 'user', content: 'Reply with READY.' },
  ];
  const body = {
    model: options.reloadModel,
    max_tokens: 1,
    conversation_cache_key: key,
    messages,
  };
  await streamingChat(options.baseUrl, body, headers);
  await waitForSlotSaves(options.baseUrl);
  const unloadUrl = new URL('/api/models/unload', options.baseUrl).toString();
  const unload = await fetch(unloadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model: options.reloadModel }),
  });
  if (!unload.ok) throw new Error(`model unload failed: ${unload.status} ${await unload.text()}`);
  const restored = await nonStreamingChat(options.baseUrl, body, headers);
  return {
    status: restored.cacheKind === 'disk_restore' && restored.cachedTokens > 0 ? 'passed' : 'failed',
    model: options.reloadModel,
    cache_kind: restored.cacheKind,
    reused_prefix_tokens: restored.cachedTokens,
    ttft_ms: restored.ttftMs,
  };
}

/**
 * Resolve the first generation-capable model when none was specified.
 * @param {string} baseUrl Llama Manager `/api/v1` base URL.
 * @param {string|null} requested Explicit model option.
 * @returns {Promise<string>} Concrete or caller-selected model id.
 */
async function resolveModel(baseUrl, requested) {
  if (requested) return requested;
  const response = await fetch(`${baseUrl}/models`);
  if (!response.ok) throw new Error(`model list failed: ${response.status}`);
  const payload = await response.json();
  const model = payload.data?.find(entry => entry.context_management?.exact_input_tokens)?.id;
  if (!model) throw new Error('no local context-capable model is advertised');
  return model;
}

/** Run cold, growing, prepared, and contention scenarios and print JSON. */
async function run() {
  const options = parseArguments(process.argv.slice(2));
  const model = await resolveModel(options.baseUrl, options.model);
  const scopeHeaders = { Authorization: 'Bearer llama-manager-local-context-benchmark' };
  const cold = [];
  const warm = [];
  const reused = [];
  for (let index = 0; index < options.samples; index++) {
    const result = await streamingChat(options.baseUrl, {
      model,
      max_tokens: 1,
      conversation_cache_key: `benchmark-cold-${randomUUID()}`,
      messages: [
        { role: 'system', content: 'Answer with one short word.' },
        { role: 'user', content: `Cold benchmark request ${index}.` },
      ],
    }, scopeHeaders);
    cold.push(result.ttftMs);
  }

  const growingMessages = [
    { role: 'system', content: 'Answer with one short word and retain the numbered history.' },
    { role: 'user', content: 'Conversation benchmark turn zero.' },
  ];
  const stableKey = `benchmark-growing-${randomUUID()}`;
  for (let index = 0; index < options.samples + 2; index++) {
    const result = await streamingChat(options.baseUrl, {
      model,
      max_tokens: 1,
      conversation_cache_key: stableKey,
      messages: growingMessages,
    }, scopeHeaders);
    growingMessages.push({ role: 'assistant', content: result.text || 'ok' });
    growingMessages.push({ role: 'user', content: `Conversation benchmark turn ${index + 1}.` });
    if (index >= 2) {
      warm.push(result.ttftMs);
      reused.push(result.cachedTokens);
    }
  }

  const preparedTtft = [];
  const preparedReused = [];
  const prefillLatency = [];
  const discardedDecodeTokens = [];
  for (let index = 0; index < options.samples; index++) {
    const messages = [
      { role: 'system', content: 'Answer with one short word.' },
      { role: 'user', content: `Prepared benchmark request ${index}.` },
    ];
    const prepareResponse = await fetch(`${options.baseUrl}/context/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...scopeHeaders },
      body: JSON.stringify({
        model,
        mode: 'prefill',
        conversation_cache_key: `benchmark-prepared-${randomUUID()}`,
        messages,
      }),
    });
    if (!prepareResponse.ok) {
      throw new Error(`prepare failed: ${prepareResponse.status} ${await prepareResponse.text()}`);
    }
    const created = await prepareResponse.json();
    const ready = created.status === 'ready' ? created : await waitForPreparedContext({
      baseUrl: options.baseUrl,
      id: created.id,
      headers: scopeHeaders,
    });
    const result = await streamingChat(options.baseUrl, {
      model,
      max_tokens: 1,
      prepared_context_id: ready.id,
      context_cache_strict: true,
      messages,
    }, scopeHeaders);
    preparedTtft.push(result.ttftMs);
    preparedReused.push(result.cachedTokens);
    prefillLatency.push(ready.prefillMs || 0);
    discardedDecodeTokens.push(ready.discardedDecodeTokens || 0);
  }

  const interleavedTtft = [];
  const interleavedReused = [];
  const sessions = ['a', 'b'].map(name => ({
    key: `benchmark-interleaved-${name}-${randomUUID()}`,
    messages: [
      { role: 'system', content: `Retain the history for session ${name}.` },
      { role: 'user', content: `Initialize session ${name}.` },
    ],
  }));
  for (const session of sessions) {
    const initial = await streamingChat(options.baseUrl, {
      model, max_tokens: 1, conversation_cache_key: session.key, messages: session.messages,
    }, scopeHeaders);
    session.messages.push({ role: 'assistant', content: initial.text || 'ok' });
  }
  for (let index = 0; index < options.samples; index++) {
    const session = sessions[index % sessions.length];
    session.messages.push({ role: 'user', content: `Interleaved turn ${index}.` });
    const result = await streamingChat(options.baseUrl, {
      model, max_tokens: 1, conversation_cache_key: session.key, messages: session.messages,
    }, scopeHeaders);
    interleavedTtft.push(result.ttftMs);
    interleavedReused.push(result.cachedTokens);
    session.messages.push({ role: 'assistant', content: result.text || 'ok' });
  }

  const ragTtft = [];
  const ragReused = [];
  const ragKey = `benchmark-rag-${randomUUID()}`;
  for (let index = 0; index < options.samples; index++) {
    const result = await streamingChat(options.baseUrl, {
      model,
      max_tokens: 1,
      conversation_cache_key: ragKey,
      messages: [
        { role: 'system', content: `Stable persona and policy. ${'shared-prefix '.repeat(64)}` },
        { role: 'user', content: `Question ${index}. Retrieved suffix ${randomUUID()}.` },
      ],
    }, scopeHeaders);
    ragTtft.push(result.ttftMs);
    ragReused.push(result.cachedTokens);
  }

  const invalidationKey = `benchmark-invalidation-${randomUUID()}`;
  const invalidationBody = {
    model,
    max_tokens: 1,
    conversation_cache_key: invalidationKey,
    messages: [
      { role: 'system', content: `Invalidate this prefix. ${'sensitive-derived-state '.repeat(64)}` },
      { role: 'user', content: 'Reply with CLEARED.' },
    ],
  };
  await streamingChat(options.baseUrl, invalidationBody, scopeHeaders);
  const invalidateResponse = await fetch(`${options.baseUrl}/context/cache`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...scopeHeaders },
    body: JSON.stringify({ model }),
  });
  if (!invalidateResponse.ok) {
    throw new Error(`scope invalidation failed: ${invalidateResponse.status} ${await invalidateResponse.text()}`);
  }
  const invalidated = await invalidateResponse.json();
  const afterInvalidation = await streamingChat(options.baseUrl, invalidationBody, scopeHeaders);

  const realtimeQueue = [];
  for (let index = 0; index < options.samples; index++) {
    const background = streamingChat(options.baseUrl, {
      model,
      max_tokens: 128,
      request_priority: 'background',
      messages: [{ role: 'user', content: `Write a long numbered list for contention run ${index}.` }],
    }, scopeHeaders).catch(() => null);
    await new Promise(resolve => setTimeout(resolve, 50));
    const realtime = await streamingChat(options.baseUrl, {
      model,
      max_tokens: 1,
      request_priority: 'realtime',
      routing: 'local_only',
      messages: [{ role: 'user', content: 'Reply now with OK.' }],
    }, scopeHeaders);
    realtimeQueue.push(realtime.queueWaitMs);
    await background;
  }

  const report = {
    generated_at: new Date().toISOString(),
    model,
    samples_per_scenario: options.samples,
    cold_ttft_ms: summarizeSamples(cold),
    growing_ttft_ms: summarizeSamples(warm),
    growing_reused_prefix_tokens: summarizeSamples(reused),
    prepared_ttft_ms: summarizeSamples(preparedTtft),
    prepared_reused_prefix_tokens: summarizeSamples(preparedReused),
    prepared_prefill_ms: summarizeSamples(prefillLatency),
    prepared_discarded_decode_tokens: summarizeSamples(discardedDecodeTokens),
    interleaved_ttft_ms: summarizeSamples(interleavedTtft),
    interleaved_reused_prefix_tokens: summarizeSamples(interleavedReused),
    changing_rag_ttft_ms: summarizeSamples(ragTtft),
    changing_rag_reused_prefix_tokens: summarizeSamples(ragReused),
    scope_invalidation: {
      deleted: invalidated.deleted || {},
      first_request_cached_tokens: afterInvalidation.cachedTokens,
      first_request_ttft_ms: afterInvalidation.ttftMs,
      passed: afterInvalidation.cachedTokens === 0,
    },
    realtime_queue_wait_ms: summarizeSamples(realtimeQueue),
    prepared_context: { samples: preparedTtft.length, strict_reuse: true },
    reload_restore: await reloadRestoreProbe(options, scopeHeaders),
  };
  report.prefill_decision = benchmarkDecision({
    coldP95: report.cold_ttft_ms.p95,
    warmP95: report.prepared_ttft_ms.p95,
    realtimeQueueP95: report.realtime_queue_wait_ms.p95,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

run().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
