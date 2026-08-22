// Llama Manager — inference performance-series public API contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Boots the real manager against disposable runtime paths and a fake local
// llama.cpp router. The suite verifies historical-row compatibility, distinct
// nullable measurements, model/window filters, workload normalization, and
// end-to-end timing persistence for streaming and non-streaming generation.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const FIXTURE_MODEL = 'Qwen3.8-27B-UD-Q4_K_XL.gguf';
const WORK = mkdtempSync(join(tmpdir(), 'llama-performance-series-'));
const DATA_DIR = join(WORK, 'data');
const REQUESTS_PATH = join(DATA_DIR, 'requests.jsonl');
const CONFIG_PATH = join(WORK, 'config.json');
let fakeRouter;
let manager;
let apiPort;
let managerLog = '';

/** Locate dependencies from this worktree or the primary checkout that owns it. */
function dependencyDirectory() {
  const local = join(REPO_ROOT, 'api/node_modules');
  try {
    readFileSync(join(local, 'express/package.json'));
    return local;
  } catch { /* an isolated worktree commonly shares dependencies with its primary checkout */ }
  const commonGitDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  return join(dirname(resolve(REPO_ROOT, commonGitDir)), 'api/node_modules');
}

/** Return an unused loopback port, releasing the probe before the caller binds. */
async function unusedPort() {
  const probe = createServer();
  await new Promise((accept, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', accept);
  });
  const port = probe.address().port;
  await new Promise(accept => probe.close(accept));
  return port;
}

/** Read a request body as parsed JSON, returning an empty object for no body. */
async function readJson(request) {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

/** Build deterministic llama.cpp timing evidence unique to one request kind. */
function timingsFor(kind) {
  const ordinal = {
    'chat-json': 1,
    'chat-stream': 2,
    'completion-json': 3,
    'completion-stream': 4,
  }[kind];
  return {
    prompt_n: 20 + ordinal,
    predicted_n: 4 + ordinal,
    prompt_ms: 40 + ordinal,
    predicted_ms: 20 + ordinal,
    prompt_per_second: 500 + ordinal,
    predicted_per_second: 100 + ordinal,
    draft_n_accepted: 6 + ordinal,
    draft_n: 8 + ordinal,
    cache_n: ordinal % 2 === 0 ? 11 : 0,
  };
}

/** Start a minimal fake llama.cpp router that exposes generation timing data. */
async function startFakeRouter() {
  fakeRouter = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/health') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (url.pathname === '/models' || url.pathname === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        object: 'list',
        data: [{
          id: FIXTURE_MODEL,
          object: 'model',
          status: { value: 'loaded', args: ['--ctx-size', '8192'] },
        }],
      }));
      return;
    }
    if (url.pathname === '/slots') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([{ id: 0, n_ctx: 8192, n_past: 0, is_processing: false }]));
      return;
    }
    if (url.pathname === '/tokenize') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ tokens: [1, 2, 3] }));
      return;
    }
    if (url.pathname.startsWith('/slots/')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/completions') {
      const body = await readJson(request);
      const family = url.pathname.includes('/chat/') ? 'chat' : 'completion';
      const kind = `${family}-${body.stream ? 'stream' : 'json'}`;
      const timings = timingsFor(kind);
      const usage = {
        prompt_tokens: timings.prompt_n,
        completion_tokens: timings.predicted_n,
        prompt_tokens_details: { cached_tokens: timings.cache_n },
      };
      const choice = family === 'chat'
        ? { index: 0, message: { role: 'assistant', content: kind }, finish_reason: 'stop' }
        : { index: 0, text: kind, finish_reason: 'stop' };
      const payload = {
        id: `fixture-${kind}`,
        object: family === 'chat' ? 'chat.completion' : 'text_completion',
        model: FIXTURE_MODEL,
        choices: [choice],
        usage,
        timings,
      };
      if (body.stream) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        const streamChoice = family === 'chat'
          ? { index: 0, delta: { content: kind }, finish_reason: 'stop' }
          : choice;
        response.write(`data: ${JSON.stringify({ ...payload, choices: [streamChoice] })}\n\n`);
        response.end('data: [DONE]\n\n');
      } else {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(payload));
      }
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise((accept, reject) => {
    fakeRouter.once('error', reject);
    fakeRouter.listen(0, accept);
  });
  return fakeRouter.address().port;
}

