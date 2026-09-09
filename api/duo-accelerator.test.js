// Llama Manager — tests for the optional discrete-GPU accelerator arbitration.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RPC_PORT,
  acceleratorPlan,
  rpcRouterArgs,
  agentHoldsCard,
  AGENT_RESERVE_BYTES,
  engineSupportsRpc,
  parseEngineNeededLibs,
  normalizeDuoSettings,
} from './duo-accelerator.js';

const GB = 1024 * 1024 * 1024;
const NVIDIA = { hasNvidia: true };
const AMD_ONLY = { hasNvidia: false };
const ON = { useAccelerator: true, acceleratorPriority: 'agent-first' };

test('an AMD-only box never starts an RPC server, whatever the settings say', () => {
  const p = acceleratorPlan({ profile: AMD_ONLY, settings: ON });
  assert.equal(p.startRpc, false);
  assert.match(p.reason, /no NVIDIA/i);
});

test('an NVIDIA box with the accelerator switched off does not start one either', () => {
  const p = acceleratorPlan({ profile: NVIDIA, settings: { useAccelerator: false } });
  assert.equal(p.startRpc, false);
  assert.match(p.reason, /disabled/i);
});

test('an NVIDIA box with it enabled and a free card starts the RPC server', () => {
  const p = acceleratorPlan({
    profile: NVIDIA, settings: ON, gpu: { totalBytes: 24 * GB, usedBytes: 1.5 * GB },
  });
  assert.equal(p.startRpc, true);
  assert.equal(p.endpoint, `127.0.0.1:${DEFAULT_RPC_PORT}`);
});

test('agent-first yields the card when the pods agent is actively using it', () => {
  const p = acceleratorPlan({
    profile: NVIDIA, settings: ON, gpu: { totalBytes: 24 * GB, usedBytes: 20 * GB },
  });
  assert.equal(p.startRpc, false);
  assert.match(p.reason, /agent/i);
});

test('llama-first takes the card even while the agent is using it', () => {
  const p = acceleratorPlan({
    profile: NVIDIA,
    settings: { useAccelerator: true, acceleratorPriority: 'llama-first' },
    gpu: { totalBytes: 24 * GB, usedBytes: 20 * GB },
  });
  assert.equal(p.startRpc, true);
});

test('the two idle pods-agent servers do NOT count as the agent holding the card', () => {
  // Measured on the real box: speech + asset-generation sit resident at ~1.45 GB
  // between jobs. Treating that as "busy" would mean duo never gets the card at all.
  assert.equal(agentHoldsCard({ totalBytes: 24 * GB, usedBytes: 1.45 * GB }), false);
});

test('a real generation job DOES count as the agent holding the card', () => {
  assert.equal(agentHoldsCard({ totalBytes: 24 * GB, usedBytes: 18 * GB }), true);
});

test('unknown GPU telemetry is treated as busy — never evict what you cannot see', () => {
  assert.equal(agentHoldsCard(null), true);
  assert.equal(agentHoldsCard({}), true);
});

test('the reserve left for the agent is a real amount, not a token gesture', () => {
  assert.ok(AGENT_RESERVE_BYTES >= 8 * GB, 'asset generation needs room to burst');
});

test('router args are emitted only when the plan says to start RPC', () => {
  assert.deepEqual(rpcRouterArgs({ startRpc: true, endpoint: '127.0.0.1:50052' }), ['--rpc', '127.0.0.1:50052']);
  assert.deepEqual(rpcRouterArgs({ startRpc: false }), []);
  assert.deepEqual(rpcRouterArgs(null), []);
});

test('an AMD-only box emits no --rpc flag at all — the Frostburn acceptance check', () => {
  const p = acceleratorPlan({ profile: AMD_ONLY, settings: ON });
  assert.deepEqual(rpcRouterArgs(p), []);
});

// ---- GPU reservations -------------------------------------------------------------
// Duo's use of the card is ordinary llama-manager work, so it sits at the reservation
// scale's baseline of 0. A reservation ABOVE that outranks it and the rpc-server must not
// run; one at or below it does not, and duo keeps the card.

