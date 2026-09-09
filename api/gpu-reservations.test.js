// Llama Manager — GPU reservation state machine contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests pin the semantics that are easy to get subtly wrong: negative
// priority holds a card without blocking baseline work, equal priority never
// preempts, only strictly-higher priority takes a card and only from the
// lowest-priority occupant, capacity is spent before priority ever arbitrates,
// a grant is not a hold until the owner drains the card, and a TTL sweep can
// never strand a card behind a crashed holder. The clock is injected, so every
// expiry assertion here is deterministic.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GpuReservations,
  LLAMA_MANAGER_HOLDER,
  BASELINE_PRIORITY,
  normalizeReservationPriority,
} from './gpu-reservations.js';

/** Build a resolved-pool fixture in the shape api/gpu-pools.js emits. */
function pool(id, cardCount, extra = {}) {
  return {
    id,
    label: `${id} label`,
    capacity: cardCount,
    cards: Array.from({ length: cardCount }, (_, i) => ({
      card: `card${i}`,
      pci: `0000:c${i}:00.0`,
    })),
    warnings: [],
    ...extra,
  };
}

/** A reservations machine plus a hand-cranked clock and a preemption log. */
function machine(pools, startAt = 1000) {
  const clock = { t: startAt };
  const preempted = [];
  const reservations = new GpuReservations({
    pools,
    now: () => clock.t,
    onPreempt: (reservation, reason) => preempted.push({ id: reservation.id, reason }),
  });
  return { reservations, clock, preempted };
}

/** Reserve and immediately mark held, the shape of a settled owner. */
function hold(reservations, options) {
  const granted = reservations.reserve(options);
  reservations.markHeld(granted.id);
  return granted;
}

test('normalizes reservation priority to an integer and rejects the rest', () => {
  assert.equal(normalizeReservationPriority(80), 80);
  assert.equal(normalizeReservationPriority(-5), -5);
  assert.equal(normalizeReservationPriority('80'), 80);
  assert.equal(normalizeReservationPriority(undefined), BASELINE_PRIORITY);
  assert.equal(normalizeReservationPriority(null), 0);
  assert.equal(normalizeReservationPriority(''), 0);
  for (const bad of [1.5, 'urgent', {}, [], true, NaN, Infinity]) {
    assert.throws(() => normalizeReservationPriority(bad), TypeError, String(bad));
  }
});

test('negative priority holds a card but never blocks a baseline claim', () => {
  const { reservations, preempted } = machine([pool('rtx3090', 1)]);
  const soft = hold(reservations, { gpu: 'rtx3090', holder: 'pods', priority: -5 });
  assert.equal(reservations.get(soft.id).state, 'held');

  // Baseline llama-manager work must be able to walk straight in: that is the
  // entire point of a negative-priority reservation.
  const baseline = reservations.reserve({ gpu: 'rtx3090', holder: LLAMA_MANAGER_HOLDER });
  assert.equal(baseline.card, 'card0');
  assert.equal(baseline.state, 'pending');
  assert.equal(reservations.get(soft.id).state, 'preempted');
  assert.deepEqual(preempted, [{ id: soft.id, reason: 'preempted_by_higher_priority' }]);
});

test('equal priority never preempts, so two equal claimants cannot thrash', () => {
  const { reservations, preempted } = machine([pool('rtx3090', 1)]);
  const first = hold(reservations, { gpu: 'rtx3090', holder: 'pods', priority: 5 });
  const second = reservations.reserve({ gpu: 'rtx3090', holder: 'other', priority: 5 });

  assert.equal(second.card, null, 'an equal claim waits rather than taking the card');
  assert.equal(second.state, 'pending');
  assert.equal(reservations.get(first.id).state, 'held');
  assert.deepEqual(preempted, []);
});

