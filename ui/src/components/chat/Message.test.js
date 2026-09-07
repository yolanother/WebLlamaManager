// Llama Manager — Thinking-indicator status wiring contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies that the queue/keepalive status string from useChatStream reaches
// the "Thinking…" indicator. This project has no React render harness, so the
// prop threading is asserted from source text (readFileSync, no import — a
// .jsx file cannot be imported under plain `node --test`) the same way
// useChatStream.test.js asserts its own call sites; `thinkingLabel` itself is
// a plain function in useChatStream.js and is unit-tested there.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('Message imports thinkingLabel and passes streamStatus into ThinkingIndicator', () => {
  const source = readFileSync(fileURLToPath(new URL('./Message.jsx', import.meta.url)), 'utf8');
  assert.match(source, /thinkingLabel/);
  assert.match(source, /streamStatus = ''/);
  assert.match(source, /<ThinkingIndicator[\s\S]*?status=\{streamStatus\}/);
  // The generic elapsed counter must not double up with a status string that
  // already carries its own wait time.
  assert.match(source, /!status && seconds >= ELAPSED_VISIBLE_AFTER_SECONDS/);
});

test('MessageList threads streamStatus from its props into the streaming Message', () => {
  const source = readFileSync(fileURLToPath(new URL('./MessageList.jsx', import.meta.url)), 'utf8');
  assert.match(source, /streamStatus = ''/);
  assert.match(source, /streamStatus=\{streamStatus\}/);
});
