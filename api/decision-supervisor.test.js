// Llama Manager — unit tests for api/decision-supervisor.js (laya-server lazy supervisor).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDecisionSupervisor } from './decision-supervisor.js';
import { resolveDecisionConfig, DECISION_CONTAINER_NAME } from './decision.js';

const PINNED = `sha256:${'b'.repeat(64)}`;

/** Fake child process with the exit/kill/stdio surface the supervisor uses. */
function fakeProc() {
  const p = new EventEmitter();
  p.killed = false;
  p.kill = () => { p.killed = true; return true; };
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  return p;
}

/** Build a supervisor with recording fakes and a manual clock. */
function makeSup({ enabled = true, healthyAfter = 0, config, sleep } = {}) {
  const calls = { spawn: [], podman: [], timers: [], dirs: [] };
  const clock = { t: 0 };
  let probes = 0;
  const procs = [];
  const cfg = config || { decision: { enabled, image: PINNED, idleTimeoutSec: 60, startTimeoutSec: 5 } };
  const sup = createDecisionSupervisor({
    spawn: (cmd, args) => { const p = fakeProc(); calls.spawn.push({ cmd, args }); procs.push(p); return p; },
    runPodman: async (args) => { calls.podman.push(args); },
    fetchFn: async () => ({ ok: probes++ >= healthyAfter }),
    getConfig: () => resolveDecisionConfig(cfg, {}),
    cacheDir: '/cache/decision',
    ensureDir: (d) => calls.dirs.push(d),
    now: () => clock.t,
    sleep: sleep || (async (ms) => { clock.t += ms; }),
    setTimeoutFn: (fn, ms) => { const h = { fn, ms, cleared: false }; calls.timers.push(h); return h; },
    clearTimeoutFn: (h) => { if (h) h.cleared = true; },
  });
  return { sup, calls, procs, clock };
}

test('ensureStarted: creates the cache dir, clears a stale container, spawns podman run, waits for /healthz', async () => {
  const { sup, calls } = makeSup({ healthyAfter: 2 });
  await sup.ensureStarted();
  assert.deepEqual(calls.dirs, ['/cache/decision']);
  assert.deepEqual(calls.podman[0], ['rm', '-f', DECISION_CONTAINER_NAME]);
  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.spawn[0].cmd, 'podman');
  assert.equal(calls.spawn[0].args[0], 'run');
  assert.equal(calls.spawn[0].args.at(-1), PINNED);
  assert.deepEqual({ running: sup.status().running, healthy: sup.status().healthy }, { running: true, healthy: true });
});

test('ensureStarted: a running healthy engine is reused, and concurrent callers share one spawn', async () => {
  const { sup, calls } = makeSup({ healthyAfter: 1 });
  await Promise.all([sup.ensureStarted(), sup.ensureStarted(), sup.ensureStarted()]);
  await sup.ensureStarted();
  assert.equal(calls.spawn.length, 1);
});

test('ensureStarted: refuses when not runnable and never spawns', async () => {
  const { sup, calls } = makeSup({ enabled: false });
  await assert.rejects(sup.ensureStarted(), /not runnable: disabled in config/);
  assert.equal(calls.spawn.length, 0);
});

test('ensureStarted: container exit during start rejects with the exit code', async () => {
  // sleep yields a macrotask without advancing the clock, so only the exit can end the wait
  const { sup, procs } = makeSup({ healthyAfter: 1000, sleep: () => new Promise((r) => setImmediate(r)) });
  const pending = sup.ensureStarted();
  await new Promise((r) => setImmediate(r));
  procs[0].emit('exit', 125);
  await assert.rejects(pending, /exited with code 125/);
  assert.equal(sup.status().running, false);
});

test('ensureStarted: start timeout stops the container and rejects', async () => {
  const { sup, calls } = makeSup({ healthyAfter: 1000 });
  await assert.rejects(sup.ensureStarted(), /not healthy after 5s/);
  assert.deepEqual(calls.podman.at(-1), ['stop', '-t', '10', DECISION_CONTAINER_NAME]);
  assert.equal(sup.status().running, false);
});

test('idle timeout: each touch re-arms the timer; firing it stops the container', async () => {
  const { sup, calls } = makeSup();
  await sup.ensureStarted();
  sup.touch();
  const live = calls.timers.filter((t) => !t.cleared);
  assert.equal(live.length, 1);
  assert.equal(live[0].ms, 60_000);
  await live[0].fn();
  assert.deepEqual(calls.podman.at(-1), ['stop', '-t', '10', DECISION_CONTAINER_NAME]);
  assert.equal(sup.status().running, false);
  assert.ok(sup.status().lastUsedAt !== null);
});

test('stop on a never-started supervisor is a no-op', async () => {
  const { sup, calls } = makeSup();
  await sup.stop();
  assert.equal(calls.podman.length, 0);
});
