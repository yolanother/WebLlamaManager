// Llama Manager — safe configuration utility integration tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Exercises the public dev-config.sh CLI against disposable JSON files so
// operator-supplied JSON literals retain their native types without touching
// live configuration or exposing credentials.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = new URL('../.orchestrator/scripts/dev-config.sh', import.meta.url).pathname;

/**
 * Write a disposable JSON setting through the supported configuration CLI.
 *
 * @param {string} key Dotted configuration key to write.
 * @param {string} value Command-line representation of the desired value.
 * @returns {unknown} The persisted value at the requested top-level key.
 */
function writeJsonSetting(key, value) {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'llama-dev-config-'));
  const configPath = join(fixtureDir, 'config.json');
  const result = spawnSync(SCRIPT, ['file', 'set', configPath, key, value], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(readFileSync(configPath, 'utf8'))[key];
}

test('JSON file writes preserve boolean values', () => {
  assert.equal(writeJsonSetting('autoStart', 'false'), false);
});

test('JSON file writes preserve every JSON literal type and plain strings', () => {
  assert.equal(writeJsonSetting('modelsMax', '3'), 3);
  assert.equal(writeJsonSetting('defaultModel', 'null'), null);
  assert.deepEqual(writeJsonSetting('allowedModels', '["small","large"]'), ['small', 'large']);
  assert.deepEqual(writeJsonSetting('guard', '{"enabled":true}'), { enabled: true });
  assert.equal(writeJsonSetting('label', 'router'), 'router');
});
