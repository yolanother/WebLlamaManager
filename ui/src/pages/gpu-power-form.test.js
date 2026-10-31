// Llama Manager — tests for the GPU power-cap schedule form's state mapping.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Pins how the Settings > GPUs power-cap form turns the stored `gpuPower`
// setting into editable text fields and back: numbers become numbers again, an
// empty day selection means "every day" and is omitted, and an unconfigured
// box starts as a disabled form with no windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formFromSettings, bodyFromForm, WEEKDAYS } from './gpu-power-form.js';

test('an unconfigured box starts disabled with no windows', () => {
  assert.deepEqual(formFromSettings(undefined), { enabled: false, defaultWatts: '', timezone: '', windows: [] });
});

test('stored settings round-trip through the form', () => {
  const stored = {
    enabled: true, defaultWatts: 300, timezone: 'America/Los_Angeles',
    windows: [
      { start: '22:00', end: '06:00', watts: 420, days: ['fri', 'sat'] },
      { start: '12:00', end: '13:00', watts: 350 },
    ],
  };
  const form = formFromSettings(stored);
  assert.equal(form.defaultWatts, '300');
  assert.deepEqual(form.windows[1].days, []);
  assert.deepEqual(bodyFromForm(form), stored);
});

test('blank default watts is sent as null so the server can reject enabling without one', () => {
  assert.equal(bodyFromForm({ enabled: true, defaultWatts: ' ', timezone: '', windows: [] }).defaultWatts, null);
});

test('weekday keys match the server', () => {
  assert.deepEqual(WEEKDAYS, ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
});
