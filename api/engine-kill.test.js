// Llama Manager — unit tests for the robust host-PID engine-kill helper.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Verifies engine-kill.js without touching real /proc or signalling real processes:
// enginePids() filters a proc table by EXACT comm (never cross-matching the other
// engine), and killEngineByComm() SIGKILLs exactly the target pids, re-signals
// survivors each poll, resolves ok:true once they are gone, and times out cleanly
// (ok:false + remainingPids) when a pid persists (the D-state / wedged-GPU case).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enginePids, killEngineByComm } from './engine-kill.js';

// A mutable fake /proc: an array of { pid, comm }. A kill fn can splice pids out
// to simulate a process dying, or leave them to simulate a wedged D-state process.
function makeProc(rows) {
  const table = rows.map((r) => ({ ...r }));
  return {
    read: () => table.map((r) => ({ ...r })),
    remove: (pid) => {
      const i = table.findIndex((r) => r.pid === pid);
      if (i >= 0) table.splice(i, 1);
    },
    table,
  };
}

// Deterministic clock + sleep: sleep advances a virtual clock instead of waiting.
function makeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

// ── enginePids ────────────────────────────────────────────────────────────────
test('enginePids: matches only the exact comm, never the other engine', () => {
  const table = [
    { pid: 10, comm: 'llama-server' },
    { pid: 11, comm: 'llama-server' },
    { pid: 20, comm: 'ds4-server' },
    { pid: 30, comm: 'bash' },
    { pid: 40, comm: 'llama-server\n' }, // trailing newline is trimmed
  ];
  assert.deepEqual(enginePids(table, 'llama-server'), [10, 11, 40]);
  assert.deepEqual(enginePids(table, 'ds4-server'), [20]);
});

test('enginePids: empty when no match', () => {
  assert.deepEqual(enginePids([{ pid: 1, comm: 'node' }], 'llama-server'), []);
});

// ── killEngineByComm ───────────────────────────────────────────────────────────
test('killEngineByComm: no target processes → ok immediately, no kills', async () => {
  const proc = makeProc([{ pid: 5, comm: 'ds4-server' }]);
  const killed = [];
  const clock = makeClock();
  const res = await killEngineByComm({
    comm: 'llama-server',
    readProcTable: proc.read,
    kill: (pid, sig) => killed.push([pid, sig]),
    ...clock,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.remainingPids, []);
  assert.deepEqual(killed, []); // never signalled the ds4 process
});

test('killEngineByComm: SIGKILLs exactly the target pids and waits until gone', async () => {
  const proc = makeProc([
    { pid: 10, comm: 'llama-server' },
    { pid: 11, comm: 'llama-server' },
    { pid: 20, comm: 'ds4-server' },
  ]);
  const killed = [];
  const clock = makeClock();
  // Processes die on the first kill signal.
  const res = await killEngineByComm({
    comm: 'llama-server',
    readProcTable: proc.read,
    kill: (pid, sig) => { killed.push([pid, sig]); proc.remove(pid); },
    timeoutMs: 20_000,
    intervalMs: 250,
    ...clock,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.remainingPids, []);
  // Only llama-server pids were signalled, each with SIGKILL; ds4 untouched.
  assert.deepEqual(killed.sort((a, b) => a[0] - b[0]), [[10, 'SIGKILL'], [11, 'SIGKILL']]);
  // ds4-server still resident.
  assert.deepEqual(enginePids(proc.read(), 'ds4-server'), [20]);
});

test('killEngineByComm: re-signals a survivor across polls, then succeeds', async () => {
  const proc = makeProc([{ pid: 10, comm: 'llama-server' }]);
  const killed = [];
  const clock = makeClock();
  let hits = 0;
  const res = await killEngineByComm({
    comm: 'llama-server',
    readProcTable: proc.read,
    // Dies only after the SECOND signal (slow-to-die process).
    kill: (pid, sig) => { killed.push([pid, sig]); if (++hits >= 2) proc.remove(pid); },
    timeoutMs: 20_000,
    intervalMs: 250,
    ...clock,
  });
  assert.equal(res.ok, true);
  assert.equal(killed.length, 2); // initial + one re-signal
});

test('killEngineByComm: times out cleanly when a pid persists (D-state / wedged GPU)', async () => {
  const proc = makeProc([{ pid: 10, comm: 'llama-server' }]);
  const killed = [];
  const clock = makeClock();
  const res = await killEngineByComm({
    comm: 'llama-server',
    readProcTable: proc.read,
    kill: (pid, sig) => killed.push([pid, sig]), // never dies (D-state)
    timeoutMs: 1_000,
    intervalMs: 250,
    ...clock,
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.remainingPids, [10]);
  assert.ok(res.waitedMs >= 1_000);
  assert.ok(killed.length >= 1); // did attempt the kill
});

test('killEngineByComm: kill fn that throws does not abort the loop', async () => {
  const proc = makeProc([{ pid: 10, comm: 'llama-server' }]);
  const clock = makeClock();
  let calls = 0;
  const res = await killEngineByComm({
    comm: 'llama-server',
    readProcTable: proc.read,
    kill: (pid) => { calls++; if (calls === 1) throw new Error('ESRCH'); proc.remove(pid); },
    timeoutMs: 5_000,
    intervalMs: 250,
    ...clock,
  });
  assert.equal(res.ok, true);
});
