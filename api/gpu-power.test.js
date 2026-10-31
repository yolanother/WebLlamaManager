/**
 * Copyright (c) Llama Manager project. Use of this file is governed by the
 * LICENSE file in the repository root.
 *
 * Specifies the GPU power-cap schedule: which cap applies at a given instant
 * (default outside every window, highest watts where windows overlap, windows
 * crossing midnight, per-day windows, evaluated in an IANA timezone), how the
 * setting is validated against the card's own limits, how nvidia-smi output is
 * read, and how the controller enforces the cap -- only touching the card when
 * the target differs, logging each change, and failing safe to the default cap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGpuPowerSettings,
  resolveGpuPowerTarget,
  parsePowerQuery,
  createGpuPowerController,
} from './gpu-power.js';

const LA = 'America/Los_Angeles';
// 2026-10-30 is a Friday. PDT (UTC-7) until 2026-11-01 02:00 local.
const at = (iso) => new Date(iso);
const settings = (over = {}) => ({ enabled: true, defaultWatts: 300, timezone: LA, windows: [], ...over });

// ---------- resolveGpuPowerTarget ----------

test('outside every window the default cap applies', () => {
  const s = settings({ windows: [{ start: '01:00', end: '05:00', watts: 400 }] });
  const r = resolveGpuPowerTarget(s, at('2026-10-30T19:00:00Z')); // 12:00 PDT
  assert.equal(r.watts, 300);
  assert.equal(r.window, null);
});

test('no windows means the default cap and no next change', () => {
  const r = resolveGpuPowerTarget(settings(), at('2026-10-30T19:00:00Z'));
  assert.equal(r.watts, 300);
  assert.equal(r.nextChange, null);
});

test('a window is evaluated in the configured timezone, not UTC', () => {
  const s = settings({ windows: [{ start: '01:00', end: '05:00', watts: 400 }] });
  // 09:00 UTC = 02:00 PDT -> inside; in UTC it would be outside.
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-30T09:00:00Z')).watts, 400);
  // 02:00 UTC = 19:00 PDT the previous day -> outside; in UTC it would be inside.
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-30T02:00:00Z')).watts, 300);
});

test('start is inclusive and end is exclusive', () => {
  const s = settings({ windows: [{ start: '01:00', end: '05:00', watts: 400 }] });
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-30T08:00:00Z')).watts, 400); // 01:00 PDT
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-30T11:59:00Z')).watts, 400); // 04:59
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-30T12:00:00Z')).watts, 300); // 05:00
});

test('a window crossing midnight covers both sides of it', () => {
  const s = settings({ windows: [{ start: '22:00', end: '06:00', watts: 420 }] });
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-31T05:30:00Z')).watts, 420); // Fri 22:30
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-31T10:00:00Z')).watts, 420); // Sat 03:00
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-31T13:00:00Z')).watts, 300); // Sat 06:00
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-31T04:59:00Z')).watts, 300); // Fri 21:59
});

test('days name the day a window starts on, including its after-midnight tail', () => {
  const s = settings({ windows: [{ start: '22:00', end: '06:00', watts: 420, days: ['fri'] }] });
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-31T05:30:00Z')).watts, 420); // Fri 22:30
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-31T10:00:00Z')).watts, 420); // Sat 03:00, Fri's tail
  assert.equal(resolveGpuPowerTarget(s, at('2026-11-01T05:30:00Z')).watts, 300); // Sat 22:30, not listed
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-30T10:00:00Z')).watts, 300); // Fri 03:00, Thu's tail
});

test('a same-day window honours its day list', () => {
  const s = settings({ windows: [{ start: '09:00', end: '17:00', watts: 380, days: ['sat', 'sun'] }] });
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-30T19:00:00Z')).watts, 300); // Fri 12:00
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-31T19:00:00Z')).watts, 380); // Sat 12:00
});

test('equal start and end is a full 24 hours from the start', () => {
  const s = settings({ windows: [{ start: '00:00', end: '00:00', watts: 400, days: ['sat'] }] });
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-31T07:00:00Z')).watts, 400); // Sat 00:00
  assert.equal(resolveGpuPowerTarget(s, at('2026-11-01T06:59:00Z')).watts, 400); // Sat 23:59
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-31T06:59:00Z')).watts, 300); // Fri 23:59
});

test('overlapping windows take the highest watts and report that window', () => {
  const s = settings({
    windows: [
      { start: '00:00', end: '08:00', watts: 350 },
      { start: '02:00', end: '04:00', watts: 420 },
      { start: '03:00', end: '05:00', watts: 380 },
    ],
  });
  const r = resolveGpuPowerTarget(s, at('2026-10-30T10:30:00Z')); // 03:30 PDT
  assert.equal(r.watts, 420);
  assert.equal(r.window.index, 1);
});

test('a window below the default still applies inside its hours', () => {
  const s = settings({ windows: [{ start: '12:00', end: '13:00', watts: 200 }] });
  assert.equal(resolveGpuPowerTarget(s, at('2026-10-30T19:30:00Z')).watts, 200);
});

test('next change names when and to what the cap moves', () => {
  const s = settings({ windows: [{ start: '22:00', end: '06:00', watts: 420 }] });
  const before = resolveGpuPowerTarget(s, at('2026-10-30T19:00:00Z')); // Fri 12:00 PDT
  assert.deepEqual(before.nextChange, { at: '2026-10-31T05:00:00.000Z', watts: 420 });
  const inside = resolveGpuPowerTarget(s, at('2026-10-31T05:30:00Z'));
  assert.deepEqual(inside.nextChange, { at: '2026-10-31T13:00:00.000Z', watts: 300 });
});

test('next change follows the DST shift in the configured timezone', () => {
  // PDT ends 2026-11-01 02:00 local; 06:00 PST on Nov 1 is 14:00 UTC, not 13:00.
  const s = settings({ windows: [{ start: '22:00', end: '06:00', watts: 420 }] });
  const r = resolveGpuPowerTarget(s, at('2026-11-01T05:30:00Z')); // Sat 22:30 PDT
  assert.deepEqual(r.nextChange, { at: '2026-11-01T14:00:00.000Z', watts: 300 });
});

test('an invalid timezone throws so the caller can fail safe', () => {
  assert.throws(() => resolveGpuPowerTarget(settings({ timezone: 'Mars/Olympus' }), new Date()));
});

test('an empty timezone uses the system timezone', () => {
  const r = resolveGpuPowerTarget(settings({ timezone: '' }), new Date());
  assert.equal(r.watts, 300);
  assert.equal(r.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

// ---------- normalizeGpuPowerSettings ----------

test('a valid setting is normalized', () => {
  const n = normalizeGpuPowerSettings({
    enabled: true, defaultWatts: 300, timezone: LA,
    windows: [{ start: '22:00', end: '06:00', watts: 420, days: ['FRI', 'sat'] }],
  });
  assert.deepEqual(n, {
    enabled: true, defaultWatts: 300, timezone: LA,
    windows: [{ start: '22:00', end: '06:00', watts: 420, days: ['fri', 'sat'] }],
  });
});

test('omitted fields take safe defaults: disabled, system timezone, no windows', () => {
  assert.deepEqual(normalizeGpuPowerSettings({ defaultWatts: 300 }),
    { enabled: false, defaultWatts: 300, timezone: '', windows: [] });
});

test('enabling without a default cap is rejected', () => {
  assert.throws(() => normalizeGpuPowerSettings({ enabled: true }), /defaultWatts/);
});

for (const [label, input, pattern] of [
  ['non-object', 'x', /object/],
  ['non-boolean enabled', { enabled: 'yes', defaultWatts: 300 }, /enabled/],
  ['fractional watts', { defaultWatts: 300.5 }, /defaultWatts/],
  ['zero watts', { defaultWatts: 0 }, /defaultWatts/],
  ['unknown timezone', { defaultWatts: 300, timezone: 'Mars/Olympus' }, /timezone/],
  ['windows not array', { defaultWatts: 300, windows: {} }, /windows/],
  ['bad start', { defaultWatts: 300, windows: [{ start: '24:00', end: '01:00', watts: 400 }] }, /windows\[0\]\.start/],
  ['bad end', { defaultWatts: 300, windows: [{ start: '01:00', end: '1:00', watts: 400 }] }, /windows\[0\]\.end/],
  ['bad window watts', { defaultWatts: 300, windows: [{ start: '01:00', end: '02:00', watts: '400' }] }, /windows\[0\]\.watts/],
  ['bad day', { defaultWatts: 300, windows: [{ start: '01:00', end: '02:00', watts: 400, days: ['funday'] }] }, /windows\[0\]\.days/],
  ['empty days', { defaultWatts: 300, windows: [{ start: '01:00', end: '02:00', watts: 400, days: [] }] }, /windows\[0\]\.days/],
]) {
  test(`rejects ${label}`, () => {
    assert.throws(() => normalizeGpuPowerSettings(input), pattern);
  });
}

test('watts outside the card range are rejected with the range named', () => {
  const limits = { min: 100, max: 450 };
  assert.throws(() => normalizeGpuPowerSettings({ defaultWatts: 500 }, { limits }), /100.*450/);
  assert.throws(() => normalizeGpuPowerSettings({ defaultWatts: 50 }, { limits }), /100.*450/);
  assert.throws(() => normalizeGpuPowerSettings(
    { defaultWatts: 300, windows: [{ start: '01:00', end: '02:00', watts: 460 }] }, { limits }),
  /windows\[0\]\.watts.*100.*450/);
  assert.equal(normalizeGpuPowerSettings({ defaultWatts: 450 }, { limits }).defaultWatts, 450);
});

// ---------- parsePowerQuery ----------

test('nvidia-smi power query rows are parsed into numbers', () => {
  const out = 'GPU-83ea, NVIDIA GeForce RTX 3090, 300.00, 100.00, 450.00, 188.88\n';
  assert.deepEqual(parsePowerQuery(out), [
    { uuid: 'GPU-83ea', name: 'NVIDIA GeForce RTX 3090', limit: 300, min: 100, max: 450, draw: 188.88 },
  ]);
});

test('[N/A] readings parse as null and blank lines are ignored', () => {
  const out = 'GPU-1, Card, [N/A], [N/A], [N/A], [N/A]\n\n';
  assert.deepEqual(parsePowerQuery(out), [
    { uuid: 'GPU-1', name: 'Card', limit: null, min: null, max: null, draw: null },
  ]);
});

// ---------- controller ----------

/** Builds a controller around a fake card whose limit apply() really changes. */
function fakeRig({ limit = 420, settings: s = settings(), now = at('2026-10-30T19:00:00Z'), run, apply } = {}) {
  const card = { limit };
  const applied = [];
  const logs = [];
  const state = { settings: s, now };
  const controller = createGpuPowerController({
    getSettings: () => state.settings,
    now: () => state.now,
    log: (line) => logs.push(line),
    run: run || (async () => `GPU-a, RTX 3090, ${card.limit.toFixed(2)}, 100.00, 450.00, 188.00\n`),
    apply: apply || (async (watts) => { applied.push(watts); card.limit = watts; }),
  });
  return { controller, card, applied, logs, state };
}