test('a card held above the accelerator\'s own priority yields no rpc-server', () => {
  const p = acceleratorPlan({
    profile: NVIDIA, settings: ON, gpu: { totalBytes: 24 * GB, usedBytes: 1.45 * GB },
    reservations: [{ state: 'held', priority: 80, holder: 'pods' }],
  });
  assert.equal(p.startRpc, false);
  assert.equal(p.endpoint, null);
  assert.match(p.reason, /pods/);
  assert.deepEqual(rpcRouterArgs(p), []);
});

test('a card held BELOW the accelerator\'s priority still runs the rpc-server', () => {
  const p = acceleratorPlan({
    profile: NVIDIA, settings: ON, gpu: { totalBytes: 24 * GB, usedBytes: 1.45 * GB },
    reservations: [{ state: 'held', priority: -5, holder: 'warm-keeper' }],
  });
  assert.equal(p.startRpc, true);
});

test('a reservation at exactly the accelerator\'s priority does not displace it', () => {
  // Mirrors the state machine: only a STRICTLY higher claim takes a card.
  const p = acceleratorPlan({
    profile: NVIDIA, settings: ON, gpu: { totalBytes: 24 * GB, usedBytes: 1.45 * GB },
    reservations: [{ state: 'held', priority: 0, holder: 'llama-manager' }],
  });
  assert.equal(p.startRpc, true);
});

test('a claim still pending outranks the accelerator too — it is already draining', () => {
  const p = acceleratorPlan({
    profile: NVIDIA, settings: ON, gpu: { totalBytes: 24 * GB, usedBytes: 1.45 * GB },
    reservations: [{ state: 'pending', priority: 80, holder: 'pods' }],
  });
  assert.equal(p.startRpc, false);
});

test('a finished reservation never blocks the accelerator', () => {
  for (const state of ['released', 'expired', 'preempted']) {
    const p = acceleratorPlan({
      profile: NVIDIA, settings: ON, gpu: { totalBytes: 24 * GB, usedBytes: 1.45 * GB },
      reservations: [{ state, priority: 80, holder: 'pods' }],
    });
    assert.equal(p.startRpc, true, `${state} must not hold the card`);
  }
});

test('a high-priority reservation beats llama-first, which only overrides the VRAM heuristic', () => {
  const p = acceleratorPlan({
    profile: NVIDIA,
    settings: { useAccelerator: true, acceleratorPriority: 'llama-first' },
    reservations: [{ state: 'held', priority: 80, holder: 'pods' }],
  });
  assert.equal(p.startRpc, false);
});

test('no reservations at all leaves every existing decision byte-identical', () => {
  const without = acceleratorPlan({ profile: NVIDIA, settings: ON, gpu: { totalBytes: 24 * GB, usedBytes: 1.45 * GB } });
  const withEmpty = acceleratorPlan({
    profile: NVIDIA, settings: ON, gpu: { totalBytes: 24 * GB, usedBytes: 1.45 * GB }, reservations: [],
  });
  assert.deepEqual(withEmpty, without);
});

// --- the engine must actually HAVE an RPC backend -----------------------------
//
// The b10752 engine was built without -DGGML_RPC=ON. `--rpc` still PARSES, because the
// option string lives in libllama-common rather than in the backend, so the engine
// started, logged nothing unusual, and simply never attached to the remote card. Every
// test above, and the whole accelerator path, looked correct while doing nothing at all.
// These pin the check that makes that failure visible instead of silent.

test('an engine linked against the RPC backend supports --rpc', () => {
  const needed = ['libggml.so.0', 'libggml-cpu.so.0', 'libggml-hip.so.0', 'libggml-rpc.so.0', 'libc.so.6'];
  assert.equal(engineSupportsRpc(needed), true);
});

test('an engine without the RPC backend does not, however well --rpc parses', () => {
  // This is exactly b10752's NEEDED list, read off the deployed binary.
  const needed = ['libggml.so.0', 'libggml-cpu.so.0', 'libggml-hip.so.0', 'libggml-base.so.0', 'libc.so.6'];
  assert.equal(engineSupportsRpc(needed), false);
});

