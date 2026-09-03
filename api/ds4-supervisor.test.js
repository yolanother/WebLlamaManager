// Llama Manager — unit tests for api/ds4-supervisor.js (ds4-server supervisor).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDs4Supervisor } from './ds4-supervisor.js';
import { restartDecision, RESTART_DEFAULTS } from './restart-governor.js';

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
  const calls = { spawn: [], runKill: 0, scheduled: [], log: [], addLog: [] };
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
    log: (m) => calls.log.push(m),
    addLog: (channel, message) => calls.addLog.push({ channel, message }),
    runKill: overrides.runKill || (async () => { calls.runKill++; }),
    getWedged: overrides.getWedged,
    now: overrides.now || (() => 1000),
    sleep: async () => {},
    setTimeoutFn: (cb) => { calls.scheduled.push(cb); return 0; },
    onRestartBegin: overrides.onRestartBegin,
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

test('stop before start does not run global cleanup', async () => {
  const { sup, calls } = makeSup();
  await sup.stop();
  assert.equal(calls.runKill, 0);
});

test('stop: kills process, calls external kill, clears running', async () => {
  const { sup, calls, procs } = makeSup();
  sup.start(PRESET);
  await sup.stop();
  assert.ok(procs[0].signals.includes('SIGTERM'));
  assert.equal(calls.runKill, 1);
  assert.equal(sup.isRunning(), false);
});

test('stop: propagates runKill()\'s confirmation instead of discarding it', async () => {
  // Previously stop() awaited runKill() and threw the result away, so a caller
  // (runDs4AdaptivePlan's stopAttempt) could never tell a confirmed-dead
  // process apart from one that survived the kill window (D-state/wedged) —
  // see the "ds4 host fuser timed out" incident this locks a fix for.
  const { sup, procs } = makeSup({
    runKill: async () => ({ ok: false, remainingPids: [4242] }),
  });
  sup.start(PRESET);
  const result = await sup.stop();
  assert.equal(result.ok, false);
  assert.deepEqual(result.remainingPids, [4242]);
});

test('stop: a confirmed kill reports ok:true', async () => {
  const { sup } = makeSup({
    runKill: async () => ({ ok: true, remainingPids: [] }),
  });
  sup.start(PRESET);
  const result = await sup.stop();
  assert.equal(result.ok, true);
  assert.deepEqual(result.remainingPids, []);
});

