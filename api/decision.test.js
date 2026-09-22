// Llama Manager — unit tests for api/decision.js (System 1 decision engine policy).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISION_DEFAULTS, DECISION_CONTAINER_NAME, resolveDecisionConfig, isPinnedImage,
  podmanRunArgs, isDecisionModel, pickDecisionPatch, resolveForwardModel,
} from './decision.js';

const DIGEST = 'a'.repeat(64);
const PINNED = `ghcr.io/yolanother/laya-server@sha256:${DIGEST}`;

test('resolveDecisionConfig: ships disabled on port 5254 with the typed-decisions checkpoint', () => {
  const c = resolveDecisionConfig({}, {});
  assert.equal(c.enabled, false);
  assert.equal(c.port, 5254);
  assert.equal(c.checkpoint, 'typed-decisions');
  assert.equal(c.idleTimeoutSec, 600);
  assert.equal(c.runnable, false);
  assert.equal(c.reason, 'disabled in config');
  // DEVIATION (W6-T1, 2026-09-22): W6-T1a (image build) had not yet recorded a
  // digest-pinned image id at the time this task landed, so DEFAULT_DECISION_IMAGE
  // ships as '' and the canary below asserts the un-pinned state instead of a
  // pinned one. The coordinator fills DEFAULT_DECISION_IMAGE in api/decision.js
  // once T1a records `sha256:<64 hex>`; flip this assertion back to
  // `assert.ok(isPinnedImage(...))` at that point.
  assert.equal(isPinnedImage(DECISION_DEFAULTS.image), false, 'DEFAULT_DECISION_IMAGE is still unfilled (T1a pending)');
});

test('resolveDecisionConfig: enabling with the still-unpinned default image refuses to run', () => {
  // Documents the unpinned-refusal path this task's DEFAULT_DECISION_IMAGE=='' takes
  // until W6-T1a records the built image id.
  const c = resolveDecisionConfig({ decision: { enabled: true } }, {});
  assert.equal(c.runnable, false);
  assert.equal(c.reason, 'image is not pinned by digest');
});

test('resolveDecisionConfig: config block is honoured and env overrides enabled/port', () => {
  const c = resolveDecisionConfig({ decision: { enabled: true, image: PINNED, port: 6000 } }, { DECISION_PORT: '6100' });
  assert.equal(c.enabled, true);
  assert.equal(c.port, 6100);
  assert.equal(c.runnable, true);
  assert.equal(c.reason, null);
  assert.equal(resolveDecisionConfig({ decision: { enabled: true, image: PINNED } }, { DECISION_ENABLED: 'false' }).enabled, false);
});

test('resolveDecisionConfig: refuses an image that is not pinned by digest', () => {
  const c = resolveDecisionConfig({ decision: { enabled: true, image: 'ghcr.io/x/laya-server:latest' } }, {});
  assert.equal(c.runnable, false);
  assert.equal(c.reason, 'image is not pinned by digest');
});

test('resolveDecisionConfig: refuses an unknown checkpoint', () => {
  const c = resolveDecisionConfig({ decision: { enabled: true, image: PINNED, checkpoint: 'huge' } }, {});
  assert.equal(c.runnable, false);
  assert.match(c.reason, /unknown checkpoint/);
});

test('isPinnedImage: accepts repo digests and full image ids only', () => {
  assert.equal(isPinnedImage(PINNED), true);
  assert.equal(isPinnedImage(`sha256:${DIGEST}`), true);
  assert.equal(isPinnedImage('laya-server:rocm'), false);
  assert.equal(isPinnedImage(`x@sha256:${DIGEST.slice(1)}`), false);
  assert.equal(isPinnedImage(undefined), false);
});