test('a strictly higher claim preempts the lowest-priority holder only', () => {
  const { reservations, preempted } = machine([pool('rtx3090', 2)]);
  const high = hold(reservations, { gpu: 'rtx3090', holder: 'a', priority: 10 });
  const low = hold(reservations, { gpu: 'rtx3090', holder: 'b', priority: 1 });

  const claim = reservations.reserve({ gpu: 'rtx3090', holder: 'c', priority: 5 });
  assert.equal(claim.card, low.card, 'the claim inherits the preempted card');
  assert.equal(reservations.get(low.id).state, 'preempted');
  assert.equal(reservations.get(high.id).state, 'held');
  assert.equal(preempted.length, 1, 'exactly one victim');
});

test('preemption ties among equally lowest holders break oldest-granted-first', () => {
  const { reservations, clock } = machine([pool('rtx3090', 2)]);
  const older = hold(reservations, { gpu: 'rtx3090', holder: 'a', priority: 1 });
  clock.t += 1000;
  const newer = hold(reservations, { gpu: 'rtx3090', holder: 'b', priority: 1 });

  const claim = reservations.reserve({ gpu: 'rtx3090', holder: 'c', priority: 5 });
  assert.equal(claim.card, older.card);
  assert.equal(reservations.get(older.id).state, 'preempted');
  assert.equal(reservations.get(newer.id).state, 'held');
});

test('a capacity-2 pool grants two claims at once with no preemption', () => {
  const { reservations, preempted } = machine([pool('rtx3090', 2)]);
  // While capacity is free, priority is irrelevant -- even a claim far below an
  // existing holder is granted immediately.
  const first = reservations.reserve({ gpu: 'rtx3090', holder: 'a', priority: 90 });
  const second = reservations.reserve({ gpu: 'rtx3090', holder: 'b', priority: -90 });

  assert.equal(first.card, 'card0');
  assert.equal(second.card, 'card1');
  assert.deepEqual(preempted, []);
  assert.equal(reservations.describe()[0].free, 0);
});

test('a third claim on a full capacity-2 pool preempts only the lowest', () => {
  const { reservations, preempted } = machine([pool('rtx3090', 2)]);
  const keep = hold(reservations, { gpu: 'rtx3090', holder: 'a', priority: 8 });
  const lose = hold(reservations, { gpu: 'rtx3090', holder: 'b', priority: 2 });

  reservations.reserve({ gpu: 'rtx3090', holder: 'pods', priority: 80 });
  assert.equal(preempted.length, 1);
  assert.equal(preempted[0].id, lose.id);
  assert.equal(reservations.get(keep.id).state, 'held');
});

test('markHeld is required before a reservation reads as held', () => {
  const { reservations } = machine([pool('rtx3090', 1)]);
  const granted = reservations.reserve({ gpu: 'rtx3090', holder: 'pods', priority: 1 });

  // The card is bound but NOT drained yet -- that gap is why lock/wait exist.
  assert.equal(granted.state, 'pending');
  assert.equal(granted.card, 'card0');
  const before = reservations.describe()[0];
  assert.deepEqual(before.held, []);
  assert.equal(before.pending.length, 1);
  assert.equal(before.free, 0, 'a pending grant still occupies its card');

  assert.equal(reservations.markHeld(granted.id), true);
  assert.equal(reservations.get(granted.id).state, 'held');
  assert.equal(reservations.markHeld(granted.id), false, 'markHeld is idempotent-safe');
  assert.equal(reservations.describe()[0].held.length, 1);
});

test('markHeld refuses a claim that has not been granted a card', () => {
  const { reservations } = machine([pool('rtx3090', 1)]);
  hold(reservations, { gpu: 'rtx3090', holder: 'a', priority: 5 });
  const waiting = reservations.reserve({ gpu: 'rtx3090', holder: 'b', priority: 5 });
  assert.equal(reservations.markHeld(waiting.id), false);
  assert.equal(reservations.get(waiting.id).state, 'pending');
  assert.equal(reservations.markHeld('res-nope'), false);
});

