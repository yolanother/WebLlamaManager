// Llama Manager — unit tests for the exclusive-DS4-mode decision helpers.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Verifies the pure pre-eviction budget + offload-routing logic in ds4-exclusive.js
// without booting the server or the 81GB ds4 model: model-name matching, the routing
// table (ds4 model → local, other → remote, unknown → 503), the reclaim-target budget,
// the injectable-clock reclaim poll loop (success / timeout / immediate), the embed-server
// residency budget, and the 503 error body shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DS4_EXCLUSIVE_ERROR,
  ds4ModelMatches,
  ds4RequestTarget,
  reclaimTargetBytes,
  reclaimSatisfied,
  pollForReclaim,
  shouldKeepEmbedServer,
  ds4Exclusive503Body,
} from './ds4-exclusive.js';

const GB = 1024 * 1024 * 1024;

// ── ds4ModelMatches ──────────────────────────────────────────────────────────
test('ds4ModelMatches: exact and normalized matches', () => {
  assert.equal(ds4ModelMatches('deepseek-v4-flash', ['deepseek-v4-flash']), true);
  assert.equal(ds4ModelMatches('DeepSeek V4 Flash', ['deepseek-v4-flash']), true); // punctuation/case
  assert.equal(ds4ModelMatches('ds4-preset', ['ds4-preset', 'deepseek']), true);
});

test('ds4ModelMatches: substring relationship both directions', () => {
  assert.equal(ds4ModelMatches('deepseek', ['deepseek-v4-flash']), true); // request ⊂ id
  assert.equal(ds4ModelMatches('deepseek-v4-flash-q2', ['deepseek-v4-flash']), true); // id ⊂ request
});

test('ds4ModelMatches: non-matches and empty', () => {
  assert.equal(ds4ModelMatches('gpt-oss-120b', ['deepseek-v4-flash']), false);
  assert.equal(ds4ModelMatches('', ['deepseek-v4-flash']), false);
  assert.equal(ds4ModelMatches('deepseek', []), false);
});

// ── ds4RequestTarget (routing table) ─────────────────────────────────────────
test('ds4RequestTarget: ds4 model routes local', () => {
  const d = ds4RequestTarget({ requestedModel: 'deepseek-v4-flash', ds4ModelIds: ['deepseek-v4-flash'], hasViableRemote: false });
  assert.equal(d.target, 'local-ds4');
});

test('ds4RequestTarget: other model with viable remote offloads', () => {
  const d = ds4RequestTarget({ requestedModel: 'gpt-oss-120b', ds4ModelIds: ['deepseek-v4-flash'], hasViableRemote: true });
  assert.equal(d.target, 'remote');
});

test('ds4RequestTarget: other model with no remote is rejected (503)', () => {
  const d = ds4RequestTarget({ requestedModel: 'gpt-oss-120b', ds4ModelIds: ['deepseek-v4-flash'], hasViableRemote: false });
  assert.equal(d.target, 'reject');
  assert.equal(d.reason, 'exclusive-ds4-no-backend');
});

test('ds4RequestTarget: ds4 model wins even when a remote also exists', () => {
  const d = ds4RequestTarget({ requestedModel: 'deepseek-v4-flash', ds4ModelIds: ['deepseek-v4-flash'], hasViableRemote: true });
  assert.equal(d.target, 'local-ds4');
});

// ── reclaimTargetBytes / reclaimSatisfied ────────────────────────────────────
test('reclaimTargetBytes: model + headroom', () => {
  assert.equal(reclaimTargetBytes({ ds4ModelBytes: 81 * GB, headroomBytes: 8 * GB }), 89 * GB);
  assert.equal(reclaimTargetBytes({}), 0);
});