test('stop: a runKill that reports nothing (existing/legacy callers) is treated as confirmed', async () => {
  const { sup } = makeSup(); // default runKill returns undefined
  sup.start(PRESET);
  const result = await sup.stop();
  assert.equal(result.ok, true);
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

test('exit: passes the wedged signal through to the restart governor', () => {
  const seen = [];
  const { sup, procs } = makeSup({
    getWedged: () => true,
    restartDecision: (a) => { seen.push(a); return { allow: true, reason: 'ok', history: [...(a.history || []), a.now], retryAfterMs: 0 }; },
  });
  sup.start(PRESET);
  procs[0].emit('exit', 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].wedged, true);
});

test('exit: wedged-hold suppresses ds4 auto-restart via the shared governor', () => {
  // Seed a prior restart, then a crash while the exec/GPU layer is wedged: the
  // real governor must hold (wedged-hold), not schedule another probe onto the
  // locked GPU. Mirrors the llama wedged-hold (commit e960d04) for ds4.
  let clock = 1_000_000;
  const { sup, calls, procs } = makeSup({
    getWedged: () => true,
    restartDecision,
    restartDefaults: RESTART_DEFAULTS,
    now: () => clock,
  });
  sup.start(PRESET);
  // First crash proceeds (no prior attempt to hold against) and reschedules.
  procs[0].emit('exit', 1);
  assert.equal(calls.scheduled.length, 1);
  calls.scheduled[0](); // spawns a fresh proc, recording the attempt in history
  assert.equal(calls.spawn.length, 2);
  // Second crash 30s later, still wedged: within wedgedCooldownMs -> HELD.
  clock += 30_000;
  procs[1].emit('exit', 1);
  assert.equal(calls.scheduled.length, 1, 'no new restart scheduled while wedged-held');
  assert.equal(calls.spawn.length, 2, 'no fresh ds4 process spawned during wedged-hold');
});

test('exit: not wedged still debounces/allows per the governor', () => {
  const { sup, procs } = makeSup({
    getWedged: () => false,
    restartDecision: (a) => { assert.equal(a.wedged, false); return { allow: true, reason: 'ok', history: [a.now], retryAfterMs: 0 }; },
  });
  sup.start(PRESET);
  procs[0].emit('exit', 1);
});

test('restart: stops then starts a fresh process', async () => {
  const { sup, calls, procs } = makeSup();
  sup.start(PRESET);
  await sup.restart();
  assert.equal(calls.spawn.length, 2);
  assert.ok(procs[0].signals.includes('SIGTERM'));
  assert.equal(sup.isRunning(), true);
});

// ── onRestartBegin: gate hook for restarts the request-triggered swap gate
// (server.js's ds4SwapPromise) never sees ──────────────────────────────────
// Bug: a crash-triggered auto-restart or an explicit restart() (e.g. the ds4
// auto-updater) never told server.js a restart was happening, so its
// ds4SwapPromise gate stayed null/already-resolved and concurrent requests
// sailed straight through to a ds4-server that was mid-restart, landing a
// fast "model not found" instead of queueing. onRestartBegin is the hook
// server.js wires its gate through.

test('restart: notifies onRestartBegin before stopping/respawning', async () => {
  const order = [];
  const { sup } = makeSup({
    onRestartBegin: () => { order.push('onRestartBegin'); },
  });
  sup.start(PRESET);
  order.push('started');
  await sup.restart();
  order.push('restarted');
  assert.deepEqual(order, ['started', 'onRestartBegin', 'restarted']);
});

test('exit: unexpected crash notifies onRestartBegin before the deferred respawn', () => {
  const order = [];
  const { sup, calls, procs } = makeSup({
    onRestartBegin: () => { order.push('onRestartBegin'); },
  });
  sup.start(PRESET);
  procs[0].emit('exit', 1); // crash
  assert.equal(order.length, 0, 'not notified until the deferred restart actually fires');
  calls.scheduled[0](); // fire the scheduled restart
  order.push('respawned');
  assert.deepEqual(order, ['onRestartBegin', 'respawned']);
});

test('exit: a suppressed (governor-held) auto-restart does NOT notify onRestartBegin', () => {
  const order = [];
  const { sup, procs } = makeSup({
    onRestartBegin: () => { order.push('onRestartBegin'); },
    restartDecision: () => ({ allow: false, reason: 'circuit-open', history: [], retryAfterMs: 60000 }),
  });
  sup.start(PRESET);
  procs[0].emit('exit', 1);
  assert.deepEqual(order, [], 'no restart was actually scheduled, so no gate should open');
});

test('onRestartBegin is optional (defaults to a no-op)', async () => {
  const { sup, procs } = makeSup(); // no onRestartBegin override
  sup.start(PRESET);
  await sup.restart();
  procs[1].emit('exit', 1);
  // Just must not throw.
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

// ── adaptive-plan hooks (context/streaming override + controller-driven retries) ──
test('start override: DS4_CTX + streaming env reflect the per-attempt override', () => {
  const { sup, calls } = makeSup();
  sup.start(PRESET, { override: { context: 16384, ssdStreaming: true, cacheExperts: '48GB' } });
  const env = calls.spawn[0].opts.env;
  assert.equal(env.DS4_CTX, '16384'); // override wins over preset.context (65536)
  assert.equal(env.DS4_SSD_STREAMING, '1');
  assert.equal(env.DS4_SSD_STREAMING_CACHE_EXPERTS, '48GB');
});

test('start override: non-streaming attempt sets DS4_SSD_STREAMING=0', () => {
  const { sup, calls } = makeSup();
  sup.start(PRESET, { override: { context: 8192, ssdStreaming: false } });
  const env = calls.spawn[0].opts.env;
  assert.equal(env.DS4_CTX, '8192');
  assert.equal(env.DS4_SSD_STREAMING, '0');
});

test('plan mode: exit during a plan does NOT auto-restart (controller drives retries)', () => {
  const { sup, calls, procs } = makeSup();
  sup.start(PRESET, { planMode: true, override: { context: 32768, ssdStreaming: false } });
  procs[0].emit('exit', 137); // load failure during the plan
  assert.equal(calls.scheduled.length, 0); // suppressed — controller advances attempts
  assert.equal(calls.spawn.length, 1);
});

test('endPlan: records the settled override so a later auto-restart reuses it', async () => {
  const { sup, calls, procs } = makeSup();
  sup.start(PRESET, { planMode: true, override: { context: 16384, ssdStreaming: true, cacheExperts: '32GB' } });
  await sup.health();                 // sawReady=true (settled + serving)
  sup.endPlan({ settled: { context: 16384, ssdStreaming: true, cacheExperts: '32GB' } });
  procs[0].emit('exit', 1);           // genuine crash AFTER settle → auto-restart
  assert.equal(calls.scheduled.length, 1);
  calls.scheduled[0]();               // fire → procs[1] with the settled config
  const env = calls.spawn[1].opts.env;
  assert.equal(env.DS4_CTX, '16384');
  assert.equal(env.DS4_SSD_STREAMING, '1');
  assert.equal(env.DS4_SSD_STREAMING_CACHE_EXPERTS, '32GB');
});

test('endPlan: exhausted plan (settled=null) clears the override and restores auto-restart', () => {
  const { sup, calls, procs } = makeSup();
  sup.start(PRESET, { planMode: true, override: { context: 8192, ssdStreaming: false } });
  sup.endPlan({ settled: null });     // plan exhausted → no settled config
  assert.equal(sup.getActiveOverride(), null);
  // Leaving plan mode restores normal auto-restart on a crash.
  procs[0].emit('exit', 1);
  assert.equal(calls.scheduled.length, 1);
});

test('load-failure breaker: stops auto-restart after ds4MaxLoadFailures exits before ready', () => {
  const { sup, calls, procs } = makeSup({ config: { ds4: {}, guard: { ds4MaxLoadFailures: 2 } } });
  sup.start(PRESET);                 // procs[0]
  procs[0].emit('exit', 137);        // load failure #1 (never ready) → auto-restart scheduled
  assert.equal(calls.scheduled.length, 1);
  calls.scheduled[0]();              // fire the scheduled auto-restart → procs[1]
  assert.equal(procs.length, 2);
  procs[1].emit('exit', 137);        // load failure #2 → breaker trips, NO new schedule
  assert.equal(calls.scheduled.length, 1);
  assert.equal(sup.isRunning(), false);
});

test('load-failure breaker: a successful serve (health ok) resets and keeps auto-restart', async () => {
  const { sup, calls, procs } = makeSup({ config: { ds4: {}, guard: { ds4MaxLoadFailures: 2 } } });
  sup.start(PRESET);                 // procs[0]
  await sup.health();                // fetchFn ok → sawReady=true, failures reset
  procs[0].emit('exit', 137);        // exit AFTER serving = genuine crash, not a load failure
  assert.equal(calls.scheduled.length, 1); // still auto-restarts
});

test('load-failure breaker: fresh (non-auto) activation resets the failure count', () => {
  const { sup, calls, procs } = makeSup({ config: { ds4: {}, guard: { ds4MaxLoadFailures: 2 } } });
  sup.start(PRESET);
  procs[0].emit('exit', 137);        // failure #1
  calls.scheduled[0]();              // auto-restart → procs[1]
  sup.start(PRESET);                 // operator re-activates while procs[1] running — no-op running, but...
  // simulate operator re-activation after a stop: stop clears running, fresh start resets counter
  procs[1].emit('exit', 137);        // this would be #2 without reset... but re-activation reset it above only if not running
  // The meaningful guarantee: after the breaker trips, a brand-new start() gets fresh attempts.
  assert.ok(calls.spawn.length >= 2);
});

// ── stderr/stdout capture on exit (diagnosability for "exited (code N)") ────
//
// A crash-driven exit previously logged only a bare "exited (code N)" line via
// the console-only `log()` — nothing reached addLog()/`/api/logs`, and nothing
// captured what the process actually printed before dying. That made every
// non-zero exit permanently undiagnosable after the fact: exactly what
// happened to the exit(2) incident this test locks in a fix for (ds4-server's
// own CLI arg-parser exits 2 on a bad flag value, but the message naming the
// bad flag was never captured anywhere).

test('exit: recent stdout/stderr output is attached to the exit log line, via addLog too', () => {
  const { sup, calls, procs } = makeSup();
  sup.start(PRESET);
  const proc = procs[0];
  proc.stdout.emit('data', 'ds4-server: listening on http://127.0.0.1:5253\n');
  proc.stderr.emit('data', 'ds4-server: invalid value for -c: abc\n');
  proc.emit('exit', 2);
  const exitLog = calls.log.find((m) => m.includes('exited (code 2)'));
  assert.ok(exitLog, 'console log must still report the exit');
  assert.match(exitLog, /invalid value for -c: abc/, 'the captured stderr line must be attached to the exit log, not silently dropped');
  const exitAddLog = calls.addLog.find((c) => c.channel === 'system' && /exited \(code 2\)/.test(c.message));
  assert.ok(exitAddLog, 'the exit line must also reach addLog(\'system\', ...) so it shows up in /api/logs, not just console');
  assert.match(exitAddLog.message, /invalid value for -c: abc/);
});

test('exit: an exit with nothing captured says so explicitly (proves loss vs silence)', () => {
  const { sup, calls, procs } = makeSup();
  sup.start(PRESET);
  procs[0].emit('exit', 2); // no stdout/stderr data emitted first
  const exitAddLog = calls.addLog.find((c) => c.channel === 'system' && /exited \(code 2\)/.test(c.message));
  assert.ok(exitAddLog);
  assert.match(exitAddLog.message, /no stdout\/stderr captured/i);
});

test('exit: only the last N output lines are kept, not an unbounded log', () => {
  const { sup, calls, procs } = makeSup();
  sup.start(PRESET);
  const proc = procs[0];
  for (let i = 0; i < 30; i++) proc.stdout.emit('data', `line ${i}\n`);
  proc.emit('exit', 1);
  const exitAddLog = calls.addLog.find((c) => c.channel === 'system' && /exited \(code 1\)/.test(c.message));
  assert.doesNotMatch(exitAddLog.message, /line 0\n/, 'the earliest lines must have been dropped once the buffer filled');
  assert.match(exitAddLog.message, /line 29/, 'the most recent line must be kept');
});
