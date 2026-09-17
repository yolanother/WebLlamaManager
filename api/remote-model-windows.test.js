/**
 * @file remote-model-windows.test.js
 * @copyright Use of this file is governed by the LICENSE file in the repository root.
 *
 * Specifies that a backend's advertised context windows survive the probe that
 * reads them. An alias whose target lives on another host can only advertise a
 * window this box has actually been told, so discarding the window at probe time
 * makes every remote-target alias permanently unbounded — the caller then falls
 * back to a stale default and under-uses a model by a wide margin.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { remoteModelWindows } from './remote-model-windows.js';

test('remoteModelWindows: keeps the window each model reports', () => {
  const windows = remoteModelWindows({
    data: [
      { id: 'big', n_ctx: 262144 },
      { id: 'small', n_ctx: 65536 },
    ],
  });

  assert.deepEqual(windows, { big: 262144, small: 65536 });
});

test('remoteModelWindows: omits a model that reports no usable window', () => {
  // Absent, null, zero and nonsense all mean "unknown", and an alias that treats
  // unknown as a number would advertise a bound it cannot honour.
  const windows = remoteModelWindows({
    data: [
      { id: 'known', n_ctx: 32768 },
      { id: 'missing' },
      { id: 'null', n_ctx: null },
      { id: 'zero', n_ctx: 0 },
      { id: 'text', n_ctx: 'lots' },
      { id: 'negative', n_ctx: -1 },
    ],
  });

  assert.deepEqual(windows, { known: 32768 });
});

test('remoteModelWindows: tolerates every shape a backend might answer with', () => {
  assert.deepEqual(remoteModelWindows(null), {});
  assert.deepEqual(remoteModelWindows({}), {});
  assert.deepEqual(remoteModelWindows({ data: 'nope' }), {});
  assert.deepEqual(remoteModelWindows({ models: [{ id: 'm', n_ctx: 8192 }] }), { m: 8192 });
  assert.deepEqual(remoteModelWindows({ data: ['bare-string'] }), {});
});
