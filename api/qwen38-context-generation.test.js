// Llama Manager — generated Flash-Next context admission contracts.
// Copyright (c) Llama Manager project. The LICENSE file in the repo root governs use.
// Executes the real router preset writer without starting inference to ensure
// Flash-Next honors the requested context, stays within its trained maximum,
// and retains the independently bounded podcast route and selected IQ4 weights.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as engines from './engines.js';

const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
const writer = source.slice(source.indexOf('function writeModelsPresetFile('),
  source.indexOf('async function restartLlamaServer('));
const plannerId = 'unsloth_Qwen3.8-Flash-Next-GGUF';
const firstShard = `/models/${plannerId}/Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003.gguf`;

/**
 * Generate and parse actual router sections using isolated temporary storage.
 * @param {import('node:test').TestContext} t Cleanup owner.
 * @param {number|undefined} configured Global configured context.
 * @param {number|undefined} requested Explicit router context override.
 * @param {boolean} present Whether complete Flash weights exist.
 * @returns {Map<string, Object<string, string>>} Written preset sections.
 */
function sectionsFor(t, configured, requested, present = true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'llama-flash-context-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const errors = [];
  const path = runInNewContext(`${writer}\nwriteModelsPresetFile(requested);`, {
    ...engines, join, mkdirSync, writeFileSync,
    MODELS_DIR: '/models', RUNTIME_PATHS: { dataDir },
    config: { contextSize: configured }, requested,
    resolveHardwareProfile: () => ({ threads: 16 }),
    duoWeightPaths: () => ({ plannerExists: present, plannerPath: present ? firstShard : null, workerExists: present }),
    resolveContextMode: () => present ? 'preset' : 'cli',
    existsSync: () => false,
    applyDevicePins: sections => sections,
    gpuPinPresetDevices: () => ({}),
    console: { warn: message => errors.push(message) },
  });
  assert.deepEqual(errors, [], 'preset generation must not silently fall back after an error');
  const sections = new Map();
  if (!path) return sections;
  let current;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) { current = {}; sections.set(section[1], current); }
    else {
      const option = line.match(/^([^=]+?)\s*=\s*(.*)$/);
      if (option && current) current[option[1].trim()] = option[2].trim();
    }
  }
  return sections;
}

for (const size of [16384, 32768, 65536]) {
  test(`generated Flash route honors explicit ${size} context and keeps podcast bounded`, t => {
    const sections = sectionsFor(t, 65536, size);
    assert.equal(sections.get(plannerId)['ctx-size'], String(size));
    assert.equal(sections.get('unsloth_Qwen3.6-35B-A3B-GGUF')['ctx-size'], String(size));
    assert.equal(sections.get('*')['ctx-size'], String(size));
    assert.equal(sections.get('podcast-qwen3.8-16k')['ctx-size'], '16384');
    assert.equal(sections.get(plannerId).model, firstShard);
    assert.equal(sections.get(plannerId)['load-mode'], 'mmap');
    assert.equal(sections.get(plannerId)['lazy-mode'], 'on');
    assert.equal(sections.get(plannerId)['cpu-moe'], '1');
    assert.equal(sections.get(plannerId).threads, '16');
  });
}

test('default generation honors configured 64K rather than silently allocating 256K', t => {
  assert.equal(sectionsFor(t, 65536, undefined).get(plannerId)['ctx-size'], '65536');
});

test('unconfigured generation preserves the existing 8192 global fallback', t => {
  assert.equal(sectionsFor(t, undefined, undefined).get(plannerId)['ctx-size'], '8192');
});

test('explicit context remains capped at the trained Flash maximum', t => {
  assert.equal(sectionsFor(t, 65536, 524288).get(plannerId)['ctx-size'], '262144');
});

test('absent Flash weights publish neither canonical nor podcast sections', t => {
  const sections = sectionsFor(t, 65536, undefined, false);
  assert.equal(sections.has(plannerId), false);
  assert.equal(sections.has('podcast-qwen3.8-16k'), false);
});
