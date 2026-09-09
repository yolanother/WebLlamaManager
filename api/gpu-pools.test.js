/**
 * Copyright (c) Llama Manager project. Use of this file is governed by the
 * LICENSE file in the repository root.
 *
 * Tests GPU pool resolution: that an operator-named pool matches the cards
 * actually present by their CLASS rather than by DRM index or PCI slot, that a
 * pool of two identical cards reports capacity 2 rather than an ambiguity, and
 * that every way a pool can fail to match is reported with a warning instead of
 * silently matching nothing -- or, far worse, everything. The two motivating
 * cases are driven from fixtures because this host has one GPU: a DRM reorder
 * (card0/card1 swapping between the APU and an OCuLink card) and the same card
 * coming back in a different PCI slot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POOL_PRIORITY,
  normalizePoolConfig,
  cardMatchesPool,
  resolvePools,
  poolForCard,
} from './gpu-pools.js';

const GIB = 1024 ** 3;

/** The APU, as readCardSysfs reports it once L3 carries the PCI identity through. */
const apu = (card = 'card0') => ({
  card,
  name: 'AMD Radeon 8060S Graphics',
  driver: 'amdgpu',
  available: true,
  pci: '0000:c4:00.0',
  vendorId: '0x1002',
  deviceId: '0x1586',
  gttBytes: 120 * GIB,
});

/** The OCuLink-attached 3090, in its usual slot. */
const rtx = (card = 'card1', pci = '0000:c5:00.0') => ({
  card,
  name: 'NVIDIA GeForce RTX 3090',
  driver: 'nvidia',
  available: true,
  pci,
  vendorId: '0x10de',
  deviceId: '0x2204',
  vramBytes: 24 * GIB,
});

test('the baseline pool priority is llama-manager\'s own zero', () => {
  assert.equal(DEFAULT_POOL_PRIORITY, 0);
});

/* ---------------------------------------------------------------- config -- */

test('normalizePoolConfig fills every default a settings entry may omit', () => {
  const pool = normalizePoolConfig({ id: 'rtx3090', match: { pciId: '10de:2204' } });
  assert.equal(pool.id, 'rtx3090');
  assert.equal(pool.label, 'rtx3090', 'the id stands in as the label so a readout is never blank');
  assert.deepEqual(pool.pinnedModels, []);
  assert.equal(pool.defaultPriority, DEFAULT_POOL_PRIORITY);
  assert.deepEqual(pool.match, { pciId: '10de:2204' });
});

test('normalizePoolConfig keeps everything an entry does supply', () => {
  const pool = normalizePoolConfig({
    id: 'rtx3090',
    label: 'RTX 3090 (OCuLink)',
    match: { pciId: '0x10DE:0x2204', name: 'RTX 3090', pci: '0000:C5:00.0' },
    pinnedModels: ['llama-3.1-8b'],
    defaultPriority: 80,
  });
  assert.equal(pool.label, 'RTX 3090 (OCuLink)');
  assert.deepEqual(pool.pinnedModels, ['llama-3.1-8b']);
  assert.equal(pool.defaultPriority, 80);
  assert.deepEqual(
    pool.match,
    { pciId: '10de:2204', name: 'rtx 3090', pci: '0000:c5:00.0' },
    'selectors are folded to their comparison form once, at the edge',
  );
});

test('normalizePoolConfig accepts an empty match rather than rejecting it', () => {
  // An empty match is a real operator mistake, but the honest place to report it
  // is resolution -- where the pool can be named alongside its capacity of 0 --
  // not a throw that takes the whole settings file down with it.
  const pool = normalizePoolConfig({ id: 'nothing' });
  assert.deepEqual(pool.match, {});
});

test('normalizePoolConfig rejects an entry that cannot name a pool', () => {
  assert.throws(() => normalizePoolConfig(null), TypeError);
  assert.throws(() => normalizePoolConfig('rtx3090'), TypeError);
  assert.throws(() => normalizePoolConfig({}), TypeError);
  assert.throws(() => normalizePoolConfig({ id: '   ' }), TypeError);
  assert.throws(() => normalizePoolConfig({ id: 7 }), TypeError);
});

test('normalizePoolConfig rejects a match it cannot honour', () => {
  assert.throws(() => normalizePoolConfig({ id: 'a', match: 'rtx' }), TypeError);
  // A typo'd selector must be loud. Ignoring it would leave a pool whose only
  // constraint is one the module never applies -- the exact route to a pool that
  // matches every card in the machine.
  assert.throws(() => normalizePoolConfig({ id: 'a', match: { pcid: '10de:2204' } }), TypeError);
  assert.throws(() => normalizePoolConfig({ id: 'a', match: { name: '' } }), TypeError);
  assert.throws(() => normalizePoolConfig({ id: 'a', match: { name: 42 } }), TypeError);
});

test('normalizePoolConfig rejects malformed pins and priorities', () => {
  assert.throws(() => normalizePoolConfig({ id: 'a', pinnedModels: 'llama' }), TypeError);
  assert.throws(() => normalizePoolConfig({ id: 'a', pinnedModels: [''] }), TypeError);
  assert.throws(() => normalizePoolConfig({ id: 'a', defaultPriority: 'high' }), TypeError);
  assert.throws(() => normalizePoolConfig({ id: 'a', defaultPriority: 1.5 }), TypeError);
});

