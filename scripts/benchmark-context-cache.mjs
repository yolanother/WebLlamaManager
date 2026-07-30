#!/usr/bin/env node
// Llama Manager — end-to-end conversation context cache benchmark.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Exercises cold identities, growing stable conversations, prepared prefill,
// and realtime-over-background contention against a running manager. It reports
// p50/p95 TTFT and queue wait plus the documented prefill go/no-go decision.

import { randomUUID } from 'node:crypto';
import { benchmarkDecision, summarizeSamples, waitForPreparedContext } from '../api/context-benchmark.js';

/**
 * Parse the supported command-line options.
 * @param {string[]} argv Process arguments excluding node/script paths.
 * @returns {{baseUrl:string,model:string|null,samples:number}} Benchmark options.
 */
function parseArguments(argv) {
  const options = { baseUrl: 'http://localhost:5250/api/v1', model: null, samples: 20 };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--base-url') options.baseUrl = argv[++index];
    else if (argv[index] === '--model') options.model = argv[++index];
    else if (argv[index] === '--samples') options.samples = Math.max(3, Number(argv[++index]) || 20);
  }
  return options;
}

/**
 * Read an SSE completion and capture first-token latency, queue wait, and text.
 * @param {string} baseUrl Llama Manager `/api/v1` base URL.
 * @param {Record<string,unknown>} body OpenAI-compatible chat body.
 * @param {Record<string,string>} [headers] Scope-preserving request headers.
 * @returns {Promise<{ttftMs:number,queueWaitMs:number,cachedTokens:number,text:string}>} Sample.
 */
async function streamingChat(baseUrl, body, headers = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ ...body, stream: true }),
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
    text,
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
    realtime_queue_wait_ms: summarizeSamples(realtimeQueue),
    prepared_context: { samples: preparedTtft.length, strict_reuse: true },
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