test('TTL expiry frees the card so a crashed holder cannot strand it', () => {
  const { reservations, clock } = machine([pool('rtx3090', 1)]);
  const lease = hold(reservations, { gpu: 'rtx3090', holder: 'pods', priority: 5, ttlMs: 5000 });
  assert.equal(reservations.get(lease.id).expiresAt, 6000);

  assert.deepEqual(reservations.sweep(), [], 'not yet due');
  clock.t = 6001;
  const expired = reservations.sweep();
  assert.equal(expired.length, 1);
  assert.equal(expired[0].id, lease.id);
  assert.equal(expired[0].state, 'expired');
  assert.equal(reservations.describe()[0].free, 1);
});

test('a reservation with no TTL is exempt from the sweep', () => {
  const { reservations, clock } = machine([pool('rtx3090', 1)]);
  const pin = hold(reservations, { gpu: 'rtx3090', holder: LLAMA_MANAGER_HOLDER });
  assert.equal(pin.expiresAt, null);
  clock.t += 10_000_000;
  assert.deepEqual(reservations.sweep(), []);
  assert.equal(reservations.get(pin.id).state, 'held');
});

test('a claim sweeps expired leases first rather than queueing behind a dead one', () => {
  // Matches PreparedContextStore's lazy expiry-on-access: a lease past its TTL must
  // never make a live claim wait, even when nobody has called sweep() yet.
  const { reservations, clock } = machine([pool('rtx3090', 1)]);
  const dead = hold(reservations, { gpu: 'rtx3090', holder: 'crashed', priority: 90, ttlMs: 5000 });
  clock.t = 6001;

  const claim = reservations.reserve({ gpu: 'rtx3090', holder: 'pods', priority: 1 });
  assert.equal(claim.card, 'card0');
  assert.equal(reservations.get(dead.id).state, 'expired');
});

test('every state change stamps updatedAt from the injected clock', () => {
  const { reservations, clock } = machine([pool('rtx3090', 1)]);
  const granted = reservations.reserve({ gpu: 'rtx3090', holder: 'pods', priority: 1, ttlMs: 5000 });
  assert.equal(granted.updatedAt, 1000);

  clock.t = 2000;
  reservations.markHeld(granted.id);
  assert.equal(reservations.get(granted.id).updatedAt, 2000);
  clock.t = 3000;
  reservations.renew(granted.id);
  assert.equal(reservations.get(granted.id).updatedAt, 3000);
  clock.t = 4000;
  reservations.release(granted.id);
  assert.equal(reservations.get(granted.id).updatedAt, 4000);
});

test('renew pushes the lease out and prevents expiry', () => {
  const { reservations, clock } = machine([pool('rtx3090', 1)]);
  const lease = hold(reservations, { gpu: 'rtx3090', holder: 'pods', priority: 5, ttlMs: 5000 });

  clock.t = 4000;
  const renewed = reservations.renew(lease.id);
  assert.equal(renewed.expiresAt, 9000);
  clock.t = 8000;
  assert.deepEqual(reservations.sweep(), [], 'the heartbeat kept it alive');
  assert.equal(reservations.get(lease.id).state, 'held');

  clock.t = 9001;
  assert.equal(reservations.sweep().length, 1);
  assert.throws(() => reservations.renew(lease.id), /not active/);
  assert.throws(() => reservations.renew('res-nope'), /unknown reservation/);
});

test('release frees the card and promotes the longest-waiting claim', () => {
  const { reservations, clock } = machine([pool('rtx3090', 1)]);
  const held = hold(reservations, { gpu: 'rtx3090', holder: 'a', priority: 5 });
  clock.t += 100;
  const older = reservations.reserve({ gpu: 'rtx3090', holder: 'b', priority: 5 });
  clock.t += 100;
  const newer = reservations.reserve({ gpu: 'rtx3090', holder: 'c', priority: 5 });
  assert.equal(older.card, null);
  assert.equal(newer.card, null);

  assert.equal(reservations.release(held.id), true);
  assert.equal(reservations.get(held.id).state, 'released');
  assert.equal(reservations.get(older.id).card, 'card0', 'oldest waiter promoted');
  assert.equal(reservations.get(older.id).state, 'pending', 'promotion still needs markHeld');
  assert.equal(reservations.get(newer.id).card, null);
  assert.equal(reservations.release(held.id), false, 'releasing twice is a no-op');
});

