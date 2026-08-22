// Llama Manager — concurrent nested Hugging Face download contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Boots a copied manager with disposable storage and a controllable fake `hf`
// executable. It verifies that root and nested GGUF downloads sharing a model
// directory finalize safely in either order, preserve independent records and
// unrelated children, flatten inventory files, and classify local placement
// failures without touching real models, credentials, downloads, or services.

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
const WORK = mkdtempSync(join(tmpdir(), 'llama-download-race-'));
const APP_ROOT = join(WORK, 'app');
const APP_API = join(APP_ROOT, 'api');
const DATA_DIR = join(WORK, 'data');
const MODELS_DIR = join(WORK, 'models');
const CONFIG_PATH = join(WORK, 'config.json');
const HF_EVENTS = join(WORK, 'hf-events');
let apiPort;
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

/** Convert a repository or include value to the fake command's event key. */
function eventKey(value) {
  return value.replaceAll(/[^A-Za-z0-9_.-]/g, '_');
}

/** Return the control directory used by one fake repository download pair. */
function controlsFor(repo) {
  return join(HF_EVENTS, eventKey(repo));
}

/** Create a synchronization marker consumed by the fake Hugging Face command. */
function allow(repo, operation) {
  const directory = controlsFor(repo);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `allow-${operation}`), 'continue');
}

/** Install a controllable fake `hf` executable in the disposable app copy. */
function installFakeHf() {
  const path = join(APP_ROOT, '.venv/bin/hf');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/bash
# Llama Manager disposable concurrent-download process fixture.
# Copyright (c) Llama Manager project. Use is governed by the repository LICENSE.
set -eu
repo="\${2:?missing repository}"
include=""
local_dir=""
shift 2
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --include) include="\$2"; shift 2 ;;
    --local-dir) local_dir="\$2"; shift 2 ;;
    *) shift ;;
  esac
done
safe_repo="\$(printf '%s' "\$repo" | tr -c 'A-Za-z0-9_.-' '_')"
safe_include="\$(printf '%s' "\$include" | tr -c 'A-Za-z0-9_.-' '_')"
control="\$FAKE_HF_EVENT_DIR/\$safe_repo"
mkdir -p "\$control"
printf '%s\n' "\$\$" > "\$control/started-\$safe_include"

if [[ "\$repo" == *unrelated* ]]; then
  trap 'printf "terminated\n" > "$control/killed"; exit 143' TERM INT HUP
  printf 'UNRELATED_OUTPUT Downloading: 23%%\n'
  while :; do sleep 1; done
fi

if [[ "\$include" == *forced-local-error* ]]; then
  printf 'OSError: [Errno 2] No such file or directory while placing downloaded artifact\n' >&2
  exit 74
fi

if [[ "\$include" == MTP/* ]]; then
  mkdir -p "\$local_dir/MTP"
  printf 'ready\n' > "\$control/nested-ready"
  printf 'NESTED_OUTPUT Downloading: 37%%\n'
  while [[ ! -f "\$control/allow-nested" ]]; do sleep 0.02; done
  printf 'nested-gguf\n' > "\$local_dir/MTP/draft.gguf"
  exit 0
fi

mkdir -p "\$local_dir"
printf 'ready\n' > "\$control/root-ready"
printf 'ROOT_OUTPUT Downloading: 61%%\n'
while [[ ! -f "\$control/allow-root" ]]; do sleep 0.02; done
printf 'root-gguf\n' > "\$local_dir/root.gguf"
exit 0
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
  for (let attempt = 0; attempt < 160; attempt++) {
    value = await read();
    if (accept(value)) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`${description}; last value: ${JSON.stringify(value)}\n${managerLog.slice(-3000)}`);
}

/** Start one managed fake download and return its canonical identifier. */
async function startDownload(repo, filename) {
  const started = await sendJson('POST', '/api/pull', { repo, filename });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.status, 'started');
  return `${repo}:${filename}`;
}

/** Read one canonical managed-download record. */
function readDownload(downloadId) {
  return managerJson(`/api/downloads/${encodeURIComponent(downloadId)}`);
}

/** Wait for one managed-download status and return its record. */
async function waitForStatus(downloadId, status) {
  return eventually(
    () => readDownload(downloadId),
    result => result.status === 200 && result.body.status === status,
    `${downloadId} did not reach ${status}`,
  );
}

/** Wait for a fake command synchronization marker. */
async function waitForEvent(repo, name) {
  return eventually(
    async () => existsSync(join(controlsFor(repo), name)),
    Boolean,
    `${repo} did not emit ${name}`,
  );
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

/** Terminate only fake download PIDs recorded by this disposable run. */
function stopFakeDownloads() {
  if (!existsSync(HF_EVENTS)) return;
  for (const repository of readdirSync(HF_EVENTS)) {
    const directory = join(HF_EVENTS, repository);
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory).filter(name => name.startsWith('started-'))) {
      const pid = Number.parseInt(readFileSync(join(directory, file), 'utf8'), 10);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
    }
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

  writeFileSync(CONFIG_PATH, JSON.stringify({
    autoStart: false,
    presetsSeeded: true,
    contextSize: 8192,
    requestLogging: false,
    maxConcurrentRequests: 1,
    logFilters: [],
    presets: {},
    backends: { enabled: false, directory: [] },
  }));

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
      LLAMA_PORT: String(await unusedPort()),
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
      try { return (await managerJson('/api/downloads')).status; }
      catch { return null; }
    },
    status => status === 200,
    'manager did not start',
  );
});

