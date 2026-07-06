// Llama Manager — unit tests for api/mem-watchdog.js (restart deferral policy).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldDeferMemRestart } from './mem-watchdog.js';

const NOW = 1_000_000;

test('defers when a request is actively progressing below the hard ceiling', () => {
  const r = shouldDeferMemRestart({
    memPercent: 91,
    thresholdPct: 90,
    activeEntries: [{ lastActivityAt: NOW - 5_000 }],
    nowMs: NOW,
  });
  assert.equal(r.defer, true);
  assert.equal(r.progressing, 1);
  assert.equal(r.hardCeilingPct, 96);
});

test('does not defer when no requests are active', () => {
  const r = shouldDeferMemRestart({
    memPercent: 91,
    thresholdPct: 90,
    activeEntries: [],
    nowMs: NOW,
  });
  assert.equal(r.defer, false);
  assert.equal(r.progressing, 0);
});

test('does not defer when token-emitting requests go idle past the window', () => {
  const r = shouldDeferMemRestart({
    memPercent: 91,
    thresholdPct: 90,
    activeEntries: [
      { lastActivityAt: NOW - 31_000, startTime: NOW - 700_000, tokens: 12 },
      { startTime: NOW - 700_000, tokens: 40 },
    ],
    nowMs: NOW,
  });
  assert.equal(r.defer, false);
});

test('defers for a zero-token request within the prompt-processing grace', () => {
  // 57s into prompt processing of a 27k-token context: no tokens emitted yet,
  // lastActivityAt stale — the exact case that killed session J_h_Br50.
  const r = shouldDeferMemRestart({
    memPercent: 92.5,
    thresholdPct: 90,
    activeEntries: [{ startTime: NOW - 57_000, lastActivityAt: NOW - 57_000, tokens: 0 }],
    nowMs: NOW,
  });
  assert.equal(r.defer, true);
  assert.equal(r.progressing, 1);
});

test('does not defer for a zero-token request older than the prompt grace', () => {
  const r = shouldDeferMemRestart({
    memPercent: 92.5,
    thresholdPct: 90,
    activeEntries: [{ startTime: NOW - 601_000, lastActivityAt: NOW - 601_000, tokens: 0 }],
    nowMs: NOW,
  });
  assert.equal(r.defer, false);
});

test('restarts anyway at or above the hard ceiling even while progressing', () => {
  const r = shouldDeferMemRestart({
    memPercent: 96,
    thresholdPct: 90,
    activeEntries: [{ lastActivityAt: NOW - 1_000 }],
    nowMs: NOW,
  });
  assert.equal(r.defer, false);
  assert.equal(r.progressing, 1);
});

test('hard ceiling is capped at 98%', () => {
  const r = shouldDeferMemRestart({
    memPercent: 97,
    thresholdPct: 95,
    activeEntries: [{ lastActivityAt: NOW }],
    nowMs: NOW,
  });
  assert.equal(r.hardCeilingPct, 98);
  assert.equal(r.defer, true);
});

test('ignores watchdog-killed entries', () => {
  const r = shouldDeferMemRestart({
    memPercent: 91,
    thresholdPct: 90,
    activeEntries: [{ lastActivityAt: NOW, _watchdogKilled: true }],
    nowMs: NOW,
  });
  assert.equal(r.defer, false);
  assert.equal(r.progressing, 0);
});

test('falls back to startTime when lastActivityAt is missing', () => {
  const r = shouldDeferMemRestart({
    memPercent: 91,
    thresholdPct: 90,
    activeEntries: [{ startTime: NOW - 2_000 }],
    nowMs: NOW,
  });
  assert.equal(r.defer, true);
});