test('a higher-priority waiter is promoted ahead of an older equal-pool waiter', () => {
  const { reservations, clock } = machine([pool('rtx3090', 1)]);
  const held = hold(reservations, { gpu: 'rtx3090', holder: 'a', priority: 50 });
  clock.t += 100;
  const low = reservations.reserve({ gpu: 'rtx3090', holder: 'b', priority: 1 });
  clock.t += 100;
  const high = reservations.reserve({ gpu: 'rtx3090', holder: 'c', priority: 9 });

  reservations.release(held.id);
  assert.equal(reservations.get(high.id).card, 'card0');
  assert.equal(reservations.get(low.id).card, null);
});

test('onPreempt fires exactly once per victim', () => {
  const { reservations, preempted } = machine([pool('rtx3090', 1)]);
  const first = hold(reservations, { gpu: 'rtx3090', holder: 'a', priority: 0 });
  const second = reservations.reserve({ gpu: 'rtx3090', holder: 'b', priority: 5 });
  reservations.markHeld(second.id);
  reservations.reserve({ gpu: 'rtx3090', holder: 'c', priority: 9 });

  assert.equal(preempted.filter(entry => entry.id === first.id).length, 1);
  assert.equal(preempted.filter(entry => entry.id === second.id).length, 1);
  assert.equal(preempted.length, 2);
});

test('a claim against a capacity-0 pool refuses with a clear reason', () => {
  const { reservations } = machine([pool('rtx3090', 0)]);
  assert.throws(
    () => reservations.reserve({ gpu: 'rtx3090', holder: 'pods', priority: 5 }),
    (error) => {
      assert.equal(error.code, 'NO_CARD_PRESENT');
      assert.match(error.message, /no card of this class is present/);
      return true;
    },
  );
  assert.deepEqual(reservations.list(), [], 'a refused claim is not recorded');
});

test('a claim against an unknown gpu id refuses rather than waiting', () => {
  const { reservations } = machine([pool('rtx3090', 1)]);
  assert.throws(
    () => reservations.reserve({ gpu: 'nope', holder: 'pods' }),
    (error) => error.code === 'UNKNOWN_GPU' && /nope/.test(error.message),
  );
});

test('noWait refuses instead of queueing when the pool is full', () => {
  const { reservations } = machine([pool('rtx3090', 1)]);
  hold(reservations, { gpu: 'rtx3090', holder: 'a', priority: 5 });
  assert.throws(
    () => reservations.reserve({ gpu: 'rtx3090', holder: 'b', priority: 5, noWait: true }),
    (error) => error.code === 'GPU_BUSY' && /priority/.test(error.message),
  );
  assert.equal(reservations.list({ gpu: 'rtx3090' }).length, 1);
});

test('a claim requires a gpu id and a holder name', () => {
  const { reservations } = machine([pool('rtx3090', 1)]);
  assert.throws(() => reservations.reserve({ holder: 'a' }), TypeError);
  assert.throws(() => reservations.reserve({ gpu: 'rtx3090', holder: '' }), TypeError);
});

test('list filters by gpu and state', () => {
  const { reservations } = machine([pool('a', 1), pool('b', 1)]);
  const first = hold(reservations, { gpu: 'a', holder: 'x' });
  const second = reservations.reserve({ gpu: 'b', holder: 'y' });

  assert.deepEqual(reservations.list({ gpu: 'a' }).map(r => r.id), [first.id]);
  assert.deepEqual(reservations.list({ state: 'pending' }).map(r => r.id), [second.id]);
  assert.equal(reservations.list().length, 2);
  assert.equal(reservations.get('res-nope'), null);
});

