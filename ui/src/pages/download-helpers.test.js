// Llama Manager download-page helper tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies the pure helpers behind the Download page: the static recommended-
// repo chip list, partitioning a /repo/:author/:model/files response into
// recommended/fits/unfit/mmproj buckets (degrading gracefully when `fit` or
// `kind` is absent), and building the POST requests a download button issues.

import test from 'node:test';
import assert from 'node:assert/strict';
import { RECOMMENDED_REPOS, partitionQuantizations, downloadRequests } from './download-helpers.js';

// ---------------------------------------------------------------------------
// RECOMMENDED_REPOS
// ---------------------------------------------------------------------------

test('RECOMMENDED_REPOS lists the five allowlisted chips with id + label', () => {
  assert.equal(RECOMMENDED_REPOS.length, 5);
  const ids = RECOMMENDED_REPOS.map(r => r.id);
  assert.deepEqual(ids, [
    'antirez/deepseek-v4-gguf',
    'unsloth/Muse-Glimmer-30B-GGUF',
    'Qwen/Qwen3-Embedding-0.6B-GGUF',
    'nomic-ai/nomic-embed-text-v1.5-GGUF',
    'BAAI/bge-m3-GGUF'
  ]);
  for (const r of RECOMMENDED_REPOS) {
    assert.equal(typeof r.label, 'string');
    assert.ok(r.label.trim().length > 0);
  }
});

// ---------------------------------------------------------------------------
// partitionQuantizations
// ---------------------------------------------------------------------------

const fitOk = { fits: true, requiredBytes: 1, budgetBytes: 2, reason: null };
const fitBad = { fits: false, requiredBytes: 999, budgetBytes: 2, reason: 'too big' };

test('partitionQuantizations puts the data.recommended match in recommended, not fits', () => {
  const data = {
    recommended: 'Q4_K_M',
    quantizations: [
      { quantization: 'Q4_K_M', kind: 'quant', fit: fitOk },
      { quantization: 'Q5_K_M', kind: 'quant', fit: fitOk }
    ]
  };

  const { recommended, fits, unfit, mmproj } = partitionQuantizations(data);

  assert.equal(recommended.quantization, 'Q4_K_M');
  assert.deepEqual(fits.map(q => q.quantization), ['Q5_K_M']);
  assert.deepEqual(unfit, []);
  assert.deepEqual(mmproj, []);
});

test('partitionQuantizations sorts fit:false entries into unfit', () => {
  const data = {
    recommended: 'Q4_K_M',
    quantizations: [
      { quantization: 'Q4_K_M', kind: 'quant', fit: fitOk },
      { quantization: 'Q8_0', kind: 'quant', fit: fitBad }
    ]
  };

  const { fits, unfit } = partitionQuantizations(data);

  assert.deepEqual(fits, []);
  assert.deepEqual(unfit.map(q => q.quantization), ['Q8_0']);
});

test('partitionQuantizations collects kind:mmproj entries separately, never in fits/unfit', () => {
  const data = {
    recommended: 'Q4_K_M',
    quantizations: [
      { quantization: 'Q4_K_M', kind: 'quant', fit: fitOk },
      { quantization: 'mmproj-F16', kind: 'mmproj', fit: fitBad }
    ]
  };

  const { mmproj, fits, unfit } = partitionQuantizations(data);

  assert.deepEqual(mmproj.map(q => q.quantization), ['mmproj-F16']);
  assert.deepEqual(fits, []);
  assert.deepEqual(unfit, []);
});

test('partitionQuantizations treats a missing fit as fitting', () => {
  const data = {
    recommended: null,
    quantizations: [{ quantization: 'Q4_K_M', kind: 'quant' }]
  };

  const { fits, unfit } = partitionQuantizations(data);

  assert.deepEqual(fits.map(q => q.quantization), ['Q4_K_M']);
  assert.deepEqual(unfit, []);
});

test('partitionQuantizations defaults a missing kind to quant', () => {
  const data = {
    recommended: null,
    quantizations: [{ quantization: 'Q4_K_M', fit: fitBad }]
  };

  const { unfit, mmproj } = partitionQuantizations(data);

  assert.deepEqual(unfit.map(q => q.quantization), ['Q4_K_M']);
  assert.deepEqual(mmproj, []);
});

