// Llama Manager — kiosk system-login UI contract tests.
// Copyright (c) Llama Manager project. See the LICENSE file in the repository
// root for license terms.
//
// Verifies that the browser-side action is available only to an appliance-local
// dashboard and always targets the separate loopback helper rather than the
// remotely reachable Llama Manager API.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalKioskHost, requestSystemLogin } from './kiosk-control.js';

test('system login UI is limited to localhost dashboard hosts', () => {
  assert.equal(isLocalKioskHost('localhost'), true);
  assert.equal(isLocalKioskHost('127.0.0.1'), true);
  assert.equal(isLocalKioskHost('appliance.example'), false);
  assert.equal(isLocalKioskHost('192.168.1.40'), false);
});

test('local system login posts only to the loopback helper', async () => {
  const requests = [];
  const fetchImpl = async (...args) => {
    requests.push(args);
    return { ok: true };
  };

  await requestSystemLogin({ hostname: 'localhost', fetchImpl });
  assert.deepEqual(requests, [['http://127.0.0.1:8798/system-login', { method: 'POST' }]]);
});

test('remote dashboard host cannot issue a system login request', async () => {
  let called = false;
  await assert.rejects(
    requestSystemLogin({
      hostname: 'appliance.example',
      fetchImpl: async () => { called = true; return { ok: true }; },
    }),
    /available only on the appliance-local dashboard/,
  );
  assert.equal(called, false);
});
