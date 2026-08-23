// Llama Manager — optional low-port mirror listener tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies the appliance's secondary HTTP listener boundary: how the mirror
// port is resolved from environment configuration (default 80, disableable,
// never colliding with the primary API port) and that a mirror bind failure —
// the unprivileged EACCES case on a dev machine — is logged and swallowed so
// the primary listener always keeps serving.

import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { resolveAltPort, listenBestEffort } from './alt-port.js';

test('mirror port defaults to 80', () => {
  assert.equal(resolveAltPort({ env: {}, primaryPort: 3001 }), 80);
});

test('mirror port is disableable', () => {
  assert.equal(resolveAltPort({ env: { ALT_PORT: '0' }, primaryPort: 3001 }), null);
  assert.equal(resolveAltPort({ env: { ALT_PORT: 'off' }, primaryPort: 3001 }), null);
  assert.equal(resolveAltPort({ env: { ALT_PORT: '' }, primaryPort: 3001 }), null);
});

test('mirror port is configurable', () => {
  assert.equal(resolveAltPort({ env: { ALT_PORT: '8080' }, primaryPort: 3001 }), 8080);
});

test('mirror port never duplicates the primary port', () => {
  assert.equal(resolveAltPort({ env: { ALT_PORT: '3001' }, primaryPort: 3001 }), null);
  assert.equal(resolveAltPort({ env: {}, primaryPort: '80' }), null);
});

test('garbage mirror port configuration disables the mirror', () => {
  assert.equal(resolveAltPort({ env: { ALT_PORT: 'yes please' }, primaryPort: 3001 }), null);
});

/** Minimal http.Server stand-in that records listen calls. */
class FakeServer extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
  }
  listen(port, host, cb) {
    this.calls.push([port, host]);
    this.onReady = cb;
  }
}

test('successful mirror bind is logged', () => {
  const server = new FakeServer();
  const logs = [];
  listenBestEffort({ server, port: 80, log: (m) => logs.push(m), warn: () => {} });
  server.onReady();
  assert.deepEqual(server.calls, [[80, '0.0.0.0']]);
  assert.match(logs.join('\n'), /80/);
});

test('mirror bind failure is warned about and never thrown', () => {
  const server = new FakeServer();
  const warns = [];
  listenBestEffort({ server, port: 80, log: () => {}, warn: (m) => warns.push(m) });
  const err = new Error('listen EACCES: permission denied 0.0.0.0:80');
  err.code = 'EACCES';
  server.emit('error', err);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /80/);
  assert.match(warns[0], /EACCES/);
});

test('mirror listen errors after startup stay swallowed', () => {
  const server = new FakeServer();
  const warns = [];
  listenBestEffort({ server, port: 80, log: () => {}, warn: (m) => warns.push(m) });
  server.emit('error', Object.assign(new Error('boom'), { code: 'EADDRINUSE' }));
  server.emit('error', Object.assign(new Error('boom again'), { code: 'EADDRINUSE' }));
  assert.equal(warns.length, 2);
});
