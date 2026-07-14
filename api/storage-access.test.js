// Llama Manager — service-identity model storage policy tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests specify conservative POSIX permission checks used before model
// storage is changed, including traversal of every ancestor directory.

import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceIdentityCanUseDirectory } from './storage-access.js';

test('rejects a directory writable by the operator but not the service identity', () => {
  const result = serviceIdentityCanUseDirectory({
    serviceUid: 990,
    serviceGids: [990],
    components: [
      { path: '/', uid: 0, gid: 0, mode: 0o755, isDirectory: true },
      { path: '/mnt', uid: 0, gid: 0, mode: 0o755, isDirectory: true },
      { path: '/mnt/models', uid: 1000, gid: 1000, mode: 0o700, isDirectory: true },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.path, '/mnt/models');
  assert.match(result.reason, /read, write, and traverse/i);
});

test('accepts setgid group storage shared with the service', () => {
  const result = serviceIdentityCanUseDirectory({
    serviceUid: 990,
    serviceGids: [990, 44],
    components: [
      { path: '/', uid: 0, gid: 0, mode: 0o755, isDirectory: true },
      { path: '/mnt', uid: 0, gid: 0, mode: 0o755, isDirectory: true },
      { path: '/mnt/models', uid: 1000, gid: 990, mode: 0o2770, isDirectory: true },
    ],
  });

  assert.deepEqual(result, { ok: true });
});

test('rejects an inaccessible ancestor even when the target mode is shared', () => {
  const result = serviceIdentityCanUseDirectory({
    serviceUid: 990,
    serviceGids: [990],
    components: [
      { path: '/', uid: 0, gid: 0, mode: 0o755, isDirectory: true },
      { path: '/private', uid: 1000, gid: 1000, mode: 0o700, isDirectory: true },
      { path: '/private/models', uid: 1000, gid: 990, mode: 0o2770, isDirectory: true },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.path, '/private');
  assert.match(result.reason, /ancestor/i);
});
