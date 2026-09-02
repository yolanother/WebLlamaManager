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
// Real unsloth/Muse-Glimmer-30B-GGUF file list (from the HF tree API).

function museGlimmerFiles() {
  return [
    { path: 'BF16/Muse-Glimmer-30B-BF16-00001-of-00002.gguf', size: 27.75 * GB },
    { path: 'BF16/Muse-Glimmer-30B-BF16-00002-of-00002.gguf', size: 27.75 * GB },
    { path: 'Muse-Glimmer-30B-Q8_0.gguf', size: 29.6 * GB },
    { path: 'Muse-Glimmer-30B-UD-Q8_K_XL.gguf', size: 32.3 * GB },
    { path: 'Muse-Glimmer-30B-UD-Q6_K_XL.gguf', size: 26.3 * GB },
    { path: 'Muse-Glimmer-30B-UD-Q5_K_XL.gguf', size: 22.5 * GB },
    { path: 'Muse-Glimmer-30B-UD-Q5_K_M.gguf', size: 21.0 * GB },
    { path: 'Muse-Glimmer-30B-UD-Q5_K_L.gguf', size: 23.0 * GB },
    { path: 'Muse-Glimmer-30B-UD-Q4_K_XL.gguf', size: 15.88 * GB },
    { path: 'Muse-Glimmer-30B-UD-Q3_K_XL.gguf', size: 13.0 * GB },
    { path: 'Muse-Glimmer-30B-UD-Q2_K_XL.gguf', size: 10.5 * GB },
    { path: 'Muse-Glimmer-30B-UD-IQ3_M.gguf', size: 12.5 * GB },
    { path: 'Muse-Glimmer-30B-UD-IQ3_XXS.gguf', size: 11.0 * GB },
    { path: 'Muse-Glimmer-30B-UD-IQ2_M.gguf', size: 9.5 * GB },
    { path: 'Muse-Glimmer-30B-UD-IQ2_XS.gguf', size: 8.8 * GB },
    { path: 'Muse-Glimmer-30B-UD-IQ2_XXS.gguf', size: 8.0 * GB },
    { path: 'mmproj-Muse-Glimmer-30B-BF16.gguf', size: 3.85 * GB },
    { path: 'mmproj-Muse-Glimmer-30B-Q8_0.gguf', size: 1.9 * GB },
    { path: 'mmproj-kquant.gguf', size: 1.4 * GB },
    { path: 'dflash-kquant.gguf', size: 1.4 * GB },
  ];
}

