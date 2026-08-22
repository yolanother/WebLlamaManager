// Llama Manager — destructive administration API black-box contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Boots a copied manager application with disposable config, data, model,
// cache, home, ports, fake llama.cpp router, and fake Hugging Face executable.
// It verifies exact installed-model deletion, path and residency safeguards,
// process-scoped active-download cancellation, terminal-state retention, and
// canonical OpenAPI discovery without touching operator state or real models.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const WORK = mkdtempSync(join(tmpdir(), 'llama-admin-api-'));
const APP_ROOT = join(WORK, 'app');
const APP_API = join(APP_ROOT, 'api');
const DATA_DIR = join(WORK, 'data');
const MODELS_DIR = join(WORK, 'models');
const CONFIG_PATH = join(WORK, 'config.json');
const HF_EVENTS = join(WORK, 'hf-events');
const LOADED_MODEL = 'loaded.gguf';
const RESIDENT_MODEL = 'resident.gguf';
let apiPort;
let fakeRouter;
let manager;
let managerLog = '';

/** Locate API dependencies in this worktree or its primary checkout. */
function dependencyDirectory() {
  const local = join(REPO_ROOT, 'api/node_modules');
  if (existsSync(join(local, 'express/package.json'))) return local;
  const commonGitDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  return join(dirname(resolve(REPO_ROOT, commonGitDir)), 'api/node_modules');
}

/** Return an unused loopback port, releasing the probe before use. */
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

