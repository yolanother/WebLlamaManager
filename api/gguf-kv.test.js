// Llama Manager — tests for model-aware KV-cache sizing from GGUF metadata.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Pins W2e (T3231898735806). The admission guard charged every model a flat 256 KiB of KV
// per token: 16 GiB at ctx 65536 for Qwen3.6-35B-A3B, whose real KV is 20 KiB/token (a
// hybrid model: only every 4th of its 40 layers is attention). The metadata shapes below
// are dumped from Frostburn's real GGUFs (2026-10-31). Qwen3-8B's formula value (9.0 GiB at
// 65536) matches its measured GTT on Frostburn: 13.8 GiB = 4.7 GiB weights + 9.0 GiB KV.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kvFootprint, readGgufAttentionMetadata } from './gguf-kv.js';

const GiB = 2 ** 30;

const QWEN3_8B = { architecture: 'qwen3', blockCount: 36, headCountKv: 8, keyLength: 128, valueLength: 128 };
const QWEN36_35B_A3B = { architecture: 'qwen35moe', blockCount: 40, headCountKv: 2, keyLength: 256, valueLength: 256, fullAttentionInterval: 4 };
const GEMMA4_31B = {
  architecture: 'gemma4', blockCount: 60, keyLength: 512, valueLength: 512, keyLengthSwa: 256, valueLengthSwa: 256,
  slidingWindow: 1024,
  headCountKv: Array.from({ length: 60 }, (_, i) => ((i + 1) % 6 === 0 ? 4 : 16)),
  slidingWindowPattern: Array.from({ length: 60 }, (_, i) => (i + 1) % 6 !== 0),
};

test('dense GQA (Qwen3-8B): 144 KiB/token, 9 GiB at 65536, as measured', () => {
  const kv = kvFootprint(QWEN3_8B);
  assert.equal(kv.perTokenBytes, 36 * 8 * (128 + 128) * 2);
  assert.equal(kv.fixedBytes, 0);
  assert.equal(kv.perTokenBytes * 65536, 9 * GiB);
});

test('hybrid (Qwen3.6-35B-A3B): only every 4th layer holds KV, 20 KiB/token', () => {
  const kv = kvFootprint(QWEN36_35B_A3B);
  assert.equal(kv.perTokenBytes, 10 * 2 * (256 + 256) * 2);
  assert.equal(kv.perTokenBytes * 65536, 1.25 * GiB);
});

test('sliding-window layers (Gemma 4 31B) are charged their window once, not per token', () => {
  const kv = kvFootprint(GEMMA4_31B);
  assert.equal(kv.perTokenBytes, 10 * 4 * (512 + 512) * 2, 'only the 10 global layers grow with context');
  assert.equal(kv.fixedBytes, 50 * 16 * (256 + 256) * 2 * 1024);
});

test('key/value length fall back to embedding_length / head_count', () => {
  const kv = kvFootprint({ blockCount: 2, headCountKv: 2, embeddingLength: 1024, headCount: 8 });
  assert.equal(kv.perTokenBytes, 2 * 2 * (128 + 128) * 2);
});

test('missing metadata gives null so the caller keeps the flat estimate', () => {
  assert.equal(kvFootprint(null), null);
  assert.equal(kvFootprint({ architecture: 'x' }), null);
  assert.equal(kvFootprint({ blockCount: 4 }), null);
});

/**
 * Minimal GGUF v3 writer: header + typed key/values, no tensors.
 * @param {Array<[string, 'u32'|'str'|'u32[]'|'bool[]'|'f32', *]>} kvs
 * @returns {Buffer}
 */
function gguf(kvs) {
  const parts = [Buffer.from('GGUF'), u32(3), u64(0), u64(kvs.length)];
  for (const [key, type, value] of kvs) {
    parts.push(str(key));
    if (type === 'u32') parts.push(u32(4), u32(value));
    else if (type === 'f32') { const b = Buffer.alloc(4); b.writeFloatLE(value); parts.push(u32(6), b); }
    else if (type === 'str') parts.push(u32(8), str(value));
    else if (type === 'u32[]') parts.push(u32(9), u32(4), u64(value.length), ...value.map(u32));
    else if (type === 'bool[]') parts.push(u32(9), u32(7), u64(value.length), Buffer.from(value.map((v) => (v ? 1 : 0))));
  }
  return Buffer.concat(parts);
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function str(s) { const v = Buffer.from(s); return Buffer.concat([u64(v.length), v]); }

test('readGgufAttentionMetadata parses scalar, array and bool-array keys and skips the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gguf-kv-'));
  try {
    const file = join(dir, 'm.gguf');
    writeFileSync(file, gguf([
      ['general.architecture', 'str', 'gemma4'],
      ['general.name', 'str', 'ignored'],
      ['gemma4.block_count', 'u32', 60],
      ['gemma4.attention.layer_norm_rms_epsilon', 'f32', 1e-6],
      ['gemma4.attention.head_count_kv', 'u32[]', GEMMA4_31B.headCountKv],
      ['gemma4.attention.key_length', 'u32', 512],
      ['gemma4.attention.value_length', 'u32', 512],
      ['gemma4.attention.key_length_swa', 'u32', 256],
      ['gemma4.attention.value_length_swa', 'u32', 256],
      ['gemma4.attention.sliding_window', 'u32', 1024],
      ['gemma4.attention.sliding_window_pattern', 'bool[]', GEMMA4_31B.slidingWindowPattern],
    ]));
    assert.deepEqual(readGgufAttentionMetadata(file), GEMMA4_31B);
    const hybrid = join(dir, 'h.gguf');
    writeFileSync(hybrid, gguf([
      ['general.architecture', 'str', 'qwen35moe'],
      ['qwen35moe.block_count', 'u32', 40],
      ['qwen35moe.attention.head_count_kv', 'u32', 2],
      ['qwen35moe.attention.key_length', 'u32', 256],
      ['qwen35moe.attention.value_length', 'u32', 256],
      ['qwen35moe.full_attention_interval', 'u32', 4],
    ]));
    assert.deepEqual(readGgufAttentionMetadata(hybrid), QWEN36_35B_A3B);
    writeFileSync(join(dir, 'bad.gguf'), 'not a gguf');
    assert.equal(readGgufAttentionMetadata(join(dir, 'bad.gguf')), null);
    assert.equal(readGgufAttentionMetadata(join(dir, 'missing.gguf')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
