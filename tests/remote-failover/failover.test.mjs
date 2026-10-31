// Llama Manager — black-box test: an alias fails over when a remote member answers 503.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Boots the real api/server.js on a throwaway config and free ports, with two fake
// OpenAI-compatible backends behind one alias: the preferred member answers 503
// `exclusive_ds4_mode` (what drakemore sent for 12 days while its Strata runtime was
// `exhausted`), the other answers 200. The request must be served by the second member
// instead of surfacing the 503 (W2a, T32312b081981f). Further cases pin that a 503 with
// nowhere else to go, and a REASONING_EXHAUSTED 502 (the caller's token budget), reach
// the caller unchanged. Run: node --test tests/remote-failover/

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = new URL('../../', import.meta.url).pathname;
const hits = { refusing: 0, healthy: 0, reasoning: 0 };
const fakes = [];
let api;
let apiPort;
let work;

/** Start a fake OpenAI backend. @param {string} name @param {number} status @returns {Promise<number>} its port. */
function fakeBackend(name, status) {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'm', object: 'model' }] }));
      }
      if (req.url.endsWith('/chat/completions')) hits[name] += 1;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status === 200
        ? { id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: `from ${name}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }
        : name === 'reasoning'
          ? { error: { message: 'spent its entire output budget on reasoning', type: 'upstream_output_error', code: 'REASONING_EXHAUSTED' } }
          : { error: { message: 'exclusive mode', type: 'exclusive_ds4_mode', code: 'exclusive_ds4_mode' } }));
    });
  });
  fakes.push(srv);
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
}

/** @returns {Promise<number>} a free loopback port. */
function freePort() {
  const s = createServer();
  return new Promise((r) => s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }));
}

/** @param {string} id @param {number} port @param {number} priority @returns {object} a tested backend entry. */
const backend = (id, port, priority) => ({
  id, name: id, url: `http://127.0.0.1:${port}/v1`, enabled: true, tested: true, priority,
  supportedEndpoints: ['chat/completions'], maxConcurrentRequests: 5, timeoutMs: 30000,
});

before(async () => {
  const refusingPort = await fakeBackend('refusing', 503);
  const healthyPort = await fakeBackend('healthy', 200);
  const reasoningPort = await fakeBackend('reasoning', 502);
  apiPort = await freePort();
  work = mkdtempSync(join(tmpdir(), 'failover-test-'));
  for (const d of ['home', 'models', 'etc', 'data', 'cache']) mkdirSync(join(work, d));
  writeFileSync(join(work, 'config.json'), JSON.stringify({
    autoStart: false, presetsSeeded: true, duoAliasesSeeded: true, modelsMax: 2, contextSize: 8192,
    requestLogging: false, maxConcurrentRequests: 1, logFilters: [], presets: {},
    backends: {
      enabled: true, offloadPolicy: 'overflow', preferLocal: false,
      directory: [backend('refusing', refusingPort, 1), backend('healthy', healthyPort, 2), backend('reasoning', reasoningPort, 1)],
    },
    aliases: {
      both: { targets: [{ host: 'refusing', model: 'm' }, { host: 'healthy', model: 'm' }] },
      only: { targets: [{ host: 'refusing', model: 'm' }] },
      budget: { targets: [{ host: 'reasoning', model: 'm' }, { host: 'healthy', model: 'm' }] },
    },
  }));
  api = spawn(process.execPath, [join(repoRoot, 'api/server.js')], {
    env: {
      ...process.env, AUTO_START: 'false', EMBED_ENABLED: 'false', CONFIG_PATH: join(work, 'config.json'),
      API_PORT: String(apiPort), LLAMA_PORT: String(await freePort()), EMBED_PORT: String(await freePort()),
      HOME: join(work, 'home'), MODELS_DIR: join(work, 'models'), LLAMA_MANAGER_CONFIG_DIR: join(work, 'etc'),
      LLAMA_MANAGER_DATA_DIR: join(work, 'data'), LLAMA_MANAGER_CACHE_DIR: join(work, 'cache'), DISTROBOX_BIN: '/bin/false',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${apiPort}/api/llm-logs?limit=1`)).ok) return; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server.js did not come up');
});

after(() => {
  api?.kill('SIGKILL');
  for (const s of fakes) s.close();
  rmSync(work, { recursive: true, force: true });
});

/** @param {string} model @returns {Promise<Response>} a non-streaming chat completion. */
const chat = (model) => fetch(`http://127.0.0.1:${apiPort}/v1/chat/completions`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false }),
});

test('a 503 from the preferred member is served by the next member', async () => {
  const res = await chat('both');
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.choices[0].message.content, 'from healthy');
  assert.ok(hits.refusing >= 1, 'the refusing member must have been tried first');
});

test('a 503 with nowhere else to go reaches the caller', async () => {
  const before = hits.refusing;
  const res = await chat('only');
  assert.equal(res.status, 503);
  assert.equal(hits.refusing, before + 1);
});

test('a REASONING_EXHAUSTED 502 is the caller budget: it passes through, no failover', async () => {
  const healthyBefore = hits.healthy;
  const res = await chat('budget');
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, 'REASONING_EXHAUSTED');
  assert.equal(hits.reasoning, 1);
  assert.equal(hits.healthy, healthyBefore, 'the healthy member must not be tried');
});
