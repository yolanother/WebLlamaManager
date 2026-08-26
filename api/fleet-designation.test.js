// Llama Manager — main-node designation tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies how a fleet agrees who coordinates it: that the election is
// convergent rather than negotiated, so every node computes the same answer from
// the same peer list without exchanging a single message; that an operator's
// explicit choice outranks the election and survives a restart; and that a node
// alone is simply main of a fleet of one, with nothing to wait for. Authority
// here is soft by design — this is a desk, not a datacentre — so the tests pin
// that losing sight of the main node never stops a node serving its own users.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ROLE_MAIN,
  ROLE_SECONDARY,
  electMain,
  roleFor,
  designationTxt,
} from './fleet-designation.js';

/** Shorthand for a discovered peer carrying only what the election reads. */
const peer = (id, pinned = false) => ({ txt: { id, ...(pinned ? { pin: '1' } : {}) } });

// ── Election ────────────────────────────────────────────────────────────────

test('a node with no peers is main of a fleet of one', () => {
  // Principle 2: a node alone must be fully useful, with no waiting on an
  // election and no degraded path.
  assert.equal(electMain({ selfId: 'bbbb', peers: [] }), 'bbbb');
  assert.equal(roleFor({ selfId: 'bbbb', peers: [] }), ROLE_MAIN);
});

test('the lowest node id wins', () => {
  const peers = [peer('cccc'), peer('aaaa')];
  assert.equal(electMain({ selfId: 'bbbb', peers }), 'aaaa');
  assert.equal(roleFor({ selfId: 'bbbb', peers }), ROLE_SECONDARY);
});

test('a node that holds the lowest id elects itself', () => {
  const peers = [peer('cccc'), peer('bbbb')];
  assert.equal(roleFor({ selfId: 'aaaa', peers }), ROLE_MAIN);
});

test('every node in the fleet reaches the same answer', () => {
  // The whole point of a deterministic election: no negotiation, no messages,
  // no term numbers. Each node runs this over its own view and agrees.
  const ids = ['cccc', 'aaaa', 'bbbb'];
  const elected = ids.map((selfId) => electMain({
    selfId,
    peers: ids.filter((id) => id !== selfId).map((id) => peer(id)),
  }));
  assert.deepEqual(elected, ['aaaa', 'aaaa', 'aaaa']);
});

test('a peer that advertises no id cannot win or break the election', () => {
  const peers = [{ txt: {} }, { txt: { id: '' } }, peer('cccc')];
  assert.equal(electMain({ selfId: 'bbbb', peers }), 'bbbb');
});

test('a node that does not know its own id defers rather than claiming main', () => {
  // No machine id means no node id. Claiming main on an identity we cannot
  // state would make two nodes both believe they coordinate.
  assert.equal(electMain({ selfId: null, peers: [peer('cccc')] }), 'cccc');
  assert.equal(roleFor({ selfId: null, peers: [peer('cccc')] }), ROLE_SECONDARY);
});

test('a node alone and without an id is still main of itself', () => {
  assert.equal(roleFor({ selfId: null, peers: [] }), ROLE_MAIN);
});

// ── Operator override ───────────────────────────────────────────────────────

test('an operator pin outranks the election', () => {
  // The operator will have opinions about which box is the good one, and a
  // system that re-elects around them is infuriating.
  const peers = [peer('aaaa'), peer('cccc')];
  assert.equal(electMain({ selfId: 'bbbb', peers, pinned: true }), 'bbbb');
  assert.equal(roleFor({ selfId: 'bbbb', peers, pinned: true }), ROLE_MAIN);
});

test('a peer that advertises a pin is deferred to', () => {
  // The pin travels in the peer's TXT record, which is how the rest of the
  // fleet learns about a choice made on one node's screen.
  const peers = [peer('aaaa'), peer('cccc', true)];
  assert.equal(electMain({ selfId: 'bbbb', peers }), 'cccc');
});

test('two pins do not deadlock, they fall back to the lowest pinned id', () => {
  // Two operators, or one operator on two screens. Someone has to win, and it
  // has to be the same someone on every node.
  const peers = [peer('cccc', true), peer('aaaa', true)];
  assert.equal(electMain({ selfId: 'bbbb', peers }), 'aaaa');
});

test('a local pin competes with a remote pin on id, not on locality', () => {
  // A node must not prefer its own pin, or two pinned nodes would each believe
  // they are main and the fleet would never converge.
  assert.equal(
    electMain({ selfId: 'bbbb', peers: [peer('aaaa', true)], pinned: true }),
    'aaaa',
  );
});

test('an unpinned lower id loses to a pinned higher id', () => {
  const peers = [peer('aaaa'), peer('zzzz', true)];
  assert.equal(electMain({ selfId: 'bbbb', peers }), 'zzzz');
});

// ── Advertised role ─────────────────────────────────────────────────────────

test('the advertised role and pin describe this node to the fleet', () => {
  assert.deepEqual(designationTxt({ role: ROLE_MAIN, pinned: true }), { role: 'main', pin: '1' });
  assert.deepEqual(designationTxt({ role: ROLE_SECONDARY, pinned: false }), { role: 'secondary', pin: '' });
});

test('a Phase 1 peer advertising the old standalone role is not misread', () => {
  // Phase 1 nodes advertise role=standalone and no pin at all. They must count
  // as ordinary fleet members rather than as rival mains or as absent.
  const peers = [{ txt: { id: 'aaaa', role: 'standalone' } }];
  assert.equal(electMain({ selfId: 'bbbb', peers }), 'aaaa');
});

// ── Soft authority ──────────────────────────────────────────────────────────

test('losing every peer promotes a secondary rather than stalling it', () => {
  // A thumb drive was pulled out. The survivor keeps serving its own users and
  // is now trivially main of what remains; there is no fencing and no quorum,
  // because the cost of two mains on a desk is nothing and the cost of a node
  // that stops working is everything.
  assert.equal(roleFor({ selfId: 'zzzz', peers: [peer('aaaa')] }), ROLE_SECONDARY);
  assert.equal(roleFor({ selfId: 'zzzz', peers: [] }), ROLE_MAIN);
});
