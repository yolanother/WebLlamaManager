// Llama Manager — unit tests for api/ds4-supervisor.js (ds4-server supervisor).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDs4Supervisor } from './ds4-supervisor.js';

/** A fake child process good enough for the supervisor's exit/kill/stdio wiring. */
function fakeProc(pid = 1234) {
  const p = new EventEmitter();
  p.pid = pid;
  p.killed = false;
  p.signals = [];
  p.kill = (sig) => { p.signals.push(sig); p.killed = true; return true; };
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  return p;
}

/** Build a supervisor with recording fakes; returns { sup, calls, procs, opts }. */
function makeSup(overrides = {}) {
  const calls = { spawn: [], runKill: 0, scheduled: [] };
  const procs = [];
  const spawn = (cmd, args, opts) => {
    const p = fakeProc(1000 + procs.length);
    calls.spawn.push({ cmd, args, opts });
    procs.push(p);
    return p;
  };
  const config = overrides.config || { ds4: {} };
  const sup = createDs4Supervisor({
    spawn,
    fetchFn: overrides.fetchFn || (async () => ({ ok: true })),
    getConfig: () => config,
    env: overrides.env || {},
    projectRoot: '/proj',
    restartDecision: overrides.restartDecision || ((a) => ({ allow: true, reason: 'ok', history: [...(a.history || []), a.now], retryAfterMs: 0 })),
    restartDefaults: {},
    log: () => {},
    addLog: () => {},
    runKill: async () => { calls.runKill++; },
    now: overrides.now || (() => 1000),
    sleep: async () => {},
    setTimeoutFn: (cb) => { calls.scheduled.push(cb); return 0; },
  });
  return { sup, calls, procs };
}

const PRESET = { id: 'ds4-deepseek', name: 'DeepSeek V4', engine: 'ds4', modelPath: 'model.gguf', context: 65536, config: { power: 90 } };

test('start: spawns start-ds4.sh and marks running', () => {
  const { sup, calls } = makeSup();
  sup.start(PRESET);
  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.spawn[0].cmd, 'bash');
  assert.match(calls.spawn[0].args[0], /start-ds4\.sh$/);
  assert.equal(sup.isRunning(), true);
  assert.equal(sup.getActivePreset().id, 'ds4-deepseek');
});

test('start: env carries ds4 launch vars', () => {
  const { sup, calls } = makeSup();
  sup.start(PRESET);
  const env = calls.spawn[0].opts.env;
  assert.equal(env.DS4_SERVER_BIN, '/home/yolan/.local/bin/ds4-server');
  assert.equal(env.DS4_PORT, '5253');
  // model resolved under the ds4 ggufDir
  assert.equal(env.DS4_MODEL, '/home/yolan/models-ds4/deepseek-v4-gguf/model.gguf');
  assert.equal(env.DS4_CTX, '65536');
  assert.equal(env.DS4_POWER, '90');
});

test('start: idempotent while running (no second spawn)', () => {
  const { sup, calls } = makeSup();
  sup.start(PRESET);
  sup.start(PRESET);
  assert.equal(calls.spawn.length, 1);
});

test('stop: kills process, calls external kill, clears running', async () => {
  const { sup, calls, procs } = makeSup();
  sup.start(PRESET);
  await sup.stop();
  assert.ok(procs[0].signals.includes('SIGTERM'));
  assert.equal(calls.runKill, 1);
  assert.equal(sup.isRunning(), false);
});

test('stop: intentional exit does NOT auto-restart', async () => {
  const { sup, calls, procs } = makeSup();
  sup.start(PRESET);
  const proc = procs[0];
  await sup.stop();
  proc.emit('exit', 0); // late exit after intentional stop
  assert.equal(calls.scheduled.length, 0);
  assert.equal(calls.spawn.length, 1);
});

test('exit: unexpected crash schedules governed auto-restart', () => {
  const { sup, calls, procs } = makeSup();
  sup.start(PRESET);
  procs[0].emit('exit', 1); // crash
  assert.equal(calls.scheduled.length, 1);
  // fire the scheduled restart
  calls.scheduled[0]();
  assert.equal(calls.spawn.length, 2);
  assert.equal(sup.isRunning(), true);
});

test('exit: governor can suppress auto-restart', () => {
  const { sup, calls, procs } = makeSup({
    restartDecision: () => ({ allow: false, reason: 'circuit-open', history: [], retryAfterMs: 60000 }),
  });
  sup.start(PRESET);
  procs[0].emit('exit', 1);
  assert.equal(calls.scheduled.length, 0);
  assert.equal(calls.spawn.length, 1);
});

test('restart: stops then starts a fresh process', async () => {
  const { sup, calls, procs } = makeSup();
  sup.start(PRESET);
  await sup.restart();
  assert.equal(calls.spawn.length, 2);
  assert.ok(procs[0].signals.includes('SIGTERM'));
  assert.equal(sup.isRunning(), true);
});

test('health: ok when /v1/models returns 200', async () => {
  const { sup } = makeSup({ fetchFn: async () => ({ ok: true }) });
  sup.start(PRESET);
  const h = await sup.health();
  assert.equal(h.status, 'ok');
  assert.equal(h.port, 5253);
  assert.equal(h.model, 'ds4-deepseek');
});

test('health: error when /v1/models returns non-200', async () => {
  const { sup } = makeSup({ fetchFn: async () => ({ ok: false }) });
  sup.start(PRESET);
  const h = await sup.health();
  assert.equal(h.status, 'error');
});

test('health: unavailable when fetch throws', async () => {
  const { sup } = makeSup({ fetchFn: async () => { throw new Error('conn refused'); } });
  sup.start(PRESET);
  const h = await sup.health();
  assert.equal(h.status, 'unavailable');
});

test('health: stopped when not running', async () => {
  const { sup } = makeSup();
  const h = await sup.health();
  assert.equal(h.status, 'stopped');
});