test('describe reports capacity, free cards, holders and waiters per pool', () => {
  const { reservations } = machine([pool('rtx3090', 2), pool('igpu', 0, { warnings: ['no card'] })]);
  const held = hold(reservations, { gpu: 'rtx3090', holder: 'pods', priority: 80, ttlMs: 1000 });
  reservations.reserve({ gpu: 'rtx3090', holder: LLAMA_MANAGER_HOLDER });

  const [gpu, empty] = reservations.describe();
  assert.equal(gpu.id, 'rtx3090');
  assert.equal(gpu.label, 'rtx3090 label');
  assert.equal(gpu.capacity, 2);
  assert.equal(gpu.free, 0);
  assert.deepEqual(gpu.held.map(r => r.id), [held.id]);
  assert.equal(gpu.pending.length, 1);
  assert.deepEqual(gpu.softClaimed, []);
  assert.equal(empty.capacity, 0);
  assert.equal(empty.free, 0);
  assert.deepEqual(empty.warnings, ['no card']);
});

test('a busy unreserved card reads as softly claimed, a reserved one does not', () => {
  const { reservations } = machine([pool('rtx3090', 2)]);
  const total = 24 * 1024 * 1024 * 1024;
  const busy = { totalBytes: total, usedBytes: total - 1024 };
  const idle = { totalBytes: total, usedBytes: 1024 };

  assert.equal(reservations.softClaim('card0', busy), true);
  assert.equal(reservations.softClaim('card0', idle), false);
  // A card llama-manager itself reserved is accounted for, not "unfriendly".
  hold(reservations, { gpu: 'rtx3090', holder: LLAMA_MANAGER_HOLDER });
  assert.equal(reservations.softClaim('card0', busy), false);

  const [gpu] = reservations.describe({ telemetry: { card1: busy } });
  assert.deepEqual(gpu.softClaimed, ['card1']);
  assert.deepEqual(reservations.describe()[0].softClaimed, [], 'no telemetry, no claim');
});

test('setPools releases holders of a card that is no longer present', () => {
  const { reservations, preempted } = machine([pool('rtx3090', 2)]);
  const keep = hold(reservations, { gpu: 'rtx3090', holder: 'a', priority: 1 });
  const gone = hold(reservations, { gpu: 'rtx3090', holder: 'b', priority: 1 });
  assert.equal(gone.card, 'card1');

  reservations.setPools([pool('rtx3090', 1)]);
  assert.equal(reservations.get(keep.id).state, 'held');
  assert.equal(reservations.get(gone.id).state, 'preempted');
  assert.deepEqual(preempted, [{ id: gone.id, reason: 'card_no_longer_present' }]);
  assert.equal(reservations.describe()[0].capacity, 1);
});

test('setPools grants waiting claims when capacity appears', () => {
  const { reservations } = machine([pool('rtx3090', 1)]);
  hold(reservations, { gpu: 'rtx3090', holder: 'a', priority: 5 });
  const waiting = reservations.reserve({ gpu: 'rtx3090', holder: 'b', priority: 5 });
  assert.equal(waiting.card, null);

  reservations.setPools([pool('rtx3090', 2)]);
  assert.equal(reservations.get(waiting.id).card, 'card1');
});

test('an owner callback that throws cannot break the state machine', () => {
  const reservations = new GpuReservations({
    pools: [pool('rtx3090', 1)],
    now: () => 1000,
    onPreempt: () => { throw new Error('owner blew up'); },
  });
  const victim = hold(reservations, { gpu: 'rtx3090', holder: 'a', priority: 0 });
  const claim = reservations.reserve({ gpu: 'rtx3090', holder: 'b', priority: 5 });
  assert.equal(reservations.get(victim.id).state, 'preempted');
  assert.equal(claim.card, 'card0');
});
