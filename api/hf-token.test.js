// Llama Manager — unit tests for api/hf-token.js (HuggingFace token helpers).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHfToken, maskToken, redactConfig, actionableDownloadError, isGatedOutput, hfModelUrl } from './hf-token.js';

test('resolveHfToken: config preferred over env', () => {
  assert.equal(resolveHfToken({ hfToken: 'hf_cfg' }, { HF_TOKEN: 'hf_env' }), 'hf_cfg');
});
test('resolveHfToken: falls back to env when config empty/blank', () => {
  assert.equal(resolveHfToken({ hfToken: '  ' }, { HF_TOKEN: 'hf_env' }), 'hf_env');
  assert.equal(resolveHfToken({}, { HF_TOKEN: 'hf_env' }), 'hf_env');
});
test('resolveHfToken: empty when neither set', () => {
  assert.equal(resolveHfToken({}, {}), '');
});
test('resolveHfToken: trims', () => {
  assert.equal(resolveHfToken({ hfToken: ' hf_x ' }, {}), 'hf_x');
});

test('maskToken: null when empty', () => {
  assert.equal(maskToken(''), null);
  assert.equal(maskToken(undefined), null);
});
test('maskToken: short token fully masked', () => {
  assert.equal(maskToken('hf_abc'), '****');
});
test('maskToken: long token shows first4 + last2', () => {
  assert.equal(maskToken('hf_1234567890ab'), 'hf_1…ab');
});

test('redactConfig: removes hfToken, leaves rest, non-mutating', () => {
  const cfg = { a: 1, hfToken: 'hf_secret', embed: { model: 'm' } };
  const r = redactConfig(cfg);
  assert.equal('hfToken' in r, false);
  assert.equal(r.a, 1);
  assert.deepEqual(r.embed, { model: 'm' });
  assert.equal(cfg.hfToken, 'hf_secret'); // original untouched
});
test('redactConfig: handles missing hfToken', () => {
  assert.deepEqual(redactConfig({ a: 1 }), { a: 1 });
});

test('actionableDownloadError: forkpty', () => {
  const m = actionableDownloadError({ forkpty: true });
  assert.match(m, /PTY allocation failed/i);
  assert.match(m, /restart/i);
});
test('actionableDownloadError: gated without token points to Settings', () => {
  const m = actionableDownloadError({ output: 'Error: 403 Forbidden, access to model is restricted', exitCode: 1, hasToken: false });
  assert.match(m, /gated/i);
  assert.match(m, /Settings/);
});
test('actionableDownloadError: gated with token suggests license acceptance', () => {
  const m = actionableDownloadError({ output: 'cannot access gated repo (401)', exitCode: 1, hasToken: true });
  assert.match(m, /license/i);
});
test('actionableDownloadError: generic fallback includes exit code', () => {
  const m = actionableDownloadError({ output: 'some network blip', exitCode: 7, hasToken: true });
  assert.match(m, /exit code 7/);
});

test('isGatedOutput: detects gated/auth, ignores benign', () => {
  assert.equal(isGatedOutput('Error: 403 Forbidden, access to model is restricted'), true);
  assert.equal(isGatedOutput('401 Unauthorized'), true);
  assert.equal(isGatedOutput('You must be authenticated'), true);
  assert.equal(isGatedOutput('downloading shard 1 of 4'), false);
  assert.equal(isGatedOutput(''), false);
});

test('hfModelUrl: builds model page url, strips :quant suffix', () => {
  assert.equal(hfModelUrl('google/gemma-4-12B-it-qat-q4_0-gguf:Q4_0'),
    'https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf');
  assert.equal(hfModelUrl('org/model'), 'https://huggingface.co/org/model');
  assert.equal(hfModelUrl('  org/model  '), 'https://huggingface.co/org/model');
  assert.equal(hfModelUrl(''), null);
});
