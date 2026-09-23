// Llama Manager — unit tests for api/decision.js (System 1 decision engine policy).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISION_DEFAULTS, DECISION_CONTAINER_NAME, resolveDecisionConfig, isPinnedImage,
  podmanRunArgs, isDecisionModel, pickDecisionPatch, resolveForwardModel, resolvePeers, planDecisionRoute, peerOffersDecision, advertisedEngines,
  publicDecisionConfig,
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
  // The default image is the id of the Frostburn-built laya-server archive shipped
  // by the llama-manager-laya-rocm deb (W6-T1a).
  assert.ok(isPinnedImage(DECISION_DEFAULTS.image), 'DEFAULT_DECISION_IMAGE must be a pinned image id');
  assert.equal(DECISION_DEFAULTS.image, 'sha256:3b6dd0d5cb3cfd4b72176f6973d4079c85052156c112658154f8d53365864769');
});

test('resolveDecisionConfig: enabling with the default image is runnable', () => {
  const c = resolveDecisionConfig({ decision: { enabled: true } }, {});
  assert.equal(c.runnable, true);
});

test('resolveDecisionConfig: an unpinned image override refuses to run', () => {
  const c = resolveDecisionConfig({ decision: { enabled: true, image: 'laya-server:latest' } }, {});
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

// The llama-manager-laya-rocm deb sets DECISION_DEFAULT_ENABLED=true through its
// service drop-in, so a freshly reimaged appliance serves Laya with no config
// call; an explicit config.decision.enabled (the operator's switch) still wins.
test('resolveDecisionConfig: DECISION_DEFAULT_ENABLED enables only when config is silent', () => {
  const on = { DECISION_DEFAULT_ENABLED: 'true' };
  assert.equal(resolveDecisionConfig({}, on).enabled, true);
  assert.equal(resolveDecisionConfig({}, on).runnable, true);
  assert.equal(resolveDecisionConfig({ decision: { enabled: false } }, on).enabled, false);
  assert.equal(resolveDecisionConfig({ decision: { enabled: true } }, { DECISION_DEFAULT_ENABLED: 'false' }).enabled, true);
  assert.equal(resolveDecisionConfig({ decision: { port: 6000 } }, on).enabled, true);
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

// W6-F1: selectable GPUs + a CUDA variant. Defaults stay ROCm-only so every
// test above (written before variants existed) keeps passing unmodified.
test('resolveDecisionConfig: defaults to the rocm variant, no GPU selection, empty imageCuda', () => {
  const c = resolveDecisionConfig({}, {});
  assert.equal(c.variant, 'rocm');
  assert.deepEqual(c.gpus, []);
  assert.equal(c.imageRocm, DECISION_DEFAULTS.image);
  assert.equal(c.imageCuda, '');
});

test('resolveDecisionConfig: an unknown variant value falls back to rocm', () => {
  assert.equal(resolveDecisionConfig({ decision: { variant: 'nvidia' } }, {}).variant, 'rocm');
});

test('resolveDecisionConfig: the legacy `image` key still selects the rocm image, and imageRocm wins if both are set', () => {
  const a = resolveDecisionConfig({ decision: { enabled: true, image: PINNED } }, {});
  assert.equal(a.imageRocm, PINNED);
  assert.equal(a.image, PINNED);
  assert.equal(a.runnable, true);
  const OTHER = `ghcr.io/x/y@sha256:${'b'.repeat(64)}`;
  const b = resolveDecisionConfig({ decision: { enabled: true, image: PINNED, imageRocm: OTHER } }, {});
  assert.equal(b.imageRocm, OTHER);
  assert.equal(b.image, OTHER);
});

test('resolveDecisionConfig: a cuda variant with no imageCuda is refused with a specific reason', () => {
  const c = resolveDecisionConfig({ decision: { enabled: true, variant: 'cuda' } }, {});
  assert.equal(c.runnable, false);
  assert.equal(c.reason, 'no pinned CUDA image');
});

test('resolveDecisionConfig: a cuda variant with an unpinned imageCuda is refused', () => {
  const c = resolveDecisionConfig({ decision: { enabled: true, variant: 'cuda', imageCuda: 'laya-server:cuda' } }, {});
  assert.equal(c.runnable, false);
  assert.equal(c.reason, 'image is not pinned by digest');
});

test('resolveDecisionConfig: a cuda variant with a pinned imageCuda is runnable and resolves image to it', () => {
  const c = resolveDecisionConfig({ decision: { enabled: true, variant: 'cuda', imageCuda: PINNED } }, {});
  assert.equal(c.runnable, true);
  assert.equal(c.reason, null);
  assert.equal(c.image, PINNED);
});

test('podmanRunArgs: rocm variant with selected gpus adds HIP_VISIBLE_DEVICES on top of the default device set', () => {
  const cfg = resolveDecisionConfig({ decision: { enabled: true, image: PINNED, gpus: ['0', '1'] } }, {});
  const args = podmanRunArgs(cfg, { cacheDir: '/data' });
  assert.ok(args.includes('/dev/kfd'), 'default rocm device args stay unless overridden');
  assert.ok(args.includes('HIP_VISIBLE_DEVICES=0,1'));
  assert.ok(!args.some((a) => String(a).startsWith('nvidia.com/gpu=')));
});

test('podmanRunArgs: rocm variant with no gpus selected adds no GPU-selection env', () => {
  const cfg = resolveDecisionConfig({ decision: { enabled: true, image: PINNED } }, {});
  const args = podmanRunArgs(cfg, { cacheDir: '/data' });
  assert.ok(!args.some((a) => String(a).startsWith('HIP_VISIBLE_DEVICES')));
});

test('podmanRunArgs: cuda variant drops the rocm device/HSA defaults and adds CDI device flags per gpu', () => {
  const cfg = resolveDecisionConfig({ decision: { enabled: true, variant: 'cuda', imageCuda: PINNED, gpus: ['0', '1'] } }, {});
  const args = podmanRunArgs(cfg, { cacheDir: '/data' });
  assert.ok(!args.includes('/dev/kfd'));
  assert.ok(!args.includes('HSA_OVERRIDE_GFX_VERSION=11.5.1'));
  assert.deepEqual(args.filter((a) => String(a).startsWith('nvidia.com/gpu=')), ['nvidia.com/gpu=0', 'nvidia.com/gpu=1']);
  assert.equal(args.at(-1), PINNED);
});

test('podmanRunArgs: cuda variant with no gpus selected requests all CDI devices', () => {
  const cfg = resolveDecisionConfig({ decision: { enabled: true, variant: 'cuda', imageCuda: PINNED } }, {});
  const args = podmanRunArgs(cfg, { cacheDir: '/data' });
  assert.deepEqual(args.filter((a) => String(a).startsWith('nvidia.com/gpu=')), ['nvidia.com/gpu=all']);
});

test('podmanRunArgs: an explicit podmanArgs override is still appended for either variant', () => {
  const cfg = resolveDecisionConfig({ decision: { enabled: true, variant: 'cuda', imageCuda: PINNED, podmanArgs: ['--foo'] } }, {});
  const args = podmanRunArgs(cfg, { cacheDir: '/data' });
  assert.ok(args.includes('--foo'));
});

test('isPinnedImage: accepts repo digests and full image ids only', () => {
  assert.equal(isPinnedImage(PINNED), true);
  assert.equal(isPinnedImage(`sha256:${DIGEST}`), true);
  assert.equal(isPinnedImage('laya-server:rocm'), false);
  assert.equal(isPinnedImage(`x@sha256:${DIGEST.slice(1)}`), false);
  assert.equal(isPinnedImage(undefined), false);
});

test('podmanRunArgs: host pid/net bound to loopback, keep-id cache mount, checkpoint env, gpu args, image last', () => {
  const cfg = resolveDecisionConfig({ decision: { enabled: true, image: PINNED, device: 'cuda:0',
    podmanArgs: ['--device', '/dev/kfd'] } }, {});
  const args = podmanRunArgs(cfg, { cacheDir: '/var/lib/llama-manager/decision' });
  assert.deepEqual(args.slice(0, 5), ['run', '--rm', '--pull=missing', '--name', DECISION_CONTAINER_NAME]);
  assert.ok(args.includes('--userns=keep-id:uid=1000,gid=1000'));
  // The appliance's rootless podman cannot give a container its own proc/net
  // namespace (crun: "mount proc ... Operation not permitted" and
  // "ping_group_range: Read-only file system"), the same reason the ROCm
  // distrobox runs host pid/net. So share them and have laya-server bind loopback.
  assert.ok(args.includes('--pid=host'));
  assert.ok(args.includes('--network=host'));
  assert.ok(!args.includes('-p'), 'host networking cannot publish ports');
  assert.ok(args.includes('LAYA_SERVER_HOST=127.0.0.1'));
  assert.ok(args.includes('LAYA_SERVER_PORT=5254'));
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

test('pickDecisionPatch: accepts the new variant/gpus/per-variant-image keys', () => {
  assert.deepEqual(
    pickDecisionPatch({ variant: 'cuda', gpus: ['0'], imageRocm: 'a', imageCuda: 'b', rm: '-rf' }),
    { variant: 'cuda', gpus: ['0'], imageRocm: 'a', imageCuda: 'b' },
  );
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

// W6-T3: laya alias routing — configured peers (ordered) → local → none.
const LOCAL_OK = { runnable: true, running: false, availableBytes: 64 * 1024 ** 3, minFreeMemBytes: 4 * 1024 ** 3 };

test('resolvePeers: static urls kept in order, names resolved against the fleet, duplicates dropped', () => {
  const fleet = [{ name: 'drakemore', url: 'http://192.168.1.79:3001' }, { name: 'other', url: 'http://10.0.0.2:3001' }];
  assert.deepEqual(resolvePeers([{ name: 'drakemore' }, { name: 'static', url: 'http://h:1/' }, { name: 'ghost' }, { name: 'drakemore' }], fleet), [
    { name: 'drakemore', url: 'http://192.168.1.79:3001' },
    { name: 'static', url: 'http://h:1' },
  ]);
});

test('planDecisionRoute: healthy peer first, then local', () => {
  const peers = [{ name: 'drakemore', url: 'http://d:3001' }];
  assert.deepEqual(planDecisionRoute({ peers, peerAvailable: () => true, local: LOCAL_OK }),
    [{ kind: 'peer', name: 'drakemore', url: 'http://d:3001' }, { kind: 'local' }]);
});

test('planDecisionRoute: unhealthy peer skipped; low memory drops local; nothing → empty', () => {
  const peers = [{ name: 'drakemore', url: 'http://d:3001' }];
  assert.deepEqual(planDecisionRoute({ peers, peerAvailable: () => false, local: LOCAL_OK }), [{ kind: 'local' }]);
  assert.deepEqual(planDecisionRoute({ peers, peerAvailable: () => false, local: { ...LOCAL_OK, availableBytes: 1 } }), []);
  assert.deepEqual(planDecisionRoute({ peers, peerAvailable: () => false, local: { ...LOCAL_OK, availableBytes: 1, running: true } }), [{ kind: 'local' }]);
});

test('planDecisionRoute: a forwarded request never goes back out to peers', () => {
  const peers = [{ name: 'frostburn', url: 'http://f:5250' }];
  assert.deepEqual(planDecisionRoute({ peers, forwarded: true, peerAvailable: () => true, local: LOCAL_OK }), [{ kind: 'local' }]);
});

test('peerOffersDecision: reads the system_one token from the advertised engines TXT', () => {
  assert.equal(peerOffersDecision({ txt: { engines: 'llama,ds4,system_one' } }), true);
  assert.equal(peerOffersDecision({ txt: { engines: 'llama' } }), false);
  assert.equal(peerOffersDecision({}), false);
});

test('advertisedEngines: appends system_one only when the engine is runnable', () => {
  const on = resolveDecisionConfig({ decision: { enabled: true, image: PINNED } }, {});
  assert.deepEqual(advertisedEngines(['llama', 'ds4'], on), ['llama', 'ds4', 'system_one']);
  assert.deepEqual(advertisedEngines(['llama'], resolveDecisionConfig({}, {})), ['llama']);
  assert.deepEqual(advertisedEngines(['llama'], resolveDecisionConfig({ decision: { enabled: true, image: 'x:latest' } }, {})), ['llama']);
});

// W6-F1 System 1 providers: laya (local), jev (hosted TypeSafe), jev-then-laya.
test('decision defaults: provider laya, jevModel jev-latest, no key', () => {
  const cfg = resolveDecisionConfig({}, {});
  assert.equal(cfg.provider, 'laya');
  assert.equal(cfg.jevModel, 'jev-latest');
  assert.equal(cfg.jevApiKey, '');
});

test('resolveDecisionConfig normalizes an unknown provider to laya', () => {
  assert.equal(resolveDecisionConfig({ decision: { provider: 'gpt' } }, {}).provider, 'laya');
  assert.equal(resolveDecisionConfig({ decision: { provider: 'jev-then-laya' } }, {}).provider, 'jev-then-laya');
});

test('pickDecisionPatch accepts provider, jevModel, jevApiKey', () => {
  assert.deepEqual(pickDecisionPatch({ provider: 'jev', jevModel: 'jev-1.13.0', jevApiKey: 'k', nope: 1 }),
    { provider: 'jev', jevModel: 'jev-1.13.0', jevApiKey: 'k' });
});

test('publicDecisionConfig drops the key and reports whether it is set', () => {
  assert.deepEqual(publicDecisionConfig({ a: 1, jevApiKey: 'secret' }), { a: 1, jevApiKeySet: true });
  assert.deepEqual(publicDecisionConfig({ a: 1, jevApiKey: '' }), { a: 1, jevApiKeySet: false });
});
