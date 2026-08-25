// Llama Manager — runtime filesystem path contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests specify the public path-resolution behavior shared by source
// checkouts and root-owned package installations. They verify observable path
// results without starting the API server or touching the host filesystem.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRuntimePaths } from './runtime-paths.js';

test('packaged installations use FHS locations for every mutable resource', () => {
  const paths = resolveRuntimePaths(
    { LLAMA_MANAGER_PACKAGED: '1' },
    { projectRoot: '/usr/lib/llama-manager', home: '/var/lib/llama-manager' },
  );

  assert.deepEqual(paths, {
    packaged: true,
    configDir: '/etc/llama-manager',
    configPath: '/etc/llama-manager/config.json',
    dataDir: '/var/lib/llama-manager',
    cacheDir: '/var/cache/llama-manager',
    modelsDir: '/var/lib/llama-manager/models',
    nodeNamePath: '/var/lib/llama-manager/node-name',
    ds4ModelsDir: '/var/lib/llama-manager/models/ds4',
    ds4StateDir: '/var/lib/llama-manager/ds4',
    slotCacheDir: '/var/cache/llama-manager/slots',
  });
});

test('source installations retain checkout and user-home defaults', () => {
  const paths = resolveRuntimePaths(
    {},
    { projectRoot: '/home/alice/src/llama-manager', home: '/home/alice' },
  );

  assert.deepEqual(paths, {
    packaged: false,
    configDir: '/home/alice/src/llama-manager',
    configPath: '/home/alice/src/llama-manager/config.json',
    dataDir: '/home/alice/src/llama-manager/data',
    cacheDir: '/home/alice/.cache/llama-manager',
    modelsDir: '/home/alice/models',
    nodeNamePath: '/home/alice/src/llama-manager/data/node-name',
    ds4ModelsDir: '/home/alice/models-ds4/deepseek-v4-gguf',
    ds4StateDir: '/home/alice/.local/share/ds4',
    slotCacheDir: '/home/alice/.cache/llama-slots',
  });
});

test('environment overrides relocate each mutable resource independently', () => {
  const paths = resolveRuntimePaths({
    LLAMA_MANAGER_PACKAGED: '1',
    LLAMA_MANAGER_CONFIG_DIR: '/mnt/config',
    CONFIG_PATH: '/mnt/config/custom.json',
    LLAMA_MANAGER_DATA_DIR: '/mnt/state',
    LLAMA_MANAGER_CACHE_DIR: '/mnt/cache',
    MODELS_DIR: '/models/general',
    DS4_GGUF_DIR: '/models/ds4',
    DS4_STATE_DIR: '/mnt/ds4-state',
    SLOT_SAVE_PATH: '/mnt/slot-cache',
  }, { projectRoot: '/opt/app', home: '/srv/user' });

  assert.equal(paths.configPath, '/mnt/config/custom.json');
  assert.equal(paths.dataDir, '/mnt/state');
  assert.equal(paths.cacheDir, '/mnt/cache');
  assert.equal(paths.modelsDir, '/models/general');
  assert.equal(paths.ds4ModelsDir, '/models/ds4');
  assert.equal(paths.ds4StateDir, '/mnt/ds4-state');
  assert.equal(paths.slotCacheDir, '/mnt/slot-cache');
});

test('the node name store lives beside the rest of the mutable state', () => {
  const packaged = resolveRuntimePaths({ LLAMA_MANAGER_PACKAGED: '1' }, { projectRoot: '/usr/lib/llama-manager' });
  assert.equal(packaged.nodeNamePath, '/var/lib/llama-manager/node-name');

  const source = resolveRuntimePaths({}, { projectRoot: '/src/llama', home: '/home/dev' });
  assert.equal(source.nodeNamePath, '/src/llama/data/node-name');

  const overridden = resolveRuntimePaths(
    { NODE_NAME_PATH: '/run/somewhere/name' },
    { projectRoot: '/src/llama' },
  );
  assert.equal(overridden.nodeNamePath, '/run/somewhere/name');
});
