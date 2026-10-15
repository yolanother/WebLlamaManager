// Llama Manager — unit tests for the generic engine supervisor (createEngineSupervisor).
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies the engine-neutral supervisor state machine exported from
// ds4-supervisor.js with fake spawn/fetch/timers (no real process): the injected
// launch(preset, override) result is exactly what gets spawned, a post-settle
// auto-restart reuses the last override, a probe reporting 'loading' never marks
// the engine ready, the injected maxLoadFailures() is honoured by the load-failure
// breaker, and exit log lines are named after the injected processName.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as sup from './ds4-supervisor.js';

/** A fake child process good enough for the supervisor's exit/kill/stdio wiring. */
function fakeProc(pid) {
  const p = new EventEmitter();
  p.pid = pid;
  p.killed = false;
  p.kill = () => { p.killed = true; return true; };
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  return p;
}

/** Build a strata-flavoured generic supervisor over recording fakes. */
function make({ probeStatus = 'ok', maxLoad = 2 } = {}) {
  const calls = { spawn: [], launch: [], scheduled: [], addLog: [], log: [] };
  const procs = [];
  const state = { probeStatus, maxLoad };
  const s = sup.createEngineSupervisor({
    label: 'strata',
    processName: 'strata',
    launch: (preset, override) => {
      calls.launch.push({ preset, override });
      return { cmd: '/py', args: ['server.py', '--port', '18090'], opts: { cwd: '/root', env: { X: '1' } } };
    },
    probe: async () => ({ status: state.probeStatus }),
    port: () => 18090,
    maxLoadFailures: () => state.maxLoad,
    spawn: (cmd, args, opts) => {
      const p = fakeProc(2000 + procs.length);
      calls.spawn.push({ cmd, args, opts });
      procs.push(p);
      return p;
    },
    fetchFn: async () => ({ ok: true }),
    getConfig: () => ({}),
    projectRoot: '/proj',
    restartDecision: (a) => ({ allow: true, reason: 'ok', history: [...(a.history || []), a.now], retryAfterMs: 0 }),
    restartDefaults: {},
    log: (m) => calls.log.push(m),
    addLog: (channel, message) => calls.addLog.push({ channel, message }),
    runKill: async () => ({ ok: true, remainingPids: [] }),
    now: () => 1000,
    sleep: async () => {},
    setTimeoutFn: (cb) => { calls.scheduled.push(cb); return 0; },
  });
  return { s, calls, procs, state };
}

const PRESET = { id: 'strata-q', engine: 'strata' };

test('createEngineSupervisor is exported and ds4 wrapper still exists', () => {
  assert.equal(typeof sup.createEngineSupervisor, 'function');
  assert.equal(typeof sup.createDs4Supervisor, 'function');
});

test('launch(preset, override) result is what gets spawned', () => {
  const { s, calls } = make();
  s.start(PRESET, { override: { backend: 'cuda' } });
  assert.deepEqual(calls.launch, [{ preset: PRESET, override: { backend: 'cuda' } }]);
  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.spawn[0].cmd, '/py');
  assert.deepEqual(calls.spawn[0].args, ['server.py', '--port', '18090']);
  assert.equal(calls.spawn[0].opts.cwd, '/root');
  assert.equal(calls.spawn[0].opts.env.X, '1');
  assert.equal(s.isRunning(), true);
});

test('auto-restart after an unexpected exit reuses the last override', () => {
  const { s, calls, procs } = make({ maxLoad: 5 });
  s.start(PRESET, { override: { backend: 'cuda' } });
  procs[0].emit('exit', 1);
  assert.equal(calls.scheduled.length, 1);
  calls.scheduled[0]();
  assert.equal(calls.launch.length, 2);
  assert.deepEqual(calls.launch[1].override, { backend: 'cuda' });
  assert.equal(calls.spawn.length, 2);
});

test('probe "loading" is not ready: health is not ok and a crash still counts as a load failure', async () => {
  const { s, calls, procs } = make({ probeStatus: 'loading', maxLoad: 1 });
  s.start(PRESET);
  const h = await s.health();
  assert.notEqual(h.status, 'ok');
  assert.equal(h.port, 18090);
  procs[0].emit('exit', 1);
  assert.equal(calls.scheduled.length, 0, 'never-ready crash trips the breaker at maxLoadFailures=1');
});

test('probe "ok" marks ready: a later crash is auto-restarted', async () => {
  const { s, calls, procs } = make({ probeStatus: 'ok', maxLoad: 1 });
  s.start(PRESET);
  const h = await s.health();
  assert.equal(h.status, 'ok');
  procs[0].emit('exit', 1);
  assert.equal(calls.scheduled.length, 1);
});

test('maxLoadFailures() is honoured: breaker trips after N failed loads', () => {
  const { s, calls, procs } = make({ maxLoad: 2 });
  s.start(PRESET);
  procs[0].emit('exit', 1);
  assert.equal(calls.scheduled.length, 1, 'first failure still restarts');
  calls.scheduled[0]();
  procs[1].emit('exit', 1);
  assert.equal(calls.scheduled.length, 1, 'second failure trips the breaker; no further restart');
  assert.equal(calls.spawn.length, 2);
});

test('maxLoadFailures() is read live (a higher value allows more restarts)', () => {
  const { s, calls, procs, state } = make({ maxLoad: 2 });
  state.maxLoad = 3;
  s.start(PRESET);
  procs[0].emit('exit', 1);
  calls.scheduled[0]();
  procs[1].emit('exit', 1);
  assert.equal(calls.scheduled.length, 2);
});

test('exit log line uses processName, not ds4-server', () => {
  const { s, calls, procs } = make();
  s.start(PRESET);
  procs[0].stderr.emit('data', 'boom\n');
  procs[0].emit('exit', 3);
  const lines = [...calls.log, ...calls.addLog.map((l) => l.message)].join('\n');
  assert.match(lines, /strata exited \(code 3\)/);
  assert.doesNotMatch(lines, /ds4-server/);
  assert.match(lines, /boom/);
});