test('reclaimSatisfied: at/over target passes, under fails', () => {
  assert.equal(reclaimSatisfied({ memAvailableBytes: 90 * GB, targetBytes: 89 * GB }), true);
  assert.equal(reclaimSatisfied({ memAvailableBytes: 89 * GB, targetBytes: 89 * GB }), true);
  assert.equal(reclaimSatisfied({ memAvailableBytes: 60 * GB, targetBytes: 89 * GB }), false);
});

// ── pollForReclaim (injectable clock) ────────────────────────────────────────
test('pollForReclaim: succeeds once memory is reclaimed', async () => {
  // MemAvailable climbs as pages are freed: 40 → 70 → 90 GB.
  const readings = [40 * GB, 70 * GB, 90 * GB];
  let i = 0;
  let clock = 0;
  const res = await pollForReclaim({
    readMemAvailable: () => readings[Math.min(i++, readings.length - 1)],
    targetBytes: 89 * GB,
    timeoutMs: 60_000,
    intervalMs: 1000,
    sleep: async () => { clock += 1000; },
    now: () => clock,
  });
  assert.equal(res.ok, true);
  assert.equal(res.memAvailableBytes, 90 * GB);
  assert.equal(res.polls, 3);
});

test('pollForReclaim: immediate success (already enough free)', async () => {
  const res = await pollForReclaim({
    readMemAvailable: () => 100 * GB,
    targetBytes: 89 * GB,
    timeoutMs: 60_000,
    intervalMs: 1000,
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(res.ok, true);
  assert.equal(res.polls, 1);
});

test('pollForReclaim: times out when memory never reclaims (never spawns ds4)', async () => {
  let clock = 0;
  const res = await pollForReclaim({
    readMemAvailable: () => 40 * GB, // stuck — nothing ever frees
    targetBytes: 89 * GB,
    timeoutMs: 5000,
    intervalMs: 1000,
    sleep: async () => { clock += 1000; },
    now: () => clock,
  });
  assert.equal(res.ok, false);
  assert.equal(res.memAvailableBytes, 40 * GB);
  assert.ok(res.waitedMs >= 5000);
});

// ── shouldKeepEmbedServer ────────────────────────────────────────────────────
test('shouldKeepEmbedServer: off when flag disabled', () => {
  assert.equal(shouldKeepEmbedServer({ allowEmbedServer: false, ds4ModelBytes: 81 * GB, embedServerBytes: 5 * GB, totalBytes: 124 * GB, headroomBytes: 8 * GB }), false);
});

test('shouldKeepEmbedServer: kept when it fits the budget', () => {
  assert.equal(shouldKeepEmbedServer({ allowEmbedServer: true, ds4ModelBytes: 81 * GB, embedServerBytes: 5 * GB, totalBytes: 124 * GB, headroomBytes: 8 * GB }), true);
});

test('shouldKeepEmbedServer: evicted when it would blow the budget', () => {
  assert.equal(shouldKeepEmbedServer({ allowEmbedServer: true, ds4ModelBytes: 115 * GB, embedServerBytes: 5 * GB, totalBytes: 124 * GB, headroomBytes: 8 * GB }), false);
});

test('shouldKeepEmbedServer: unknown total honors the flag', () => {
  assert.equal(shouldKeepEmbedServer({ allowEmbedServer: true, ds4ModelBytes: 81 * GB, embedServerBytes: 5 * GB, totalBytes: 0, headroomBytes: 8 * GB }), true);
});

// ── ds4Exclusive503Body ──────────────────────────────────────────────────────
test('ds4Exclusive503Body: OpenAI-style error naming both models', () => {
  const b = ds4Exclusive503Body('gpt-oss-120b', 'deepseek-v4-flash');
  assert.equal(b.error.type, DS4_EXCLUSIVE_ERROR);
  assert.equal(b.error.code, DS4_EXCLUSIVE_ERROR);
  assert.equal(b.error.param, 'model');
  assert.match(b.error.message, /gpt-oss-120b/);
  assert.match(b.error.message, /deepseek-v4-flash/);
  assert.match(b.error.message, /exclusive DS4 mode/i);
});
