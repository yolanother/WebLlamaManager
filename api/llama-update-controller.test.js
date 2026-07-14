// Llama Manager — package-safe llama.cpp update controller tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests prove package installations reject source updates before any
// service stop or git/cmake/distrobox launch and preserve source-mode behavior.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  beginLlamaUpdate,
  createLlamaSourceUpdateSpec,
} from './llama-update-controller.js';
import { resolveDistributionPolicy } from './distribution-policy.js';

const API_DIR = dirname(fileURLToPath(import.meta.url));

test('package mode rejects before stopping the service or starting a source build', async () => {
  const effects = [];
  const result = await beginLlamaUpdate({
    policy: resolveDistributionPolicy({ LLAMA_MANAGER_PACKAGED: '1' }),
    updateInProgress: false,
    serverRunning: true,
    stopServer: async () => effects.push('stop-server'),
    startSourceUpdate: () => effects.push('spawn-git-cmake-distrobox'),
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'PACKAGE_MANAGED');
  assert.deepEqual(effects, []);
});

test('source mode stops a running server before starting the existing updater', async () => {
  const effects = [];
  const result = await beginLlamaUpdate({
    policy: resolveDistributionPolicy({}),
    updateInProgress: false,
    serverRunning: true,
    stopServer: async () => effects.push('stop-server'),
    startSourceUpdate: () => effects.push('spawn-source-update'),
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { success: true, message: 'Update started' });
  assert.deepEqual(effects, ['stop-server', 'spawn-source-update']);
});

test('source update spec uses HOME-derived checkout as positional argv without a developer path', () => {
  const spec = createLlamaSourceUpdateSpec(
    { HOME: '/srv/llama-manager' },
    { distrobox: '/usr/local/bin/distrobox', containerName: 'llama-rocm' },
  );

  assert.deepEqual(spec.command, '/usr/local/bin/distrobox');
  assert.equal(spec.args.at(-1), '/srv/llama-manager/llama.cpp');
  assert.match(spec.args.at(-3), /cd -- "\$1"/);
  assert.doesNotMatch(JSON.stringify(spec), /\/home\/yolan/);
});

test('the management API contains no developer-specific home path', () => {
  const serverSource = readFileSync(join(API_DIR, 'server.js'), 'utf8');
  assert.doesNotMatch(serverSource, /\/home\/yolan/);
});
