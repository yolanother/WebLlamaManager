// Llama Manager — GPU power-cap schedule black-box API contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Boots a copied manager with disposable config and ports, plus a fake
// nvidia-smi and a fake systemctl on PATH that together model one NVIDIA card
// (range 100-450 W) whose limit only changes when the manager starts
// llama-manager-gpu-power@<watts>.service. Verifies the cap is applied on
// service start, that /api/settings exposes and validates `gpuPower` against the
// card's range, that a window raises the cap immediately and removing it
// restores the default, and that /api/gpu-power reports the live schedule.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const WORK = mkdtempSync(join(tmpdir(), 'llama-gpu-power-'));
const APP_API = join(WORK, 'app', 'api');
const BIN = join(WORK, 'bin');
const LIMIT_FILE = join(WORK, 'limit');
const SYSTEMCTL_LOG = join(WORK, 'systemctl.log');
const CONFIG_PATH = join(WORK, 'config.json');
let apiPort;
let manager;
let managerLog = '';

/** Locate API dependencies in this worktree or its primary checkout. */
function dependencyDirectory() {
  const local = join(REPO_ROOT, 'api/node_modules');
  if (existsSync(join(local, 'express/package.json'))) return local;
  const commonGitDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  return join(dirname(resolve(REPO_ROOT, commonGitDir)), 'api/node_modules');
}

/** Return an unused loopback port. */
async function unusedPort() {
  const probe = createServer();
  await new Promise((accept, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', accept); });
  const { port } = probe.address();
  await new Promise((accept) => probe.close(accept));
  return port;
}

/** Install the fake card: nvidia-smi reads the limit file, systemctl writes it. */
function installFakeCard() {
  mkdirSync(BIN, { recursive: true });
  writeFileSync(LIMIT_FILE, '420');
  writeFileSync(join(BIN, 'nvidia-smi'), `#!/bin/bash
# Fake nvidia-smi: answers only the power query, as one RTX 3090.
[[ "$*" == *power.min_limit* ]] || exit 1
printf 'GPU-test, Fake RTX 3090, %s.00, 100.00, 450.00, 150.00\\n' "$(cat '${LIMIT_FILE}')"
`);
  writeFileSync(join(BIN, 'systemctl'), `#!/bin/bash
# Fake systemctl: records calls; starting the gpu-power unit sets the fake limit.
printf '%s\\n' "$*" >> '${SYSTEMCTL_LOG}'
if [[ "$1" == start && "$2" =~ ^llama-manager-gpu-power@([0-9]+)\\.service$ ]]; then
  printf '%s' "\${BASH_REMATCH[1]}" > '${LIMIT_FILE}'
fi
exit 0
`);
  chmodSync(join(BIN, 'nvidia-smi'), 0o755);
  chmodSync(join(BIN, 'systemctl'), 0o755);
}

/** Fetch JSON from the manager with its status. */
async function call(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** Poll until accept(read()) holds. */
async function eventually(read, accept, description) {
  let value;
  for (let i = 0; i < 100; i++) {
    value = await read();
    if (accept(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${description}; last: ${JSON.stringify(value)}\n${managerLog.slice(-2000)}`);
}

const limit = () => Number(readFileSync(LIMIT_FILE, 'utf8'));
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

before(async () => {
  cpSync(join(REPO_ROOT, 'api'), APP_API, { recursive: true, filter: (s) => !s.endsWith('/node_modules') });
  installFakeCard();
  writeFileSync(CONFIG_PATH, JSON.stringify({
    autoStart: false, presetsSeeded: true, logFilters: [], presets: {},
    backends: { enabled: false, directory: [] },
    gpuPower: { enabled: true, defaultWatts: 300, timezone: 'UTC', windows: [] },
  }));
  apiPort = await unusedPort();
  const dependencies = dependencyDirectory();
  manager = spawn(process.execPath, [
    '--experimental-loader', join(REPO_ROOT, 'tests/admin-api/worktree-module-loader.mjs'),
    join(APP_API, 'server.js'),
  ], {
    cwd: join(WORK, 'app'),
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      AUTO_START: 'false',
      EMBED_ENABLED: 'false',
      CONFIG_PATH,
      API_PORT: String(apiPort),
      LLAMA_PORT: String(await unusedPort()),
      EMBED_PORT: String(await unusedPort()),
      HOME: join(WORK, 'home'),
      MODELS_DIR: join(WORK, 'models'),
      LLAMA_MANAGER_CONFIG_DIR: join(WORK, 'etc'),
      LLAMA_MANAGER_DATA_DIR: join(WORK, 'data'),
      LLAMA_MANAGER_CACHE_DIR: join(WORK, 'cache'),
      LLAMA_MANAGER_TEST_NODE_MODULES: dependencies,
      NODE_PATH: dependencies,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  manager.stdout.on('data', (c) => { managerLog += c; });
  manager.stderr.on('data', (c) => { managerLog += c; });
  await eventually(
    async () => { try { return (await call('GET', '/api/settings')).status; } catch { return null; } },
    (s) => s === 200,
    'manager did not start',
  );
});

after(async () => {
  if (manager && manager.exitCode == null) {
    manager.kill('SIGTERM');
    await Promise.race([new Promise((a) => manager.once('exit', a)), new Promise((a) => setTimeout(a, 1000))]);
    if (manager.exitCode == null) manager.kill('SIGKILL');
  }
  rmSync(WORK, { recursive: true, force: true });
});

test('service start lowers the card to the default cap through the privileged unit', async () => {
  await eventually(async () => limit(), (w) => w === 300, 'cap was not applied on start');
  assert.match(readFileSync(SYSTEMCTL_LOG, 'utf8'), /^start llama-manager-gpu-power@300\.service$/m);
});

test('/api/settings exposes gpuPower and rejects a cap outside the card range', async () => {
  const settings = await call('GET', '/api/settings');
  assert.deepEqual(settings.body.settings.gpuPower, { enabled: true, defaultWatts: 300, timezone: 'UTC', windows: [] });
  await call('GET', '/api/gpu-power'); // learn the card range
  const bad = await call('POST', '/api/settings', { gpuPower: { defaultWatts: 500 } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /100-450/);
  const badWindow = await call('POST', '/api/settings', { gpuPower: { windows: [{ start: '25:00', end: '01:00', watts: 320 }] } });
  assert.equal(badWindow.status, 400);
});

test('a window raises the cap now and removing it restores the default', async () => {
  const now = Date.now();
  const windows = [{ start: hhmm(now), end: hhmm(now + 3 * 60_000), watts: 320 }];
  const saved = await call('POST', '/api/settings', { gpuPower: { windows } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await eventually(async () => limit(), (w) => w === 320, 'window cap was not applied');

  const status = await call('GET', '/api/gpu-power');
  assert.equal(status.body.available, true);
  assert.equal(status.body.targetWatts, 320);
  assert.equal(status.body.activeWindow.watts, 320);
  assert.equal(status.body.cards[0].limitWatts, 320);
  assert.equal(status.body.cards[0].drawWatts, 150);
  assert.equal(status.body.nextChange.watts, 300);

  await call('POST', '/api/settings', { gpuPower: { windows: [] } });
  await eventually(async () => limit(), (w) => w === 300, 'default cap was not restored');
  const persisted = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  assert.deepEqual(persisted.gpuPower, { enabled: true, defaultWatts: 300, timezone: 'UTC', windows: [] });
});
