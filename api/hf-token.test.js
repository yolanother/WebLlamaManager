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

test('actionableDownloadError: a plain failure with NO token configured names the token', () => {
  // The common fresh-appliance case: nothing is gated, the CLI just exits 1,
  // and the operator is left with "check the output". If no token is configured
  // at all, say so and point at Settings -- that is the most likely fix and the
  // cheapest one to try.
  const m = actionableDownloadError({ output: 'some unrelated failure', exitCode: 1, hasToken: false });
  assert.match(m, /Settings/);
  assert.match(m, /token/i);
});

test('actionableDownloadError: a plain failure WITH a token does not blame the token', () => {
  // Claiming a token problem when one is configured sends the operator to fix
  // something that is not broken.
  const m = actionableDownloadError({ output: 'some unrelated failure', exitCode: 1, hasToken: true });
  assert.doesNotMatch(m, /Settings/);
  assert.match(m, /exit code 1/);
});

test('actionableDownloadError: a missing downloader is named, not blamed on the network', () => {
  // The appliance ships no Python venv at all, so HF_CLI_PATH does not exist.
  // node-pty reports that as exit 1, NOT 127, so the existing "exit code 127 ->
  // run ./install.sh" branch never fires and the operator was told to check
  // their network for a binary that was never installed.
  const m = actionableDownloadError({ exitCode: 1, hasToken: true, cliMissing: true });
  assert.match(m, /not installed|downloader/i);
  assert.doesNotMatch(m, /network or model-path/);
});

test('actionableDownloadError: a packaged appliance is not told to run ./install.sh', () => {
  // There is no ./install.sh on an appliance — it is a packaged image. Telling
  // the operator to run one sends them looking for a file that does not exist,
  // which is the same class of dead end this message set out to remove.
  const m = actionableDownloadError({ exitCode: 1, hasToken: true, cliMissing: true, packaged: true });
  assert.doesNotMatch(m, /install\.sh/);
  assert.match(m, /not installed|downloader/i);
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