/** Read and parse a request body, returning an empty object when absent. */
async function readJson(request) {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

/** Start the minimal router surface used by model residency checks. */
async function startFakeRouter() {
  fakeRouter = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/health') {
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (url.pathname === '/models' || url.pathname === '/v1/models') {
      response.end(JSON.stringify({
        object: 'list',
        data: [{
          id: LOADED_MODEL,
          object: 'model',
          status: { value: 'loaded', args: ['--model', join(MODELS_DIR, LOADED_MODEL)] },
        }],
      }));
      return;
    }
    if (url.pathname === '/slots') {
      response.end(JSON.stringify([]));
      return;
    }
    if (url.pathname === '/models/unload') {
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (url.pathname === '/v1/chat/completions') {
      const body = await readJson(request);
      response.end(JSON.stringify({
        id: 'fixture-load',
        model: body.model,
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((accept, reject) => {
    fakeRouter.once('error', reject);
    fakeRouter.listen(0, accept);
  });
  return fakeRouter.address().port;
}

/** Install a blocking fake `hf` command in the disposable application copy. */
function installFakeHf() {
  const path = join(APP_ROOT, '.venv/bin/hf');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/bash
# Llama Manager disposable Hugging Face process fixture.
# Copyright (c) Llama Manager project. Use is governed by the repository LICENSE.
set -eu
repo="\${2:-unknown}"
safe="\$(printf '%s' "$repo" | tr '/:' '__')"
printf '%s\\n' "\$\$" > "\$FAKE_HF_EVENT_DIR/started-\$safe"
if [[ "$repo" == *complete* ]]; then
  printf 'Downloading: 100%%\\nDownload complete\\n'
  exit 0
fi
if [[ "$repo" == *fail* ]]; then
  printf 'Downloading: 17%%\\nError: fixture failure\\n' >&2
  exit 7
fi
trap 'printf "terminated\\n" > "$FAKE_HF_EVENT_DIR/killed-$safe"; exit 143' TERM INT HUP
printf 'Downloading: 42%%\\n'
while :; do sleep 1; done
`);
  chmodSync(path, 0o755);
}

/** Fetch manager JSON and retain its HTTP status for assertions. */
async function managerJson(path, options) {
  const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

/** Send a JSON request to the disposable manager. */
function sendJson(method, path, body) {
  return managerJson(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

/** Poll until an observable predicate is true, returning its last value. */
async function eventually(read, accept, description) {
  let value;
  for (let attempt = 0; attempt < 100; attempt++) {
    value = await read();
    if (accept(value)) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`${description}; last value: ${JSON.stringify(value)}\n${managerLog.slice(-2500)}`);
}

/** Stop a child process with a bounded graceful wait. */
async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(accept => child.once('exit', accept)),
    new Promise(accept => setTimeout(accept, 1000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

/** Terminate only fake download PIDs recorded by this disposable test run. */
function stopFakeDownloads() {
  if (!existsSync(HF_EVENTS)) return;
  for (const file of readdirSync(HF_EVENTS).filter(name => name.startsWith('started-'))) {
    const pid = Number.parseInt(readFileSync(join(HF_EVENTS, file), 'utf8'), 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
  }
}

before(async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(MODELS_DIR, { recursive: true });
  mkdirSync(HF_EVENTS, { recursive: true });
  cpSync(join(REPO_ROOT, 'api'), APP_API, {
    recursive: true,
    filter: source => !source.endsWith('/node_modules'),
  });
  installFakeHf();

  mkdirSync(join(MODELS_DIR, 'org'), { recursive: true });
  mkdirSync(join(MODELS_DIR, 'split'), { recursive: true });
  writeFileSync(join(MODELS_DIR, 'org/model.gguf'), 'exact-model!');
  writeFileSync(join(MODELS_DIR, 'org/keep.gguf'), 'keep');
  writeFileSync(join(MODELS_DIR, 'split/giant-00001-of-00002.gguf'), 'part-one');
  writeFileSync(join(MODELS_DIR, 'split/giant-00002-of-00002.gguf'), 'part-two!!');
  writeFileSync(join(MODELS_DIR, LOADED_MODEL), 'loaded');
  writeFileSync(join(MODELS_DIR, RESIDENT_MODEL), 'resident');
  writeFileSync(join(WORK, 'outside.gguf'), 'outside-must-survive');

  writeFileSync(CONFIG_PATH, JSON.stringify({
    autoStart: false,
    presetsSeeded: true,
    modelsMax: 2,
    contextSize: 8192,
    requestLogging: false,
    maxConcurrentRequests: 1,
    logFilters: [],
    presets: {},
    modelResidency: { desiredModels: [RESIDENT_MODEL] },
    backends: { enabled: false, directory: [] },
  }));

  const llamaPort = await startFakeRouter();
  apiPort = await unusedPort();
  const dependencies = dependencyDirectory();
  manager = spawn(process.execPath, [
    '--experimental-loader', join(HERE, 'worktree-module-loader.mjs'),
    join(APP_API, 'server.js'),
  ], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      AUTO_START: 'false',
      EMBED_ENABLED: 'false',
      CONFIG_PATH,
      API_PORT: String(apiPort),
      LLAMA_PORT: String(llamaPort),
      EMBED_PORT: String(await unusedPort()),
      HOME: join(WORK, 'home'),
      MODELS_DIR,
      LLAMA_MANAGER_CONFIG_DIR: join(WORK, 'etc'),
      LLAMA_MANAGER_DATA_DIR: DATA_DIR,
      LLAMA_MANAGER_CACHE_DIR: join(WORK, 'cache'),
      LLAMA_MANAGER_TEST_NODE_MODULES: dependencies,
      NODE_PATH: dependencies,
      FAKE_HF_EVENT_DIR: HF_EVENTS,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  manager.stdout.on('data', chunk => { managerLog += chunk; });
  manager.stderr.on('data', chunk => { managerLog += chunk; });

  await eventually(
    async () => {
      try { return (await managerJson('/api/llm-logs?limit=1')).status; }
      catch { return null; }
    },
    status => status === 200,
    'manager did not start',
  );
});

after(async () => {
  await stopChild(manager);
  stopFakeDownloads();
  if (fakeRouter) await new Promise(accept => fakeRouter.close(accept));
  rmSync(WORK, { recursive: true, force: true });
});

test('installed-model deletion is exact, split-aware, and path safe', async () => {
  const rawPart = 'split/giant-00001-of-00002.gguf';
  const rawPartResult = await managerJson(`/api/models/${encodeURIComponent(rawPart)}`, { method: 'DELETE' });
  assert.ok([400, 404].includes(rawPartResult.status), JSON.stringify(rawPartResult.body));
  assert.equal(existsSync(join(MODELS_DIR, rawPart)), true, 'raw split-part target is not an inventory model');

  const exactName = 'org/model.gguf';
  const exactPath = join(MODELS_DIR, exactName);
  const exactBytes = readFileSync(exactPath).byteLength;
  const exact = await managerJson(`/api/models/${encodeURIComponent(exactName)}`, { method: 'DELETE' });
  assert.equal(exact.status, 200, JSON.stringify(exact.body));
  assert.equal(exact.body.model, exactName);
  assert.deepEqual(exact.body.deletedFiles, [exactName]);
  assert.equal(exact.body.deletedBytes, exactBytes);
  assert.equal(existsSync(exactPath), false);
  assert.equal(existsSync(join(MODELS_DIR, 'org/keep.gguf')), true, 'sibling model survives');

  const splitName = 'split/giant.gguf';
  const splitParts = [
    'split/giant-00001-of-00002.gguf',
    'split/giant-00002-of-00002.gguf',
  ];
  const splitBytes = splitParts.reduce((sum, name) => sum + readFileSync(join(MODELS_DIR, name)).byteLength, 0);
  const split = await managerJson(`/api/models/${encodeURIComponent(splitName)}`, { method: 'DELETE' });
  assert.equal(split.status, 200, JSON.stringify(split.body));
  assert.equal(split.body.model, splitName);
  assert.deepEqual([...split.body.deletedFiles].sort(), splitParts);
  assert.equal(split.body.deletedBytes, splitBytes);
  assert.ok(splitParts.every(name => !existsSync(join(MODELS_DIR, name))));

  const unknown = await managerJson(`/api/models/${encodeURIComponent('missing.gguf')}`, { method: 'DELETE' });
  assert.equal(unknown.status, 404);

  const traversal = await managerJson(`/api/models/${encodeURIComponent('../outside.gguf')}`, { method: 'DELETE' });
  assert.ok([400, 404].includes(traversal.status), JSON.stringify(traversal.body));
  assert.equal(existsSync(join(WORK, 'outside.gguf')), true);

  const absolute = await managerJson(`/api/models/${encodeURIComponent(join(WORK, 'outside.gguf'))}`, { method: 'DELETE' });
  assert.ok([400, 404].includes(absolute.status), JSON.stringify(absolute.body));
  assert.equal(existsSync(join(WORK, 'outside.gguf')), true);
});

test('loaded and desired-resident models return conflict and remain installed', async () => {
  for (const model of [LOADED_MODEL, RESIDENT_MODEL]) {
    const result = await managerJson(`/api/models/${encodeURIComponent(model)}`, { method: 'DELETE' });
    assert.equal(result.status, 409, `${model}: ${JSON.stringify(result.body)}`);
    assert.equal(existsSync(join(MODELS_DIR, model)), true, `${model} remains on disk`);
  }
});

test('active download cancellation terminates only its child and remains terminal', async () => {
  const firstRepo = 'fixture/cancel-one';
  const secondRepo = 'fixture/cancel-two';
  const filename = 'model.gguf';
  const firstId = `${firstRepo}:${filename}`;
  const secondId = `${secondRepo}:${filename}`;
  const firstSafe = firstRepo.replaceAll('/', '_');
  const secondSafe = secondRepo.replaceAll('/', '_');

  for (const repo of [firstRepo, secondRepo]) {
    const started = await sendJson('POST', '/api/pull', { repo, filename });
    assert.equal(started.status, 200, JSON.stringify(started.body));
  }
  await eventually(
    () => managerJson('/api/downloads'),
    result => result.body?.downloads?.filter(item => [firstId, secondId].includes(item.id))
      .every(item => ['starting', 'downloading'].includes(item.status)),
    'both fixture downloads did not become active',
  );

  const cancelled = await managerJson(`/api/downloads/${encodeURIComponent(firstId)}`, { method: 'DELETE' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.downloadId, firstId);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.match(cancelled.body.error, /cancel/i);
  assert.ok(cancelled.body.progress >= 0);

  await eventually(
    async () => existsSync(join(HF_EVENTS, `killed-${firstSafe}`)),
    Boolean,
    'cancelled child did not receive termination',
  );
  assert.equal(existsSync(join(HF_EVENTS, `killed-${secondSafe}`)), false, 'other download child was not terminated');

  // Give the child close callback enough time to attempt a stale status write.
  await new Promise(resolveWait => setTimeout(resolveWait, 250));
  const retained = await managerJson(`/api/downloads/${encodeURIComponent(firstId)}`);
  assert.equal(retained.status, 200, JSON.stringify(retained.body));
  assert.equal(retained.body.status, 'cancelled');
  assert.match(retained.body.error, /cancel/i);
  assert.ok(retained.body.output.includes('42%'), 'progress output remains available for context');

  const list = await managerJson('/api/downloads');
  assert.equal(list.body.downloads.find(item => item.id === firstId)?.status, 'cancelled');
  assert.ok(['starting', 'downloading'].includes(list.body.downloads.find(item => item.id === secondId)?.status));

  const repeated = await managerJson(`/api/downloads/${encodeURIComponent(firstId)}`, { method: 'DELETE' });
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(repeated.body.status, 'cancelled');
  assert.equal((await managerJson(`/api/downloads/${encodeURIComponent(firstId)}`)).status, 200);

  const secondCancel = await managerJson(`/api/downloads/${encodeURIComponent(secondId)}`, { method: 'DELETE' });
  assert.equal(secondCancel.status, 200, JSON.stringify(secondCancel.body));
});

test('completed and failed download records retain existing clear behavior', async () => {
  for (const [repo, terminal] of [['fixture/complete', 'completed'], ['fixture/fail', 'failed']]) {
    const id = `${repo}:model.gguf`;
    const started = await sendJson('POST', '/api/pull', { repo, filename: 'model.gguf' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    await eventually(
      () => managerJson(`/api/downloads/${encodeURIComponent(id)}`),
      result => result.status === 200 && result.body.status === terminal,
      `${repo} did not reach ${terminal}`,
    );
    const cleared = await managerJson(`/api/downloads/${encodeURIComponent(id)}`, { method: 'DELETE' });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal((await managerJson(`/api/downloads/${encodeURIComponent(id)}`)).status, 404);
  }
});

test('canonical OpenAPI describes both destructive routes and path parameters', async () => {
  const openapi = await managerJson('/api/openapi.json');
  assert.equal(openapi.status, 200);
  for (const [path, parameter] of [
    ['/api/models/{model}', 'model'],
    ['/api/downloads/{downloadId}', 'downloadId'],
  ]) {
    const operation = openapi.body.paths?.[path]?.delete;
    assert.ok(operation, `${path} DELETE is present`);
    assert.match(operation.summary, /delete|remove|cancel|clear/i);
    assert.ok(operation.parameters?.some(item => (
      item.name === parameter && item.in === 'path' && item.required === true
    )), `${path} documents required ${parameter}`);
  }
});