test('the controller lowers an over-limit card to the default and logs it', async () => {
  const rig = fakeRig({ limit: 420 });
  const status = await rig.controller.tick('start');
  assert.deepEqual(rig.applied, [300]);
  assert.equal(status.targetWatts, 300);
  assert.equal(rig.logs.length, 1);
  assert.match(rig.logs[0], /420 W -> 300 W/);
  assert.match(rig.logs[0], /start/);
  assert.match(rig.logs[0], /default/);
});

test('the controller leaves a card alone when it is already at the target', async () => {
  const rig = fakeRig({ limit: 300 });
  await rig.controller.tick('minute');
  assert.deepEqual(rig.applied, []);
  assert.deepEqual(rig.logs, []);
});

test('the controller raises inside a window, names the window, and restores after it', async () => {
  const rig = fakeRig({
    limit: 300,
    settings: settings({ windows: [{ start: '12:00', end: '12:02', watts: 320 }] }),
    now: at('2026-10-30T19:00:30Z'), // 12:00:30 PDT
  });
  let status = await rig.controller.tick('minute');
  assert.deepEqual(rig.applied, [320]);
  assert.equal(status.activeWindow.index, 0);
  assert.match(rig.logs[0], /300 W -> 320 W.*12:00-12:02/);
  rig.state.now = at('2026-10-30T19:02:05Z');
  status = await rig.controller.tick('minute');
  assert.deepEqual(rig.applied, [320, 300]);
  assert.equal(status.activeWindow, null);
});