/** Fetch manager JSON and retain status/body for expressive assertions. */
async function managerJson(path, options) {
  const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

/** Poll until the real manager is listening or fail with captured server logs. */
async function waitForManager() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/llm-logs?limit=1`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    if (manager.exitCode != null) break;
    await new Promise(accept => setTimeout(accept, 50));
  }
  throw new Error(`manager did not start\n${managerLog.slice(-4000)}`);
}

/** Stop a spawned child, escalating after a bounded graceful-shutdown wait. */
async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(accept => child.once('exit', accept)),
    new Promise(accept => setTimeout(accept, 1000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

before(async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  const now = Date.now();
  const seeded = [
    // Compact historical row: every newer measurement must remain unavailable.
    { ts: now - 2000, m: 'Borethrax/Qwen-legacy', b: 'remote', tps: 12.5, dur: 800, pt: 5, ct: 10 },
    // Two overlapping local samples exercise derived peak concurrency.
    {
      ts: now - 1000, m: FIXTURE_MODEL, b: 'local', tps: 77.7, ttft: 82,
      dur: 1500, pt: 80, ct: 20, cached: 0,
      prompt_per_second: 456.7, draft_n_accepted: 6, draft_n: 8,
      workload: 'repetition-assisted',
    },
    {
      ts: now - 500, m: FIXTURE_MODEL, b: 'local', tps: 71.1, ttft: 91,
      dur: 1500, pt: 80, ct: 20, cached: 17,
      prompt_per_second: 400, draft_n_accepted: 0, draft_n: 0,
      workload: 'unsupported-value',
    },
    // Valid but outside 24h, retained for all-time filtering checks.
    {
      ts: now - 2 * 86400000, m: 'archive-model', b: 'local', tps: 9,
      ttft: 200, dur: 1000, pt: 10, ct: 5, cached: 0,
      prompt_per_second: 20, draft_n_accepted: 1, draft_n: 2,
    },
  ];
  writeFileSync(REQUESTS_PATH, seeded.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(CONFIG_PATH, JSON.stringify({
    autoStart: false,
    presetsSeeded: true,
    modelsMax: 2,
    contextSize: 8192,
    requestLogging: false,
    maxConcurrentRequests: 1,
    logFilters: [],
    presets: {},
    backends: { enabled: false, directory: [] },
  }));

  const llamaPort = await startFakeRouter();
  apiPort = await unusedPort();
  manager = spawn(process.execPath, [
    '--experimental-loader', join(HERE, 'worktree-module-loader.mjs'),
    join(REPO_ROOT, 'api/server.js'),
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AUTO_START: 'false',
      EMBED_ENABLED: 'false',
      CONFIG_PATH,
      API_PORT: String(apiPort),
      LLAMA_PORT: String(llamaPort),
      EMBED_PORT: String(await unusedPort()),
      HOME: join(WORK, 'home'),
      MODELS_DIR: join(WORK, 'models'),
      LLAMA_MANAGER_CONFIG_DIR: join(WORK, 'etc'),
      LLAMA_MANAGER_DATA_DIR: DATA_DIR,
      LLAMA_MANAGER_CACHE_DIR: join(WORK, 'cache'),
      LLAMA_MANAGER_TEST_NODE_MODULES: dependencyDirectory(),
      NODE_PATH: dependencyDirectory(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  manager.stdout.on('data', chunk => { managerLog += chunk; });
  manager.stderr.on('data', chunk => { managerLog += chunk; });
  await waitForManager();
});

after(async () => {
  await stopChild(manager);
  if (fakeRouter) await new Promise(accept => fakeRouter.close(accept));
  rmSync(WORK, { recursive: true, force: true });
});

test('request-series exposes chronological, nullable, scenario-aware per-model points', async () => {
  const { status, body } = await managerJson('/api/analytics/request-series?window=all');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.window, 'all');
  assert.ok(Array.isArray(body.models), 'response advertises available models');
  assert.ok(Array.isArray(body.workloads), 'response advertises available workloads');
  assert.ok(body.workloads.includes('general'));
  assert.ok(body.workloads.includes('repetition-assisted'));
  assert.deepEqual(body.points.map(point => point.timestamp), [...body.points.map(point => point.timestamp)].sort((a, b) => a - b));

  const historical = body.points.find(point => point.name === 'Borethrax/Qwen-legacy');
  assert.deepEqual(historical, {
    timestamp: historical.timestamp,
    name: 'Borethrax/Qwen-legacy',
    model: 'Qwen-legacy',
    backend: 'Borethrax',
    isRemote: true,
    slots: 1,
    decodeTps: 12.5,
    promptTps: null,
    ttftMs: null,
    draftAccepted: null,
    draftTotal: null,
    draftAcceptance: null,
    cacheState: 'unknown',
    workload: 'general',
  });

  const cold = body.points.find(point => point.decodeTps === 77.7);
  assert.equal(cold.slots, 2);
  assert.equal(cold.promptTps, 456.7);
  assert.equal(cold.ttftMs, 82);
  assert.equal(cold.draftAccepted, 6);
  assert.equal(cold.draftTotal, 8);
  assert.equal(cold.draftAcceptance, 0.75);
  assert.equal(cold.cacheState, 'cold');
  assert.equal(cold.workload, 'repetition-assisted');

  const warm = body.points.find(point => point.decodeTps === 71.1);
  assert.equal(warm.slots, 2);
  assert.equal(warm.cacheState, 'warm-prefix');
  assert.equal(warm.draftAcceptance, null, 'a zero draft total has no acceptance measurement');
  assert.equal(warm.workload, 'general', 'unsupported persisted workloads normalize safely');
});

test('request-series filters by supported time window and exact stored model key', async () => {
  const recent = await managerJson('/api/analytics/request-series?window=24h');
  assert.equal(recent.status, 200, JSON.stringify(recent.body));
  assert.ok(recent.body.points.every(point => point.name !== 'archive-model'));

  const selected = await managerJson(`/api/analytics/request-series?window=all&model=${encodeURIComponent(FIXTURE_MODEL)}`);
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  assert.ok(selected.body.points.length >= 2);
  assert.ok(selected.body.points.every(point => point.name === FIXTURE_MODEL));

  const existing = await managerJson('/api/analytics/request-stats?window=all');
  assert.equal(existing.status, 200);
  assert.equal(existing.body.window, 'all');
  assert.ok(existing.body.models.some(model => model.name === FIXTURE_MODEL && model.avgTps === 74.4));
});

test('local generation paths persist final llama.cpp timings and normalized workload labels', async () => {
  const requests = [
    ['/api/v1/chat/completions', {
      model: FIXTURE_MODEL, stream: false,
      messages: [{ role: 'user', content: 'chat-json' }], max_tokens: 5,
    }, 'repetition-assisted'],
    ['/api/v1/chat/completions', {
      model: FIXTURE_MODEL, stream: true,
      messages: [{ role: 'user', content: 'chat-stream' }], max_tokens: 5,
    }, 'not-a-real-workload'],
    ['/api/v1/completions', {
      model: FIXTURE_MODEL, stream: false, prompt: 'completion-json', max_tokens: 5,
    }, 'repetition-assisted'],
    ['/api/v1/completions', {
      model: FIXTURE_MODEL, stream: true, prompt: 'completion-stream', max_tokens: 5,
    }, 'repetition-assisted'],
  ];

  for (const [path, body, workload] of requests) {
    const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-llama-manager-workload': workload,
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `${path} ${body.stream ? 'stream' : 'json'}: ${await response.text()}`);
    if (!response.bodyUsed) await response.text();
  }

  let liveRows = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    liveRows = readFileSync(REQUESTS_PATH, 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(row => row.m === FIXTURE_MODEL && row.prompt_per_second >= 501);
    if (liveRows.length === 4) break;
    await new Promise(accept => setTimeout(accept, 50));
  }
  assert.equal(liveRows.length, 4, `all four generation paths persisted timing rows; log:\n${managerLog.slice(-2500)}`);
  assert.deepEqual(liveRows.map(row => row.prompt_per_second).sort((a, b) => a - b), [501, 502, 503, 504]);
  assert.deepEqual(liveRows.map(row => row.draft_n_accepted).sort((a, b) => a - b), [7, 8, 9, 10]);
  assert.deepEqual(liveRows.map(row => row.draft_n).sort((a, b) => a - b), [9, 10, 11, 12]);
  assert.equal(liveRows.find(row => row.prompt_per_second === 501).workload, 'repetition-assisted');
  assert.equal(liveRows.find(row => row.prompt_per_second === 502).workload, 'general');
});

test('request-series is discoverable from the canonical OpenAPI catalog', async () => {
  const { status, body } = await managerJson('/api/openapi.json');
  assert.equal(status, 200);
  assert.ok(body.paths?.['/api/analytics/request-series']?.get, 'machine API catalog exposes the series endpoint');
});