after(async () => {
  await stopChild(manager);
  stopFakeDownloads();
  rmSync(WORK, { recursive: true, force: true });
});

test('root-first finalization preserves an active nested peer and unrelated child', async () => {
  const repo = 'fixture/race-root-first';
  const target = join(MODELS_DIR, repo.replace('/', '_'));
  const rootId = await startDownload(repo, 'root.gguf');
  const nestedId = await startDownload(repo, 'MTP/draft.gguf');
  const unrelatedRepo = 'fixture/unrelated-active';
  const unrelatedId = await startDownload(unrelatedRepo, 'other.gguf');

  await waitForEvent(repo, 'root-ready');
  await waitForEvent(repo, 'nested-ready');
  await waitForStatus(unrelatedId, 'downloading');

  allow(repo, 'root');
  const root = await waitForStatus(rootId, 'completed');
  assert.match(root.body.output, /ROOT_OUTPUT/);
  assert.doesNotMatch(root.body.output, /NESTED_OUTPUT/);

  allow(repo, 'nested');
  const nested = await waitForStatus(nestedId, 'completed');
  assert.match(nested.body.output, /NESTED_OUTPUT/);
  assert.doesNotMatch(nested.body.output, /ROOT_OUTPUT/);
  assert.equal(readFileSync(join(target, 'root.gguf'), 'utf8'), 'root-gguf\n');
  assert.equal(readFileSync(join(target, 'draft.gguf'), 'utf8'), 'nested-gguf\n');

  const inventory = await managerJson('/api/models');
  assert.equal(inventory.status, 200, JSON.stringify(inventory.body));
  const names = inventory.body.localModels.map(model => model.name);
  assert.ok(names.includes('fixture_race-root-first/root.gguf'));
  assert.ok(names.includes('fixture_race-root-first/draft.gguf'));

  const unrelated = await readDownload(unrelatedId);
  assert.equal(unrelated.body.status, 'downloading');
  assert.equal(unrelated.body.progress, 23);
  assert.match(unrelated.body.output, /UNRELATED_OUTPUT/);
  assert.equal(existsSync(join(controlsFor(unrelatedRepo), 'killed')), false);

  const cancelled = await managerJson(`/api/downloads/${encodeURIComponent(unrelatedId)}`, { method: 'DELETE' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.status, 'cancelled');
  await waitForEvent(unrelatedRepo, 'killed');

  for (const id of [rootId, nestedId]) {
    const cleared = await managerJson(`/api/downloads/${encodeURIComponent(id)}`, { method: 'DELETE' });
    assert.equal(cleared.body.status, 'cleared');
    assert.equal((await readDownload(id)).status, 404);
  }
});

test('nested-first finalization also completes both downloads and flattens inventory', async () => {
  const repo = 'fixture/race-nested-first';
  const target = join(MODELS_DIR, repo.replace('/', '_'));
  const rootId = await startDownload(repo, 'root.gguf');
  const nestedId = await startDownload(repo, 'MTP/draft.gguf');
  await waitForEvent(repo, 'root-ready');
  await waitForEvent(repo, 'nested-ready');

  allow(repo, 'nested');
  await waitForStatus(nestedId, 'completed');
  allow(repo, 'root');
  await waitForStatus(rootId, 'completed');

  assert.equal(existsSync(join(target, 'MTP')), false, 'empty temporary directory is cleaned after peers finish');
  assert.equal(existsSync(join(target, 'root.gguf')), true);
  assert.equal(existsSync(join(target, 'draft.gguf')), true);
  const names = (await managerJson('/api/models')).body.localModels.map(model => model.name);
  assert.ok(names.includes('fixture_race-nested-first/root.gguf'));
  assert.ok(names.includes('fixture_race-nested-first/draft.gguf'));
});

test('local placement failures are not reported as gated-model or authentication denial', async () => {
  const repo = 'fixture/local-placement-failure';
  const id = await startDownload(repo, 'MTP/forced-local-error.gguf');
  const failed = await waitForStatus(id, 'failed');
  assert.match(failed.body.output, /No such file or directory.*placing downloaded artifact/i);
  assert.match(failed.body.error, /local|filesystem|placement/i);
  assert.doesNotMatch(failed.body.error, /gated|authentication|huggingface token|accept the model license/i);
  assert.equal(failed.body.gatedUrl, null);
});
