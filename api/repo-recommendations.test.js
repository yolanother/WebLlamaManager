// Llama Manager — unit tests for api/repo-recommendations.js.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractQuantization,
  buildRepoRecommendations,
  computeCapacityBytes,
} from './repo-recommendations.js';

const GB = 1e9;

test('extractQuantization retains a UD- prefix', () => {
  assert.equal(extractQuantization('Muse-Glimmer-30B-UD-Q4_K_XL.gguf'), 'UD-Q4_K_XL');
  assert.equal(extractQuantization('Muse-Glimmer-30B-UD-Q8_K_XL.gguf'), 'UD-Q8_K_XL');
  assert.equal(extractQuantization('Muse-Glimmer-30B-UD-Q6_K_XL.gguf'), 'UD-Q6_K_XL');
});

test('extractQuantization does not treat an mmproj BF16 file as a plain BF16 quant match', () => {
  // extractQuantization itself would still find the BF16 token in the name --
  // it's buildRepoRecommendations that must classify mmproj files by name
  // first and route them to kind:'mmproj' before ever consulting this.
  assert.equal(extractQuantization('mmproj-BF16.gguf'), 'BF16');
});

test('extractQuantization on unrecognized names returns null', () => {
  assert.equal(extractQuantization('deepseek-v4-chat-v2-imatrix.gguf'), null);
  assert.equal(extractQuantization('deepseek-v4-chat-v2.gguf'), null);
  assert.equal(extractQuantization('Vision-Encoder.gguf'), null);
});

// ── Muse Glimmer fixture (llama engine, HF repo listing) ──────────────────

function museGlimmerFiles() {
  return [
    { path: 'Muse-Glimmer-30B-BF16-00001-of-00003.gguf', size: 18.49 * GB },
    { path: 'Muse-Glimmer-30B-BF16-00002-of-00003.gguf', size: 18.49 * GB },
    { path: 'Muse-Glimmer-30B-BF16-00003-of-00003.gguf', size: 18.5 * GB },
    { path: 'Muse-Glimmer-30B-UD-Q8_K_XL.gguf', size: 32.3 * GB },
    { path: 'Muse-Glimmer-30B-Q8_0.gguf', size: 29.6 * GB },
    { path: 'Muse-Glimmer-30B-UD-Q6_K_XL.gguf', size: 26.3 * GB },
    { path: 'Muse-Glimmer-30B-UD-Q4_K_XL.gguf', size: 15.9 * GB },
    { path: 'Muse-Glimmer-30B-IQ2_M.gguf', size: 11.4 * GB },
    { path: 'mmproj-BF16.gguf', size: 0.9 * GB },
    { path: 'mmproj-F16.gguf', size: 1.7 * GB },
  ];
}

test('Muse Glimmer at 133.6GB capacity recommends UD-Q8_K_XL; BF16 fits but ranks below Q6; mmproj last', () => {
  const result = buildRepoRecommendations({
    files: museGlimmerFiles(),
    engine: 'llama',
    capacityBytes: 133.6 * GB,
  });

  assert.equal(result.engine, 'llama');
  assert.equal(result.recommended, 'UD-Q8_K_XL');

  const byQuant = new Map(result.quantizations.map((q) => [q.quantization, q]));
  const bf16 = byQuant.get('BF16');
  const q6 = byQuant.get('UD-Q6_K_XL');
  const iq2 = byQuant.get('IQ2_M');
  assert.equal(bf16.isSplit, true);
  assert.equal(bf16.totalParts, 3);
  assert.equal(bf16.fit.fits, true);
  assert.ok(bf16.rank < q6.rank, 'BF16 must rank below Q6');
  assert.ok(iq2.rank < 2, 'IQ2_M must rank below a Q2 entry (bits - 0.5)');

  // mmproj entries sort after every non-mmproj entry regardless of rank/fit.
  const kinds = result.quantizations.map((q) => q.kind);
  assert.equal(kinds.filter((k) => k === 'mmproj').length, 2);
  assert.deepEqual(kinds.slice(-2).sort(), ['mmproj', 'mmproj']);

  const mmprojEntry = byQuant.get('mmproj-BF16');
  assert.equal(mmprojEntry.kind, 'mmproj');
  assert.equal(mmprojEntry.pattern, 'mmproj-BF16.gguf');
});

test('Muse Glimmer at 24GB capacity recommends UD-Q4_K_XL (Q6 no longer fits)', () => {
  const result = buildRepoRecommendations({
    files: museGlimmerFiles(),
    engine: 'llama',
    capacityBytes: 24 * GB,
  });

  assert.equal(result.recommended, 'UD-Q4_K_XL');
  const byQuant = new Map(result.quantizations.map((q) => [q.quantization, q]));
  assert.equal(byQuant.get('UD-Q6_K_XL').fit.fits, false);
  assert.equal(byQuant.get('UD-Q4_K_XL').fit.fits, true);
});

// ── DS4 fixture (ds4 engine, local ggufDir listing) ────────────────────────

function ds4Files() {
  return [
    { path: 'deepseek-v4-chat-v2-imatrix.gguf', size: 86720111488 },
    { path: 'deepseek-v4-chat-v2.gguf', size: 97591747456 },
    { path: 'deepseek-v4-Q4KExperts-imatrix.gguf', size: 164633502304 },
    { path: 'MTP-Q4K-Q8_0-F32.gguf', size: 3807602400 },
    { path: 'Vision-Encoder.gguf', size: 5989114528 },
  ];
}

test('DS4 fixture: fits = totalSize <= capacity*0.70, ggufDir echoed, pattern is the exact filename, present flag from dir listing', () => {
  const result = buildRepoRecommendations({
    files: ds4Files(),
    engine: 'ds4',
    ggufDir: '/home/yolan/models-ds4/deepseek-v4-gguf',
    presentNames: ['deepseek-v4-chat-v2-imatrix.gguf', 'MTP-Q4K-Q8_0-F32.gguf'],
    capacityBytes: 133622603776,
  });

  assert.equal(result.engine, 'ds4');
  assert.equal(result.ggufDir, '/home/yolan/models-ds4/deepseek-v4-gguf');

  const byFile = new Map(result.quantizations.map((q) => [q.files[0], q]));
  const imatrix = byFile.get('deepseek-v4-chat-v2-imatrix.gguf');
  const chatV2 = byFile.get('deepseek-v4-chat-v2.gguf');
  const q4kExperts = byFile.get('deepseek-v4-Q4KExperts-imatrix.gguf');
  const mtp = byFile.get('MTP-Q4K-Q8_0-F32.gguf');

  assert.equal(imatrix.fit.fits, true, 'imatrix file fits');
  assert.equal(imatrix.fit.reason, 'ds4 headroom');
  assert.equal(chatV2.fit.fits, false, '97.6GB file does not fit');
  assert.equal(q4kExperts.fit.fits, false, '164GB file does not fit');
  assert.equal(mtp.fit.fits, true, 'MTP file fits');

  assert.equal(imatrix.pattern, 'deepseek-v4-chat-v2-imatrix.gguf');
  assert.equal(imatrix.present, true);
  assert.equal(chatV2.present, false);
  assert.equal(q4kExperts.kind, 'file', 'unrecognized token name is not dropped, kind file');
  assert.equal(q4kExperts.rank, 4, 'fallback rank picks up the Q4 token');
});