/* --------------------------------------------------------------- matching -- */

test('a pciId selector matches with or without the 0x prefix sysfs uses', () => {
  assert.equal(cardMatchesPool(rtx(), { pciId: '10de:2204' }), true);
  assert.equal(cardMatchesPool(rtx(), { pciId: '0x10de:0x2204' }), true);
  assert.equal(cardMatchesPool(rtx(), { pciId: '10DE:2204' }), true);
  assert.equal(cardMatchesPool(rtx(), { pciId: '1002:1586' }), false);
});

test('a pciId selector matches a card that already carries a composed pciId', () => {
  // buildInventory composes `pciId` for its callers; readCardSysfs hands over the
  // raw vendor/device pair. Both shapes reach this module, so both must match.
  const card = { card: 'card1', name: 'NVIDIA GeForce RTX 3090', available: true, pciId: '10de:2204' };
  assert.equal(cardMatchesPool(card, { pciId: '10de:2204' }), true);
});

test('a pci selector matches one exact slot, case-insensitively', () => {
  assert.equal(cardMatchesPool(rtx(), { pci: '0000:c5:00.0' }), true);
  assert.equal(cardMatchesPool(rtx(), { pci: '0000:C5:00.0' }), true);
  assert.equal(cardMatchesPool(rtx(), { pci: '0000:c6:00.0' }), false);
});

test('a name selector is a case-insensitive substring of the resolved name', () => {
  assert.equal(cardMatchesPool(rtx(), { name: 'rtx 3090' }), true);
  assert.equal(cardMatchesPool(rtx(), { name: 'NVIDIA' }), true);
  assert.equal(cardMatchesPool(rtx(), { name: 'Radeon' }), false);
});

test('selectors present are ANDed, and selectors omitted are ignored', () => {
  assert.equal(cardMatchesPool(rtx(), { pciId: '10de:2204', name: 'RTX 3090' }), true);
  assert.equal(cardMatchesPool(rtx(), { pciId: '10de:2204', name: 'RTX 4090' }), false);
  assert.equal(cardMatchesPool(rtx(), { pciId: '10de:2204', pci: '0000:c9:00.0' }), false);
});

test('an empty or missing match matches NOTHING, never everything', () => {
  // The dangerous failure in this module is a pool that quietly swallows every
  // card in the machine, so the vacuous-truth reading of "all selectors pass" is
  // deliberately not the one implemented.
  assert.equal(cardMatchesPool(rtx(), {}), false);
  assert.equal(cardMatchesPool(rtx(), null), false);
  assert.equal(cardMatchesPool(rtx(), undefined), false);
  assert.equal(cardMatchesPool(apu(), {}), false);
});

test('a selector a card cannot answer for does not match it', () => {
  const nameless = { card: 'card0', available: true };
  assert.equal(cardMatchesPool(nameless, { name: 'rtx' }), false);
  assert.equal(cardMatchesPool(nameless, { pciId: '10de:2204' }), false);
  assert.equal(cardMatchesPool(nameless, { pci: '0000:c5:00.0' }), false);
});

/* ------------------------------------------------------------- resolution -- */

const POOLS = [
  { id: 'igpu', label: 'Radeon 8060S (APU)', match: { pciId: '1002:1586' } },
  { id: 'rtx3090', label: 'RTX 3090 (OCuLink)', match: { pciId: '10de:2204' } },
];

/*
 * THE FIRST REGRESSION THIS MODULE EXISTS FOR.
 *
 * DRM indices are assigned in kernel enumeration order, so an OCuLink card can
 * come up as card0 on one boot and card1 on the next. A pool keyed on the DRM
 * index would hand a model the wrong GPU across a reboot with nothing changed.
 */
test('a DRM reorder does not change which pool owns which card', () => {
  const before = resolvePools(POOLS, [apu('card0'), rtx('card1')]);
  const after = resolvePools(POOLS, [rtx('card0'), apu('card1')]);

  assert.equal(before.find((p) => p.id === 'rtx3090').cards[0].card, 'card1');
  assert.equal(after.find((p) => p.id === 'rtx3090').cards[0].card, 'card0');
  for (const id of ['igpu', 'rtx3090']) {
    assert.equal(before.find((p) => p.id === id).capacity, 1);
    assert.equal(after.find((p) => p.id === id).capacity, 1);
    assert.deepEqual(after.find((p) => p.id === id).warnings, []);
  }
});

/*
 * THE SECOND REGRESSION.
 *
 * An OCuLink card can be re-plugged into a different port and come back at a
 * different PCI address. Keying on the slot would silently empty the pool; the
 * card's class is what actually survives the move.
 */