test('a version-suffixed RPC library still counts', () => {
  assert.equal(engineSupportsRpc(['libggml-rpc.so.0.22.0']), true);
});

test('an unreadable binary is treated as UNSUPPORTED, never assumed good', () => {
  // If we cannot tell, emitting --rpc risks another silent no-op. Refusing to emit it
  // costs a documented log line; assuming support costs a card that never gets used.
  assert.equal(engineSupportsRpc(null), false);
  assert.equal(engineSupportsRpc([]), false);
  assert.equal(engineSupportsRpc(undefined), false);
});

test('parseEngineNeededLibs reads the NEEDED entries out of readelf -d output', () => {
  const output = [
    'Dynamic section at offset 0x2d10 contains 30 entries:',
    '  Tag        Type                         Name/Value',
    ' 0x0000000000000001 (NEEDED)             Shared library: [libggml-hip.so.0]',
    ' 0x0000000000000001 (NEEDED)             Shared library: [libggml-rpc.so.0]',
    ' 0x000000000000001d (RUNPATH)            Library runpath: [/home/yolan/llama.cpp/build/bin]',
  ].join('\n');
  assert.deepEqual(parseEngineNeededLibs(output), ['libggml-hip.so.0', 'libggml-rpc.so.0']);
});

test('parseEngineNeededLibs never throws on junk', () => {
  // Runs at engine start; an exception here would stop the engine from starting at all.
  assert.deepEqual(parseEngineNeededLibs(''), []);
  assert.deepEqual(parseEngineNeededLibs(null), []);
  assert.deepEqual(parseEngineNeededLibs('readelf: Error: Not an ELF file'), []);
});

test('end to end: a plan that would start the accelerator is refused on an RPC-less engine', () => {
  const plan = acceleratorPlan({
    profile: { hasNvidia: true },
    settings: { useAccelerator: true, acceleratorPriority: 'llama-first' },
    gpu: { totalBytes: 24 * 1024 ** 3, usedBytes: 1.4 * 1024 ** 3 },
  });
  assert.equal(plan.startRpc, true, 'precondition: this plan would otherwise start');
  // The engine, not the policy, is what makes it impossible.
  assert.deepEqual(rpcRouterArgs(plan, { engineSupportsRpc: false }), []);
  assert.deepEqual(rpcRouterArgs(plan, { engineSupportsRpc: true }), ['--rpc', plan.endpoint]);
});

// The accelerator had no supported way to be switched on: POST /api/settings did not
// accept `duo`, and no other route wrote it, so the only way to enable the discrete card
// was hand-editing config.json on the box. These pin the validation for the settings key.
test('normalizeDuoSettings accepts the two documented priorities', () => {
  assert.deepEqual(normalizeDuoSettings({ useAccelerator: true, acceleratorPriority: 'agent-first' }),
    { useAccelerator: true, acceleratorPriority: 'agent-first' });
  assert.deepEqual(normalizeDuoSettings({ useAccelerator: true, acceleratorPriority: 'llama-first' }),
    { useAccelerator: true, acceleratorPriority: 'llama-first' });
});

test('normalizeDuoSettings defaults to agent-first, never llama-first', () => {
  // The default must be the SAFE one: agent-first leaves the card to the pods agent unless
  // it is demonstrably free. Defaulting to llama-first would quietly take a card away from
  // whatever else on the box was using it.
  assert.deepEqual(normalizeDuoSettings({ useAccelerator: true }),
    { useAccelerator: true, acceleratorPriority: 'agent-first' });
  assert.deepEqual(normalizeDuoSettings({}), { useAccelerator: false, acceleratorPriority: 'agent-first' });
});

test('normalizeDuoSettings rejects an unknown priority rather than silently defaulting', () => {
  assert.throws(() => normalizeDuoSettings({ acceleratorPriority: 'whatever' }), TypeError);
  assert.throws(() => normalizeDuoSettings({ useAccelerator: 'yes' }), TypeError);
  assert.throws(() => normalizeDuoSettings([]), TypeError);
});
