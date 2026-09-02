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
  ds4ActivationDecision,
} from './ds4-exclusive.js';

const GB = 1024 * 1024 * 1024;

// ── ds4ModelMatches ──────────────────────────────────────────────────────────
test('ds4RequestTarget: a co-resident llama serves non-ds4 models locally', () => {
  // When DS4 stays resident because a small model fits beside it, that small
  // model has to actually be served. Without this branch the request falls
  // through to remote-or-503 — so keeping DS4 would have been WORSE than
  // evicting it, which is why the fit gate and this target ship together.
  const r = ds4RequestTarget({
    requestedModel: 'Qwen3-8B-Q4_K_M', ds4ModelIds: ['DeepSeek-V4-Flash.gguf'],
    hasViableRemote: false, llamaRunning: true,
  });
  assert.equal(r.target, 'local-llama');
});

test('ds4RequestTarget: the ds4 model still wins even when llama is co-resident', () => {
  const r = ds4RequestTarget({
    requestedModel: 'DeepSeek-V4-Flash.gguf', ds4ModelIds: ['DeepSeek-V4-Flash.gguf'],
    llamaRunning: true,
  });
  assert.equal(r.target, 'local-ds4');
});

test('ds4RequestTarget: unchanged when nothing is co-resident', () => {
  // The exclusive-mode behaviour must be exactly as before for hosts with no
  // headroom: offload if a remote can serve, otherwise refuse rather than queue.
  assert.equal(ds4RequestTarget({ requestedModel: 'other', ds4ModelIds: ['d.gguf'], hasViableRemote: true }).target, 'remote');
  assert.equal(ds4RequestTarget({ requestedModel: 'other', ds4ModelIds: ['d.gguf'], hasViableRemote: false }).target, 'reject');
});

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

// ── ds4ActivationDecision ─────────────────────────────────────────────────────
// The rollback rule that fixes the live activation race: once committed to ds4,
// a kill/reclaim hiccup must NEVER roll the box back to llama-router (which would
// re-admit a competing local model load during the ds4 load window). Only a genuine
// ds4-spawn failure — AFTER eviction truly succeeded — rolls back, and it stops the
// half-started ds4 before restoring llama so the two engines never co-reside.
test('ds4ActivationDecision: llama still resident after robust kill → abort but STAY exclusive (no llama resume)', () => {
  const d = ds4ActivationDecision({ residentAfterEvict: true, reclaimOk: false, spawnOk: undefined });
  assert.equal(d.action, 'abort-stay-exclusive');
  assert.equal(d.engine, 'ds4');   // engine stays ds4 — flood offloads, no local reload
  assert.equal(d.spawn, false);    // never spawn ds4 on top of a wedged llama
  assert.equal(d.stopDs4, false);  // nothing to stop; ds4 never started
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'llama-wedged-resident');
});

test('ds4ActivationDecision: reclaim timeout (no resident, RAM never freed) → abort but STAY exclusive', () => {
  const d = ds4ActivationDecision({ residentAfterEvict: false, reclaimOk: false, spawnOk: undefined });
  assert.equal(d.action, 'abort-stay-exclusive');
  assert.equal(d.engine, 'ds4');
  assert.equal(d.spawn, false);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'reclaim-timeout');
});

test('ds4ActivationDecision: eviction succeeded but ds4 spawn failed → rollback to llama, stopping ds4 first', () => {
  const d = ds4ActivationDecision({ residentAfterEvict: false, reclaimOk: true, spawnOk: false });
  assert.equal(d.action, 'rollback-to-llama');
  assert.equal(d.engine, 'llama'); // only here do we resume llama — RAM is free, no race
  assert.equal(d.spawn, false);
  assert.equal(d.stopDs4, true);   // fully stop the half-started ds4 BEFORE restoring llama
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'ds4-spawn-failed');
});

test('ds4ActivationDecision: eviction succeeded and ds4 spawned → proceed exclusive', () => {
  const d = ds4ActivationDecision({ residentAfterEvict: false, reclaimOk: true, spawnOk: true });
  assert.equal(d.action, 'spawn');
  assert.equal(d.engine, 'ds4');
  assert.equal(d.spawn, true);
  assert.equal(d.stopDs4, false);
  assert.equal(d.ok, true);
  assert.equal(d.reason, 'ok');
});

test('ds4ActivationDecision: resident wins over spawnOk (never spawn on a wedged llama)', () => {
  // Even if a spawn probe were optimistic, a resident llama forces abort-stay-exclusive.
  const d = ds4ActivationDecision({ residentAfterEvict: true, reclaimOk: true, spawnOk: true });
  assert.equal(d.action, 'abort-stay-exclusive');
  assert.equal(d.engine, 'ds4');
  assert.equal(d.spawn, false);
});

// ── ds4RequestTarget during the ds4 load window ───────────────────────────────
// While ds4 is loading (currentEngine=ds4, gate held), a NON-ds4 request must never
// resolve to a local llama load — it offloads to a remote or is rejected. This is
// what keeps a competing 60GB llama model off the box during the ~1-2 min ds4 load.
test('ds4RequestTarget: non-ds4 request during load window never targets local llama', () => {
  const ds4Ids = ['deepseek-v4-flash'];
  // With a viable remote → offload.
  assert.equal(ds4RequestTarget({ requestedModel: 'gpt-oss-120b', ds4ModelIds: ds4Ids, hasViableRemote: true }).target, 'remote');
  // Without a viable remote → reject (never load locally).
  const rej = ds4RequestTarget({ requestedModel: 'gpt-oss-120b', ds4ModelIds: ds4Ids, hasViableRemote: false });
  assert.equal(rej.target, 'reject');
  // The only local target this function can EVER return is the ds4 engine itself.
  const local = ds4RequestTarget({ requestedModel: 'deepseek-v4-flash', ds4ModelIds: ds4Ids, hasViableRemote: false });
  assert.equal(local.target, 'local-ds4');
});