test('Muse Glimmer at 133.6GB capacity: UD-Q8_K_XL recommended over the equal-rank Q8_0 by size tiebreak, mmproj not folded into BF16, mmproj/file kinds last', () => {
  const result = buildRepoRecommendations({
    files: museGlimmerFiles(),
    engine: 'llama',
    capacityBytes: 133.6 * GB,
  });

  assert.equal(result.engine, 'llama');
  // (2) Q8_0 and UD-Q8_K_XL both rank 8; UD-Q8_K_XL (32.3GB) > Q8_0 (29.6GB) wins the tiebreak.
  assert.equal(result.recommended, 'UD-Q8_K_XL');

  const byQuant = new Map(result.quantizations.map((q) => [q.quantization, q]));
  assert.equal(byQuant.get('Q8_0').rank, byQuant.get('UD-Q8_K_XL').rank);

  const bf16 = byQuant.get('BF16');
  assert.equal(bf16.isSplit, true);
  assert.equal(bf16.totalParts, 2);
  // (1) the mmproj BF16 file must not be folded into the BF16 quant group.
  assert.equal(bf16.files.length, 2);
  assert.ok(bf16.files.every((f) => !/mmproj/i.test(f)));

  const mmprojBf16 = byQuant.get('mmproj-Muse-Glimmer-30B-BF16');
  assert.equal(mmprojBf16.kind, 'mmproj');
  assert.equal(mmprojBf16.pattern, 'mmproj-Muse-Glimmer-30B-BF16.gguf');

  // (4) UD-IQ3_M (3 - 0.5 = 2.5) ranks above UD-Q2_K_XL (2).
  assert.equal(byQuant.get('UD-IQ3_M').rank, 2.5);
  assert.equal(byQuant.get('UD-Q2_K_XL').rank, 2);
  assert.ok(byQuant.get('UD-IQ3_M').rank > byQuant.get('UD-Q2_K_XL').rank);

  // (3) a non-mmproj, non-quant file (no recognized/fallback token) is kind:'file',
  // rank 0, pattern is its exact filename; a same-named mmproj file is kind:'mmproj'.
  const dflash = byQuant.get('dflash-kquant');
  assert.equal(dflash.kind, 'file');
  assert.equal(dflash.rank, 0);
  assert.equal(dflash.pattern, 'dflash-kquant.gguf');
  const mmprojKquant = byQuant.get('mmproj-kquant');
  assert.equal(mmprojKquant.kind, 'mmproj');
  assert.equal(mmprojKquant.rank, 0);

  // mmproj entries sort after every non-mmproj entry regardless of rank/fit.
  const kinds = result.quantizations.map((q) => q.kind);
  const mmprojCount = kinds.filter((k) => k === 'mmproj').length;
  assert.equal(mmprojCount, 3);
  assert.deepEqual(kinds.slice(-mmprojCount), ['mmproj', 'mmproj', 'mmproj']);
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

// ── DS4 with the REAL antirez/deepseek-v4-gguf names ───────────────────────
// These names carry misleading tokens (`-F32`, `-F16HC`, `Q4KExperts`) that
// the generic grouper would turn into bogus "F32"/"F16" quant groups.

function realDs4Files() {
  return [
    { path: 'DeepSeek-V4-Flash-MTP-Q4K-Q8_0-F32.gguf', size: 3807602400 },
    { path: 'DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf', size: 86720111488 },
    { path: 'DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix.gguf', size: 86720111488 },
    { path: 'DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf', size: 86720111776 },
    { path: 'DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2.gguf', size: 97591747456 },
    { path: 'DeepSeek-V4-Flash-Q4KExperts-F16HC-F16Compressor-F16Indexer-Q8Attn-Q8Shared-Q8Out-chat-v2-imatrix.gguf', size: 164633502304 },
    { path: 'DeepSeek-V4-Flash-Vision-Encoder.gguf', size: 932857760 },
    { path: 'DeepSeek-V4-Pro-Q4K-Layers00-30.gguf', size: 457521327328 },
  ];
}

const DS4_IMATRIX = 'DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix';

test('DS4 real names: every entry is kind file (no F32/F16 groups), sorted fits-first by size, recommended = the configured preset model', () => {
  const result = buildRepoRecommendations({
    files: realDs4Files(),
    engine: 'ds4',
    ggufDir: '/d',
    presentNames: [`${DS4_IMATRIX}.gguf`],
    preferredNames: [`${DS4_IMATRIX}.gguf`],
    capacityBytes: 133622603776,
  });
  assert.ok(result.quantizations.every((q) => q.kind === 'file'), 'ds4 never groups by quant token');
  assert.ok(!result.quantizations.some((q) => q.quantization === 'F32' || q.quantization === 'F16'));
  assert.equal(result.recommended, DS4_IMATRIX);
  const order = result.quantizations.map((q) => q.quantization);
  assert.equal(order[0], 'DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8', 'largest fitting first');
  assert.ok(order.indexOf(DS4_IMATRIX) < order.indexOf('DeepSeek-V4-Flash-MTP-Q4K-Q8_0-F32'), 'MTP (small) after the weights');
  const firstUnfit = result.quantizations.findIndex((q) => !q.fit.fits);
  assert.ok(result.quantizations.slice(firstUnfit).every((q) => !q.fit.fits), 'unfit entries are contiguous at the end');
  assert.equal(result.quantizations[firstUnfit].quantization, 'DeepSeek-V4-Pro-Q4K-Layers00-30', 'unfit sorted by size desc');
});

test('DS4 real names without a configured preset: recommended falls back to the largest fitting imatrix file', () => {
  const result = buildRepoRecommendations({
    files: realDs4Files().filter((f) => !f.path.includes('-0731')),
    engine: 'ds4',
    capacityBytes: 133622603776,
  });
  assert.equal(result.recommended, DS4_IMATRIX);
});
