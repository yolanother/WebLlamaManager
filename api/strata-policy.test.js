// Llama Manager — tests for the pure Strata CUDA <-> HIP backend policy (api/strata-policy.js).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Purpose: pins the contract of the Strata backend policy module (docs/Designs/StrataEngine.md §8.3):
// nvidia-smi compute-app parsing, "other process" VRAM accounting, CUDA idleness, blocking-claim
// detection, the runtime CUDA/HIP swap decision (with hysteresis, failure backoff and blind-stay),
// and first-activation CUDA admission. Everything under test is pure, so no I/O is faked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STRATA_HOLDER,
  parseComputeApps,
  otherComputeVramBytes,
  cudaIdle,
  blockingClaim,
  strataBackendDecision,
  cudaAdmission,
} from './strata-policy.js';

const MiB = 1048576;
const OWN = ['strata', 'ggml-rpc-server', 'rpc-server'];
const RETURN_AFTER = 60_000;
const NOW = 1_000_000;

/** Asserts a decision's action and idleSinceMs exactly, and that reason is a non-empty string. */
function expectDecision(d, action, idleSinceMs) {
  assert.equal(d.action, action);
  assert.equal(d.idleSinceMs, idleSinceMs);
  assert.equal(typeof d.reason, 'string');
  assert.ok(d.reason.length > 0);
}

// ---- STRATA_HOLDER ----
test('STRATA_HOLDER is the llama-manager/strata reservation holder', () => {
  assert.equal(STRATA_HOLDER, 'llama-manager/strata');
});

// ---- parseComputeApps ----
test('parseComputeApps converts MiB rows to bytes', () => {
  const apps = parseComputeApps('1234, strata, 2048\n99, /usr/bin/python3, 100\n');
  assert.deepEqual(apps, [
    { pid: 1234, name: 'strata', usedBytes: 2048 * MiB },
    { pid: 99, name: '/usr/bin/python3', usedBytes: 100 * MiB },
  ]);
});

test('parseComputeApps skips [N/A] and malformed rows', () => {
  const csv = ['10, ok, 5', '11, na, [N/A]', 'garbage', '12, short', 'abc, bad, 7', '13, neg, -4', ''].join('\n');
  assert.deepEqual(parseComputeApps(csv), [{ pid: 10, name: 'ok', usedBytes: 5 * MiB }]);
});

test('parseComputeApps returns [] for an empty or blank string', () => {
  assert.deepEqual(parseComputeApps(''), []);
  assert.deepEqual(parseComputeApps('\n  \n'), []);
});

// ---- otherComputeVramBytes ----
test('otherComputeVramBytes sums only processes that are not Strata-owned', () => {
  const apps = [
    { pid: 1, name: 'strata', usedBytes: 100 },
    { pid: 2, name: 'ggml-rpc-server', usedBytes: 200 },
    { pid: 3, name: 'rpc-server', usedBytes: 400 },
    { pid: 4, name: 'blender', usedBytes: 1000 },
    { pid: 5, name: 'python3', usedBytes: 20 },
  ];
  assert.equal(otherComputeVramBytes(apps, OWN), 1020);
});

test('otherComputeVramBytes excludes own names by basename of a full path', () => {
  const apps = [
    { pid: 1, name: '/opt/strata/bin/strata', usedBytes: 100 },
    { pid: 2, name: '/usr/local/bin/ggml-rpc-server', usedBytes: 200 },
    { pid: 3, name: '/usr/bin/blender', usedBytes: 7 },
  ];
  assert.equal(otherComputeVramBytes(apps, OWN), 7);
});

test('otherComputeVramBytes is 0 for an empty list and null (blind) for a non-array', () => {
  assert.equal(otherComputeVramBytes([], OWN), 0);
  assert.equal(otherComputeVramBytes(null, OWN), null);
  assert.equal(otherComputeVramBytes(undefined, OWN), null);
  assert.equal(otherComputeVramBytes('1, a, 2', OWN), null);
});

// ---- cudaIdle ----
test('cudaIdle is true when other usage is at or under baseline + growth', () => {
  assert.equal(cudaIdle({ otherVramBytes: 0, baselineBytes: 100, growthBytes: 50 }), true);
  assert.equal(cudaIdle({ otherVramBytes: 150, baselineBytes: 100, growthBytes: 50 }), true);
});

