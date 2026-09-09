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