test('partitionQuantizations returns empty buckets and no recommended for an empty/absent response', () => {
  assert.deepEqual(partitionQuantizations({}), { recommended: null, fits: [], unfit: [], mmproj: [] });
  assert.deepEqual(partitionQuantizations(null), { recommended: null, fits: [], unfit: [], mmproj: [] });
  assert.deepEqual(partitionQuantizations(undefined), { recommended: null, fits: [], unfit: [], mmproj: [] });
});

// ---------------------------------------------------------------------------
// downloadRequests
// ---------------------------------------------------------------------------

test('downloadRequests posts to /pull for a llama-engine repo', () => {
  const data = { repo: 'Qwen/Qwen3-4B-GGUF', engine: 'llama', quantizations: [
    { quantization: 'Q4_K_M', kind: 'quant', pattern: '*Q4_K_M*.gguf' }
  ] };

  const reqs = downloadRequests(data, data.quantizations[0]);

  assert.deepEqual(reqs, [{ url: '/pull', body: { repo: 'Qwen/Qwen3-4B-GGUF', pattern: '*Q4_K_M*.gguf' } }]);
});

test('downloadRequests posts to /ds4/download for a ds4-engine repo', () => {
  const data = { repo: 'antirez/deepseek-v4-gguf', engine: 'ds4', quantizations: [
    { quantization: 'q2-imatrix', kind: 'quant', pattern: '*imatrix*' }
  ] };

  const reqs = downloadRequests(data, data.quantizations[0]);

  assert.deepEqual(reqs, [{ url: '/ds4/download', body: { repo: 'antirez/deepseek-v4-gguf', pattern: '*imatrix*' } }]);
});

test('downloadRequests for "recommended" bundles the first mmproj request ahead of the recommended one', () => {
  const data = {
    repo: 'unsloth/Muse-Glimmer-30B-GGUF',
    engine: 'llama',
    recommended: 'Q4_K_M',
    quantizations: [
      { quantization: 'Q4_K_M', kind: 'quant', pattern: '*Q4_K_M*.gguf' },
      { quantization: 'mmproj-F16', kind: 'mmproj', pattern: '*mmproj-F16*.gguf' },
      { quantization: 'mmproj-Q8', kind: 'mmproj', pattern: '*mmproj-Q8*.gguf' }
    ]
  };

  const reqs = downloadRequests(data, 'recommended');

  assert.deepEqual(reqs, [
    { url: '/pull', body: { repo: data.repo, pattern: '*mmproj-F16*.gguf' } },
    { url: '/pull', body: { repo: data.repo, pattern: '*Q4_K_M*.gguf' } }
  ]);
});

test('downloadRequests for "recommended" with no mmproj returns just the recommended request', () => {
  const data = {
    repo: 'Qwen/Qwen3-4B-GGUF',
    engine: 'llama',
    recommended: 'Q4_K_M',
    quantizations: [{ quantization: 'Q4_K_M', kind: 'quant', pattern: '*Q4_K_M*.gguf' }]
  };

  assert.deepEqual(downloadRequests(data, 'recommended'), [
    { url: '/pull', body: { repo: data.repo, pattern: '*Q4_K_M*.gguf' } }
  ]);
});

test('downloadRequests for "recommended" with no matching recommended entry returns []', () => {
  const data = { repo: 'x/y', engine: 'llama', recommended: 'missing', quantizations: [] };

  assert.deepEqual(downloadRequests(data, 'recommended'), []);
});

test('downloadRequests returns [] when the data has no repo', () => {
  const data = { engine: 'llama', quantizations: [{ quantization: 'Q4_K_M', kind: 'quant', pattern: '*.gguf' }] };

  assert.deepEqual(downloadRequests(data, data.quantizations[0]), []);
  assert.deepEqual(downloadRequests(data, 'recommended'), []);
});

test('downloadRequests returns [] for a falsy entry that is not "recommended"', () => {
  const data = { repo: 'x/y', engine: 'llama', quantizations: [] };

  assert.deepEqual(downloadRequests(data, null), []);
  assert.deepEqual(downloadRequests(data, undefined), []);
});
