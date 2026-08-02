// Llama Manager — start-ds4.sh SSD-streaming flag test (--print-cmd contract).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Exercises a temporary copy of start-ds4.sh via its `--print-cmd` seam, beside a
// sentinel .env that would terminate the process if sourced. This proves both
// that print-only inspection never reads repository configuration or launches an
// engine and that SSD-streaming flags follow the adaptive controller's contract.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPOSITORY_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'start-ds4.sh');
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'llama-ds4-print-test-'));
const SCRIPT = join(FIXTURE_ROOT, 'start-ds4.sh');
copyFileSync(REPOSITORY_SCRIPT, SCRIPT);
writeFileSync(join(FIXTURE_ROOT, '.env'), 'exit 97\n');
after(() => rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

/** Run `start-ds4.sh --print-cmd` with `extraEnv` merged in; return the printed argv line. */
function printCmd(extraEnv = {}) {
  const result = spawnSync('bash', [SCRIPT, '--print-cmd'], {
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH || '/usr/bin:/bin',
      DS4_MODEL: '/tmp/model.gguf',
      DS4_STATE_DIR: join(FIXTURE_ROOT, 'state'),
      ...extraEnv,
    },
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `start-ds4.sh --print-cmd failed (status=${result.status}, signal=${result.signal || 'none'}): ${result.stderr.trim()}`,
  );
  return result.stdout.trim();
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
