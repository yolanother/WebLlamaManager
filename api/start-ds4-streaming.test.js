// Llama Manager — start-ds4.sh SSD-streaming flag test (--print-cmd contract).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Exercises the real start-ds4.sh launcher via its `--print-cmd` seam (which prints
// the ds4-server argv and exits, spawning nothing) to prove the DS4_SSD_STREAMING /
// DS4_SSD_STREAMING_CACHE_EXPERTS env contract the adaptive controller relies on:
// streaming appends `--ssd-streaming [--ssd-streaming-cache-experts <N>]`; unset/0
// omits them. Runs on the host without the ds4 binary or the 81GB model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'start-ds4.sh');

/** Run `start-ds4.sh --print-cmd` with `extraEnv` merged in; return the printed argv line. */
function printCmd(extraEnv = {}) {
  return execFileSync('bash', [SCRIPT, '--print-cmd'], {
    env: { ...process.env, DS4_MODEL: '/tmp/model.gguf', ...extraEnv },
    encoding: 'utf8',
  }).trim();
}

test('start-ds4.sh: no streaming env → no --ssd-streaming flag', () => {
  const cmd = printCmd({ DS4_CTX: '32768' });
  assert.doesNotMatch(cmd, /--ssd-streaming/);
  assert.match(cmd, /-c 32768/);
});

test('start-ds4.sh: DS4_SSD_STREAMING=0 → no --ssd-streaming flag', () => {
  const cmd = printCmd({ DS4_SSD_STREAMING: '0' });
  assert.doesNotMatch(cmd, /--ssd-streaming/);
});

test('start-ds4.sh: DS4_SSD_STREAMING=1 + cache size → both streaming flags appended', () => {
  const cmd = printCmd({ DS4_CTX: '131072', DS4_SSD_STREAMING: '1', DS4_SSD_STREAMING_CACHE_EXPERTS: '32GB' });
  assert.match(cmd, /--ssd-streaming --ssd-streaming-cache-experts 32GB/);
  assert.match(cmd, /-c 131072/);
});

test('start-ds4.sh: DS4_SSD_STREAMING=1 without a cache size → bare --ssd-streaming only', () => {
  const cmd = printCmd({ DS4_SSD_STREAMING: '1' });
  assert.match(cmd, /--ssd-streaming/);
  assert.doesNotMatch(cmd, /--ssd-streaming-cache-experts/);
});