test('the target is clamped to the card range', async () => {
  // A hand-edited config can bypass API validation; the card range still wins.
  const rig = fakeRig({ limit: 300, settings: settings({ defaultWatts: 600 }) });
  const status = await rig.controller.tick('minute');
  assert.deepEqual(rig.applied, [450]);
  assert.equal(status.targetWatts, 450);
});

test('a broken schedule fails safe to the default cap', async () => {
  const rig = fakeRig({ limit: 420, settings: settings({ timezone: 'Mars/Olympus', windows: [{ start: '00:00', end: '00:00', watts: 450 }] }) });
  const status = await rig.controller.tick('minute');
  assert.deepEqual(rig.applied, [300]);
  assert.match(status.lastError, /timezone|Mars/i);
});

test('a disabled schedule never touches the card', async () => {
  const rig = fakeRig({ limit: 420, settings: settings({ enabled: false }) });
  const status = await rig.controller.tick('minute');
  assert.deepEqual(rig.applied, []);
  assert.equal(status.enabled, false);
});

test('a box without nvidia-smi reports it and does nothing', async () => {
  const rig = fakeRig({ run: async () => { throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' }); } });
  const status = await rig.controller.tick('start');
  assert.deepEqual(rig.applied, []);
  assert.equal(status.available, false);
  assert.match(status.reason, /nvidia-smi/);
});

test('a box with no NVIDIA card reports it and does nothing', async () => {
  const rig = fakeRig({ run: async () => '' });
  const status = await rig.controller.tick('start');
  assert.deepEqual(rig.applied, []);
  assert.equal(status.available, false);
  assert.match(status.reason, /no NVIDIA/i);
});

test('a failed apply is reported and retried on the next tick', async () => {
  let fail = true;
  const applied = [];
  const rig = fakeRig({
    limit: 420,
    apply: async (w) => { if (fail) throw new Error('polkit denied'); applied.push(w); },
  });
  let status = await rig.controller.tick('start');
  assert.match(status.lastError, /polkit denied/);
  assert.match(rig.logs.join('\n'), /failed/);
  fail = false;
  status = await rig.controller.tick('minute');
  assert.deepEqual(applied, [300]);
  assert.equal(status.lastError, null);
});

test('status reports cards, current limit and draw, next change, and card range', async () => {
  const rig = fakeRig({ limit: 300, settings: settings({ windows: [{ start: '22:00', end: '06:00', watts: 420 }] }) });
  const status = await rig.controller.tick('status');
  assert.equal(status.available, true);
  assert.deepEqual(status.cards, [{ uuid: 'GPU-a', name: 'RTX 3090', limitWatts: 300, minWatts: 100, maxWatts: 450, drawWatts: 188 }]);
  assert.deepEqual(status.range, { min: 100, max: 450 });
  assert.deepEqual(status.nextChange, { at: '2026-10-31T05:00:00.000Z', watts: 420 });
  assert.equal(status.timezone, LA);
  assert.equal(rig.controller.limits().max, 450);
});

test('overlapping ticks are serialized so one change is applied once', async () => {
  const rig = fakeRig({ limit: 420 });
  await Promise.all([rig.controller.tick('a'), rig.controller.tick('b')]);
  assert.deepEqual(rig.applied, [300]);
});