test('cudaIdle is false when other usage exceeds baseline + growth', () => {
  assert.equal(cudaIdle({ otherVramBytes: 151, baselineBytes: 100, growthBytes: 50 }), false);
});

test('cudaIdle is false when blind (null)', () => {
  assert.equal(cudaIdle({ otherVramBytes: null, baselineBytes: 100, growthBytes: 50 }), false);
});

// ---- blockingClaim ----
const claim = (over) => ({ id: 'r1', holder: 'pods', priority: 80, state: 'held', gpu: 'rtx3090', ...over });

test('blockingClaim: another pending or held claim at >= our priority blocks', () => {
  assert.ok(blockingClaim([claim({ state: 'held', priority: 80 })], 50, 'mine'));
  assert.ok(blockingClaim([claim({ state: 'pending', priority: 80 })], 50, 'mine'));
  assert.ok(blockingClaim([claim({ priority: 50 })], 50, 'mine'), 'equal priority blocks');
});

test('blockingClaim: our own id is ignored', () => {
  assert.ok(!blockingClaim([claim({ id: 'mine' })], 50, 'mine'));
});

test('blockingClaim: terminal states are ignored', () => {
  for (const state of ['released', 'expired', 'preempted', 'cancelled']) {
    assert.ok(!blockingClaim([claim({ state })], 50, 'mine'), state);
  }
});

test('blockingClaim: lower priority claims are ignored', () => {
  assert.ok(!blockingClaim([claim({ priority: 49 })], 50, 'mine'));
});

test('blockingClaim: no reservations means nothing blocks', () => {
  assert.ok(!blockingClaim([], 50, 'mine'));
});

// ---- strataBackendDecision: CUDA ----
const cudaBase = () => ({
  backend: 'cuda', cudaConfigured: true, leaseState: 'held', blocking: false,
  otherVramBytes: 0, baselineBytes: 100, growthBytes: 50, idleSinceMs: 5, cudaFailedAt: null,
  busy: false, now: NOW, returnAfterMs: RETURN_AFTER,
});

test('CUDA rule 1: lease not held yields to HIP and clears idleSinceMs', () => {
  for (const leaseState of ['pending', 'preempted', 'expired', 'released', null]) {
    expectDecision(strataBackendDecision({ ...cudaBase(), leaseState }), 'yield-to-hip', null);
  }
});

test('CUDA rule 2: other VRAM above baseline + growth yields to HIP', () => {
  expectDecision(strataBackendDecision({ ...cudaBase(), otherVramBytes: 151 }), 'yield-to-hip', null);
});

test('CUDA rule 3: other VRAM at the threshold stays, resetting idleSinceMs', () => {
  expectDecision(strataBackendDecision({ ...cudaBase(), otherVramBytes: 150 }), 'stay', null);
});

test('CUDA rule 3: blind (null) never flaps - it stays', () => {
  expectDecision(strataBackendDecision({ ...cudaBase(), otherVramBytes: null }), 'stay', null);
});

// ---- strataBackendDecision: HIP ----
const hipBase = () => ({
  backend: 'hip', cudaConfigured: true, leaseState: null, blocking: false,
  otherVramBytes: 0, baselineBytes: 100, growthBytes: 50, idleSinceMs: NOW - RETURN_AFTER - 1,
  cudaFailedAt: null, busy: false, now: NOW, returnAfterMs: RETURN_AFTER,
});

test('HIP rule 1: CUDA not configured stays with idleSinceMs null', () => {
  expectDecision(strataBackendDecision({ ...hipBase(), cudaConfigured: false }), 'stay', null);
});

test('HIP rule 2: a blocking claim stays with idleSinceMs null', () => {
  expectDecision(strataBackendDecision({ ...hipBase(), blocking: true }), 'stay', null);
});

test('HIP rule 3: CUDA not idle stays with idleSinceMs null', () => {
  expectDecision(strataBackendDecision({ ...hipBase(), otherVramBytes: 151 }), 'stay', null);
});