test('a card matched by class survives being re-plugged into another slot', () => {
  const before = resolvePools(POOLS, [apu(), rtx('card1', '0000:c5:00.0')]);
  const after = resolvePools(POOLS, [apu(), rtx('card1', '0000:63:00.0')]);
  const pool = (list) => list.find((p) => p.id === 'rtx3090');

  assert.equal(pool(before).capacity, 1);
  assert.equal(pool(after).capacity, 1, 'a new slot is not a missing card');
  assert.equal(pool(after).cards[0].pci, '0000:63:00.0');
  assert.deepEqual(pool(after).warnings, []);
});

test('two cards of the same class are capacity, not an ambiguity', () => {
  const pools = resolvePools(POOLS, [apu(), rtx('card1', '0000:c5:00.0'), rtx('card2', '0000:c9:00.0')]);
  const rtxPool = pools.find((p) => p.id === 'rtx3090');

  assert.equal(rtxPool.capacity, 2);
  assert.equal(rtxPool.cards.length, 2);
  assert.deepEqual(rtxPool.warnings, [], 'a second identical card is normal, not a fault');
});

test('a pool matching no present card reports capacity 0 and says so by name', () => {
  const pools = resolvePools(POOLS, [apu()]);
  const rtxPool = pools.find((p) => p.id === 'rtx3090');

  assert.equal(rtxPool.capacity, 0);
  assert.deepEqual(rtxPool.cards, []);
  assert.equal(rtxPool.warnings.length, 1);
  assert.match(rtxPool.warnings[0], /rtx3090/);
});

test('a pool with no selectors matches nothing and is reported, not silently empty', () => {
  const pools = resolvePools([{ id: 'catchall' }], [apu(), rtx()]);

  assert.equal(pools[0].capacity, 0);
  assert.deepEqual(pools[0].cards, [], 'an empty match must never mean "every card"');
  assert.equal(pools[0].warnings.length, 1);
  assert.match(pools[0].warnings[0], /catchall/);
  assert.match(pools[0].warnings[0], /selector/i);
});

test('a card with no driver bound is present in the pool but is not capacity', () => {
  const unbound = { ...rtx(), driver: '', available: false, reason: 'no kernel driver is bound to it' };
  const pools = resolvePools(POOLS, [apu(), unbound]);
  const rtxPool = pools.find((p) => p.id === 'rtx3090');

  assert.equal(rtxPool.cards.length, 1, 'hardware that is physically there must not vanish from the readout');
  assert.equal(rtxPool.cards[0].available, false);
  assert.match(rtxPool.cards[0].reason, /driver/);
  assert.equal(rtxPool.capacity, 0, 'a card nothing can execute on is not capacity');
  assert.equal(rtxPool.warnings.length, 1);
  assert.match(rtxPool.warnings[0], /rtx3090/);
});

test('two pools matching the same card: the first in config order wins, both are told', () => {
  const overlapping = [
    { id: 'by-class', match: { pciId: '10de:2204' } },
    { id: 'by-slot', match: { pci: '0000:c5:00.0' } },
  ];
  const pools = resolvePools(overlapping, [apu(), rtx()]);

  assert.equal(pools[0].id, 'by-class');
  assert.equal(pools[0].capacity, 1, 'config order decides, so the outcome is deterministic');
  assert.equal(pools[1].capacity, 0);
  assert.deepEqual(pools[1].cards, []);
  for (const pool of pools) {
    assert.equal(pool.warnings.length, 1, 'both sides of a collision must hear about it');
    assert.match(pool.warnings[0], /by-class/);
    assert.match(pool.warnings[0], /by-slot/);
    assert.match(pool.warnings[0], /card1/);
  }
});

test('resolvePools validates its entries rather than resolving a broken one', () => {
  assert.throws(() => resolvePools([{ match: { name: 'rtx' } }], [rtx()]), TypeError);
});

test('resolvePools copes with no pools and no cards', () => {
  assert.deepEqual(resolvePools([], [rtx()]), []);
  assert.deepEqual(resolvePools(null, null), []);
  const pools = resolvePools(POOLS, []);
  assert.equal(pools.length, 2);
  assert.equal(pools[0].capacity, 0);
});

/* ------------------------------------------------------------- ownership -- */

test('poolForCard names the pool that owns a card, and null for one nothing claims', () => {
  const stray = {
    card: 'card9',
    name: 'Intel Arc A770',
    available: true,
    pci: '0000:03:00.0',
    vendorId: '0x8086',
    deviceId: '0x56a0',
  };
  const pools = resolvePools(POOLS, [apu(), rtx(), stray]);

  assert.equal(poolForCard(pools, rtx()).id, 'rtx3090');
  assert.equal(poolForCard(pools, apu()).id, 'igpu');
  assert.equal(poolForCard(pools, stray), null);
  assert.equal(poolForCard([], rtx()), null);
  assert.equal(poolForCard(pools, null), null);
});

test('poolForCard identifies a card by slot when the DRM index has moved', () => {
  // The reservation layer holds a card across a rescan, and the DRM index it was
  // granted under can be gone by then; the PCI address it was granted at is not.
  const pools = resolvePools(POOLS, [apu('card0'), rtx('card1')]);
  assert.equal(poolForCard(pools, { pci: '0000:C5:00.0' }).id, 'rtx3090');
});
