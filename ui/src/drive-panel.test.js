// Llama Manager — drive panel view-model tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Covers ui/src/drive-panel.js. Fixtures are the real payload this box emits.
//
// The governing rule these tests encode: a storage readout must never err
// toward reassurance. Unknown reads as unknown, never as healthy; and a drive
// whose health simply has not been collected yet must not be dressed up as a
// clean bill of health.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveDrivePanel, resolveDriveAlerts, resolveLastCrash, DRIVE_WARN_C,
} from './drive-panel.js';

const HEALTHY = {
  drives: [
    { name: 'nvme0', model: 'Lexar SSD NQ790 2TB', serial: 'QBC838R008533P220C', smartAvailable: true,
      temperatureC: 34.9, criticalWarning: 0, availableSparePct: 100, availableSpareThresholdPct: 10,
      percentageUsedPct: 0, mediaErrors: 0, unsafeShutdowns: 22, powerOnHours: 29 },
    { name: 'nvme1', model: 'SPCC M.2 PCIe SSD', serial: '6346F71000002ELK', smartAvailable: true,
      temperatureC: 29.9, criticalWarning: 0, availableSparePct: 100, availableSpareThresholdPct: 10,
      percentageUsedPct: 3, mediaErrors: 0, unsafeShutdowns: 52, powerOnHours: 2158 },
  ],
  storageHealth: {
    snapshotAvailable: true, stale: false, generatedAt: '2026-09-09T17:26:24.625Z', ageMs: 184867,
    faults: { ioTimeout: 0, hungTask: 0, controllerNotReady: 0, resetFailure: 0, readOnlyRemount: 0, total: 0 },
    lastPanic: { epoch: 1788955227, isoTime: '2026-09-09T12:00:27.000Z',
      cause: 'nvme-controller-hang', markers: { nvme: 12, amdgpu: 0 }, hasDump: true },
  },
};

test('resolveDrivePanel names each drive by model, not by node', () => {
  // nvmeXnY numbering is not stable across boots on this hardware, so a tile
  // labeled "nvme1" could silently be a different physical disk after a reboot.
  const tiles = resolveDrivePanel(HEALTHY);
  assert.equal(tiles.length, 2);
  assert.equal(tiles[1].title, 'SPCC M.2 PCIe SSD');
  assert.equal(tiles[1].temperature, 29.9);
});

test('resolveDrivePanel renders nothing when there are no drives', () => {
  assert.deepEqual(resolveDrivePanel({}), []);
  assert.deepEqual(resolveDrivePanel({ drives: [] }), []);
});

test('a healthy machine raises no alerts', () => {
  assert.deepEqual(resolveDriveAlerts(HEALTHY), []);
});

test('critical_warning raises an alert', () => {
  const s = structuredClone(HEALTHY);
  s.drives[1].criticalWarning = 4;
  const alerts = resolveDriveAlerts(s);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'error');
  assert.match(alerts[0].message, /SPCC/);
});

test('spare falling to the threshold raises an alert', () => {
  const s = structuredClone(HEALTHY);
  s.drives[0].availableSparePct = 10; // equal to threshold — already too late to wait
  const alerts = resolveDriveAlerts(s);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /spare/i);
});

test('any media error raises an alert, because the healthy value is exactly zero', () => {
  const s = structuredClone(HEALTHY);
  s.drives[0].mediaErrors = 1;
  assert.equal(resolveDriveAlerts(s).length, 1);
});

test('overheating raises an alert at the documented ceiling', () => {
  const s = structuredClone(HEALTHY);
  s.drives[1].temperatureC = DRIVE_WARN_C + 1;
  const alerts = resolveDriveAlerts(s);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /°C/);
});

test('a missing snapshot reads as unknown and raises no alarm', () => {
  // A freshly flashed appliance has hwmon but no snapshot until the timer runs.
  // Alarming there would train operators to ignore the banner.
  const s = {
    drives: [{ name: 'nvme0', model: 'Lexar SSD NQ790 2TB', smartAvailable: false, temperatureC: 34.9,
      criticalWarning: null, availableSparePct: null, availableSpareThresholdPct: null,
      percentageUsedPct: null, mediaErrors: null, unsafeShutdowns: null, powerOnHours: null }],
    storageHealth: { snapshotAvailable: false, stale: false, faults: null, lastPanic: null },
  };
  assert.deepEqual(resolveDriveAlerts(s), []);
  const tiles = resolveDrivePanel(s);
  assert.equal(tiles[0].temperature, 34.9);
  assert.match(tiles[0].detail, /unknown/i);
});

test('null health fields never read as a passing value', () => {
  // The bug this guards: `mediaErrors: null` compared with `> 0` is false, which
  // would silently render an uncollected drive as clean.
  const s = structuredClone(HEALTHY);
  s.drives[0].mediaErrors = null;
  s.drives[0].criticalWarning = null;
  s.drives[0].smartAvailable = false;
  assert.deepEqual(resolveDriveAlerts(s), []);
  assert.match(resolveDrivePanel(s)[0].detail, /unknown/i);
});

test('a stale snapshot is called out rather than shown as current', () => {
  const s = structuredClone(HEALTHY);
  s.storageHealth.stale = true;
  const alerts = resolveDriveAlerts(s);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'warning');
  assert.match(alerts[0].message, /stale/i);
});

test('live controller faults raise the loudest alert', () => {
  // These are the signals that actually precede a lockup. If they are ever
  // non-zero the machine may be minutes from going down.
  const s = structuredClone(HEALTHY);
  s.storageHealth.faults = { ioTimeout: 2, hungTask: 1, controllerNotReady: 0, resetFailure: 0, readOnlyRemount: 0, total: 3 };
  const alerts = resolveDriveAlerts(s);
  assert.equal(alerts[0].severity, 'error');
  assert.match(alerts[0].message, /controller|fault|timeout/i);
});

test('resolveLastCrash reads the attributed cause in plain language', () => {
  const crash = resolveLastCrash(HEALTHY);
  assert.match(crash.label, /controller hang/i);
  assert.equal(crash.isoTime, '2026-09-09T12:00:27.000Z');
});

test('resolveLastCrash is null when the box has never panicked', () => {
  assert.equal(resolveLastCrash({ storageHealth: { lastPanic: null } }), null);
  assert.equal(resolveLastCrash({}), null);
});

test('an unattributable dump says so instead of naming a cause', () => {
  // 15 of 16 retained dumps on this box are empty shells. Guessing a cause from
  // an empty dump is how a previous investigation was misdirected for weeks.
  const s = structuredClone(HEALTHY);
  s.storageHealth.lastPanic = { epoch: 1786255512, isoTime: '2026-08-09T06:05:12.000Z',
    cause: 'unknown', markers: { nvme: 0, amdgpu: 0 }, hasDump: false };
  assert.match(resolveLastCrash(s).label, /unknown|not recorded|no dump/i);
});