test('HIP rule 3: blind (null) stays with idleSinceMs null', () => {
  expectDecision(strataBackendDecision({ ...hipBase(), otherVramBytes: null }), 'stay', null);
});

test('HIP rule 4: idleSinceMs starts at now when null, and stays (hysteresis not elapsed)', () => {
  expectDecision(strataBackendDecision({ ...hipBase(), idleSinceMs: null }), 'stay', NOW);
});

test('HIP rule 5: a recent CUDA failure stays and keeps idleSinceMs', () => {
  const idleSinceMs = NOW - RETURN_AFTER - 1;
  const d = strataBackendDecision({ ...hipBase(), idleSinceMs, cudaFailedAt: NOW - RETURN_AFTER + 1 });
  expectDecision(d, 'stay', idleSinceMs);
});

test('HIP rule 5: a CUDA failure exactly returnAfterMs ago no longer blocks', () => {
  const d = strataBackendDecision({ ...hipBase(), cudaFailedAt: NOW - RETURN_AFTER });
  expectDecision(d, 'return-to-cuda', NOW - RETURN_AFTER - 1);
});

test('HIP rule 6: idle for less than returnAfterMs stays', () => {
  const idleSinceMs = NOW - RETURN_AFTER + 1;
  expectDecision(strataBackendDecision({ ...hipBase(), idleSinceMs }), 'stay', idleSinceMs);
});

test('HIP rule 6: idle for exactly returnAfterMs returns to CUDA', () => {
  const idleSinceMs = NOW - RETURN_AFTER;
  expectDecision(strataBackendDecision({ ...hipBase(), idleSinceMs }), 'return-to-cuda', idleSinceMs);
});

test('HIP rule 7: busy blocks the return but keeps the idle clock', () => {
  const idleSinceMs = NOW - RETURN_AFTER - 1;
  expectDecision(strataBackendDecision({ ...hipBase(), idleSinceMs, busy: true }), 'stay', idleSinceMs);
});

test('HIP rule 8: idle long enough, not busy, no failure returns to CUDA', () => {
  const idleSinceMs = NOW - RETURN_AFTER - 1;
  expectDecision(strataBackendDecision({ ...hipBase(), idleSinceMs }), 'return-to-cuda', idleSinceMs);
});

test('HIP rules apply in order: not-configured beats a blocking claim, blocking beats not-idle', () => {
  expectDecision(strataBackendDecision({ ...hipBase(), cudaConfigured: false, blocking: true }), 'stay', null);
  expectDecision(strataBackendDecision({ ...hipBase(), blocking: true, otherVramBytes: 9999 }), 'stay', null);
});

// ---- cudaAdmission ----
const admitBase = () => ({
  cudaConfigured: true, blocking: false, otherVramBytes: 0, baselineBytes: 100,
  growthBytes: 50, cudaFailedAt: null, now: NOW, returnAfterMs: RETURN_AFTER,
});

function expectAdmission(a, admit) {
  assert.equal(a.admit, admit);
  assert.equal(typeof a.reason, 'string');
  assert.ok(a.reason.length > 0);
}

test('cudaAdmission admits immediately when idle (no hysteresis)', () => {
  expectAdmission(cudaAdmission(admitBase()), true);
});

test('cudaAdmission rule 1: CUDA not configured refuses', () => {
  expectAdmission(cudaAdmission({ ...admitBase(), cudaConfigured: false }), false);
});

test('cudaAdmission rule 2: a blocking claim refuses', () => {
  expectAdmission(cudaAdmission({ ...admitBase(), blocking: true }), false);
});

test('cudaAdmission rule 3: busy or blind CUDA refuses', () => {
  expectAdmission(cudaAdmission({ ...admitBase(), otherVramBytes: 151 }), false);
  expectAdmission(cudaAdmission({ ...admitBase(), otherVramBytes: null }), false);
});

test('cudaAdmission rule 5: a recent CUDA failure refuses, an old one admits', () => {
  expectAdmission(cudaAdmission({ ...admitBase(), cudaFailedAt: NOW - RETURN_AFTER + 1 }), false);
  expectAdmission(cudaAdmission({ ...admitBase(), cudaFailedAt: NOW - RETURN_AFTER }), true);
});