test('podmanRunArgs: loopback port map, keep-id cache mount, checkpoint env, gpu args, image last', () => {
  const cfg = resolveDecisionConfig({ decision: { enabled: true, image: PINNED, device: 'cuda:0',
    podmanArgs: ['--device', '/dev/kfd'] } }, {});
  const args = podmanRunArgs(cfg, { cacheDir: '/var/lib/llama-manager/decision' });
  assert.deepEqual(args.slice(0, 5), ['run', '--rm', '--pull=missing', '--name', DECISION_CONTAINER_NAME]);
  assert.ok(args.includes('--userns=keep-id:uid=1000,gid=1000'));
  assert.equal(args[args.indexOf('-p') + 1], '127.0.0.1:5254:8765');
  assert.equal(args[args.indexOf('-v') + 1], '/var/lib/llama-manager/decision:/data');
  assert.ok(args.includes('LAYA_SERVER_MODELS=typed-decisions'));
  assert.ok(args.includes('LAYA_SERVER_JEV_ALIAS=1'));
  assert.ok(args.includes('LAYA_SERVER_DEVICE=cuda:0'));
  assert.ok(args.includes('/dev/kfd'));
  assert.equal(args.at(-1), PINNED);
});

test('podmanRunArgs: default GPU args include the gfx1151 device set and HSA override', () => {
  const cfg = resolveDecisionConfig({ decision: { enabled: true, image: PINNED } }, {});
  const args = podmanRunArgs(cfg, { cacheDir: '/var/lib/llama-manager/decision' });
  assert.ok(args.includes('/dev/kfd'));
  assert.ok(args.includes('/dev/dri'));
  assert.ok(args.includes('keep-groups'));
  assert.ok(args.includes('seccomp=unconfined'));
  assert.ok(args.includes('HSA_OVERRIDE_GFX_VERSION=11.5.1'));
});

test('isDecisionModel: laya, laya-*, jev-* and omitted are accepted; chat models are not', () => {
  for (const m of [undefined, '', 'laya', 'laya-typed-decisions', 'jev-latest', 'jev-1.13.0']) assert.equal(isDecisionModel(m), true, String(m));
  for (const m of ['gpt-oss-120b', 'default-big', 'layabout', 'JEV-latest']) assert.equal(isDecisionModel(m), false, m);
});

test('pickDecisionPatch: keeps only decision config keys', () => {
  assert.deepEqual(pickDecisionPatch({ enabled: true, port: 5254, rm: '-rf', __proto__x: 1 }), { enabled: true, port: 5254 });
  assert.deepEqual(pickDecisionPatch(null), {});
});

// A6: llama-manager rewrites `model` to the loaded checkpoint for laya, laya-*
// (unless it already names the loaded checkpoint) and jev-*, since laya-server
// 422s `laya` against an unloaded `laya-english` alias.
test('resolveForwardModel: A6 rewrites laya/jev-* to the loaded checkpoint', () => {
  const cfg = { checkpoint: 'typed-decisions' };
  assert.equal(resolveForwardModel('laya', cfg), 'laya-typed-decisions');
  assert.equal(resolveForwardModel('jev-latest', cfg), 'laya-typed-decisions');
  assert.equal(resolveForwardModel('jev-1.13.0', cfg), 'laya-typed-decisions');
});

test('resolveForwardModel: A6 leaves a model already naming the loaded checkpoint untouched', () => {
  assert.equal(resolveForwardModel('laya-typed-decisions', { checkpoint: 'typed-decisions' }), 'laya-typed-decisions');
  assert.equal(resolveForwardModel('laya-multilingual', { checkpoint: 'multilingual' }), 'laya-multilingual');
});

test('resolveForwardModel: A6 rewrites a laya-<other checkpoint> name that is not loaded', () => {
  assert.equal(resolveForwardModel('laya-multilingual', { checkpoint: 'typed-decisions' }), 'laya-typed-decisions');
});

test('resolveForwardModel: an omitted model passes through unchanged', () => {
  assert.equal(resolveForwardModel(undefined, { checkpoint: 'typed-decisions' }), undefined);
  assert.equal(resolveForwardModel('', { checkpoint: 'typed-decisions' }), '');
});
