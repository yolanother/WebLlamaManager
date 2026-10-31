// Llama Manager — tests for the config-write request guard.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// configWriteTrusted protects the loopback-only config keys (strata, podsRelease)
// from a browser on the host: a cross-origin page (CSRF) sends a foreign Origin,
// and a DNS-rebinding page reaches 127.0.0.1 under its own host name. Only a Host
// that is a local name or an IP literal, with no Origin or a same-host Origin, passes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configWriteTrusted } from './config-write-guard.js';

const localNames = ['localhost', 'drakemore', 'drakemore.local'];

test('curl and the manager UI on a local name or IP pass', () => {
  for (const [host, origin] of [['127.0.0.1:3001', undefined], ['localhost:3001', 'http://localhost:3001'],
    ['drakemore:3001', 'http://drakemore:3001'], ['[::1]:3001', undefined], ['192.168.1.79:3001', 'http://192.168.1.79:3001'],
    ['DRAKEMORE.local:3001', undefined]]) {
    assert.equal(configWriteTrusted({ host, origin, localNames }).ok, true, `${host} ${origin}`);
  }
});

test('a cross-origin page (CSRF) is refused', () => {
  const r = configWriteTrusted({ host: '127.0.0.1:3001', origin: 'https://evil.example', localNames });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Origin/);
  assert.equal(configWriteTrusted({ host: '127.0.0.1:3001', origin: 'null', localNames }).ok, false, 'opaque origin');
  assert.equal(configWriteTrusted({ host: '127.0.0.1:3001', origin: 'http://127.0.0.1:8080', localNames }).ok, false, 'another local port is another origin');
});

test('a DNS-rebinding host name is refused even with a matching Origin', () => {
  const r = configWriteTrusted({ host: 'rebind.evil.example:3001', origin: 'http://rebind.evil.example:3001', localNames });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Host/);
  assert.equal(configWriteTrusted({ host: undefined, localNames }).ok, false, 'no Host header');
});

// ── configUpdateRefusal: what POST /api/config enforces (review LOW: test the refusal, not names) ──
import { configUpdateRefusal } from './config-write-guard.js';

const req = (over = {}) => ({ loopback: true, host: '127.0.0.1:3001', origin: undefined, localNames, ...over });

test('configUpdateRefusal: podsRelease from off-box is 403 NOT_LOOPBACK', () => {
  const r = configUpdateRefusal({ updates: { podsRelease: { enabled: true } }, ...req({ loopback: false }) });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'NOT_LOOPBACK');
});

test('configUpdateRefusal: strata or podsRelease from a foreign Origin or a rebinding Host is 403 UNTRUSTED_ORIGIN', () => {
  for (const updates of [{ podsRelease: { enabled: true } }, { strata: {} }]) {
    assert.equal(configUpdateRefusal({ updates, ...req({ origin: 'https://evil.example' }) }).body.code, 'UNTRUSTED_ORIGIN');
    assert.equal(configUpdateRefusal({ updates, ...req({ host: 'rebind.evil.example:3001' }) }).body.code, 'UNTRUSTED_ORIGIN');
  }
});

test('configUpdateRefusal: podsRelease may not carry coordinatorUrl, nodeId or anything but enabled/minIdleSec', () => {
  for (const pr of [{ coordinatorUrl: 'https://attacker.example' }, { enabled: true, nodeId: 'x' }, 'on', null]) {
    const r = configUpdateRefusal({ updates: { podsRelease: pr }, ...req() });
    assert.equal(r.status, 400, JSON.stringify(pr));
    assert.equal(r.body.code, 'PODS_RELEASE_FIELD');
  }
});

test('configUpdateRefusal: allowed writes pass (negative control)', () => {
  assert.equal(configUpdateRefusal({ updates: { podsRelease: { enabled: true, minIdleSec: 900 } }, ...req() }), null);
  assert.equal(configUpdateRefusal({ updates: { strata: {} }, ...req({ origin: 'http://127.0.0.1:3001' }) }), null);
  assert.equal(configUpdateRefusal({ updates: { contextSize: 8192 }, ...req({ loopback: false, origin: 'https://ui.example', host: 'ui.example' }) }), null,
    'other settings are untouched by this guard');
});
