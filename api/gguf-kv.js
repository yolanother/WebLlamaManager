// Llama Manager — model-aware KV-cache sizing from GGUF metadata.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Reads the attention-shape keys from a model's GGUF header and turns them into the
// KV-cache bytes the model will allocate, so the local admission guard can charge each
// model what it really needs instead of a flat 256 KiB/token. Only attention layers hold
// KV: a hybrid model such as Qwen3.6-35B-A3B (qwen35moe, full_attention_interval 4) keeps
// KV in 10 of its 40 layers; per-layer head_count_kv arrays are summed; sliding-window
// layers (Gemma 4) hold at most their window, a constant rather than a per-token cost.
// Assumes the default f16 KV cache (2 bytes per element), which over-estimates a
// quantized cache — the safe direction. See gguf-kv.test.js.

import { closeSync, openSync } from 'fs';
import { createReader, GGUF_TYPES, safeLength, skipValue } from './model-capabilities.js';

const KV_BYTES_PER_ELEMENT = 2;

/** GGUF key suffix (after `<arch>.`) -> metadata field. */
const ARCH_KEYS = Object.freeze({
  block_count: 'blockCount',
  embedding_length: 'embeddingLength',
  'attention.head_count': 'headCount',
  'attention.head_count_kv': 'headCountKv',
  'attention.key_length': 'keyLength',
  'attention.value_length': 'valueLength',
  'attention.key_length_swa': 'keyLengthSwa',
  'attention.value_length_swa': 'valueLengthSwa',
  'attention.sliding_window': 'slidingWindow',
  'attention.sliding_window_pattern': 'slidingWindowPattern',
  full_attention_interval: 'fullAttentionInterval',
});

/**
 * Read one scalar or array value of a numeric/bool/string GGUF type.
 * @param {ReturnType<typeof createReader>} reader positional reader.
 * @param {number} type GGUF value type.
 * @returns {number|boolean|string|Array} the value.
 */
function readValue(reader, type) {
  switch (type) {
    case GGUF_TYPES.UINT8: return reader.u8();
    case GGUF_TYPES.INT8: return reader.bytes(1).readInt8(0);
    case GGUF_TYPES.UINT16: return reader.bytes(2).readUInt16LE(0);
    case GGUF_TYPES.INT16: return reader.bytes(2).readInt16LE(0);
    case GGUF_TYPES.UINT32: return reader.u32();
    case GGUF_TYPES.INT32: return reader.bytes(4).readInt32LE(0);
    case GGUF_TYPES.UINT64: return safeLength(reader.u64(), 'value');
    case GGUF_TYPES.INT64: return Number(reader.bytes(8).readBigInt64LE(0));
    case GGUF_TYPES.BOOL: return reader.u8() !== 0;
    case GGUF_TYPES.STRING: return reader.string();
    case GGUF_TYPES.ARRAY: {
      const elementType = reader.u32();
      const count = safeLength(reader.u64(), 'array length');
      return Array.from({ length: count }, () => readValue(reader, elementType));
    }
    default: throw new Error(`Unsupported GGUF metadata type ${type}`);
  }
}

/**
 * Attention-shape metadata of a GGUF, or null when it cannot be read.
 * @param {string} ggufPath path to the model's (first) GGUF file.
 * @returns {{architecture:string, blockCount?:number, headCountKv?:(number|number[]), keyLength?:number,
 *   valueLength?:number, keyLengthSwa?:number, valueLengthSwa?:number, slidingWindow?:number,
 *   slidingWindowPattern?:boolean[], fullAttentionInterval?:number, embeddingLength?:number,
 *   headCount?:number}|null} only the keys present in the file.
 */
export function readGgufAttentionMetadata(ggufPath) {
  let fd;
  try {
    fd = openSync(ggufPath, 'r');
    const reader = createReader(fd);
    if (reader.bytes(4).toString('ascii') !== 'GGUF') return null;
    const version = reader.u32();
    if (version < 2 || version > 3) return null;
    reader.u64(); // tensor count
    const count = safeLength(reader.u64(), 'metadata count');
    const meta = {};
    const wanted = new Map();
    for (let i = 0; i < count; i += 1) {
      const key = reader.string();
      const type = reader.u32();
      if (key === 'general.architecture') {
        meta.architecture = readValue(reader, type);
        for (const [suffix, field] of Object.entries(ARCH_KEYS)) wanted.set(`${meta.architecture}.${suffix}`, field);
      } else if (wanted.has(key)) {
        meta[wanted.get(key)] = readValue(reader, type);
      } else {
        skipValue(reader, type);
      }
    }
    return meta.architecture ? meta : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * KV-cache footprint of a model.
 * @param {ReturnType<typeof readGgufAttentionMetadata>} meta attention metadata.
 * @returns {{perTokenBytes:number, fixedBytes:number}|null} bytes that grow with every
 *   context token (full-attention layers) and constant bytes (sliding-window layers at their
 *   window); null when the metadata cannot size the cache.
 */
export function kvFootprint(meta) {
  const layers = meta?.blockCount;
  const heads = meta?.headCountKv;
  if (!Number.isInteger(layers) || layers <= 0 || heads == null) return null;
  const derived = meta.embeddingLength && meta.headCount ? meta.embeddingLength / meta.headCount : null;
  const keyLength = meta.keyLength ?? derived;
  const valueLength = meta.valueLength ?? derived;
  if (!keyLength || !valueLength) return null;
  let perTokenBytes = 0;
  let fixedBytes = 0;
  for (let layer = 0; layer < layers; layer += 1) {
    // llama.cpp: a hybrid layer is attention only when (il + 1) % full_attention_interval == 0.
    if (meta.fullAttentionInterval && (layer + 1) % meta.fullAttentionInterval !== 0) continue;
    const layerHeads = Array.isArray(heads) ? (heads[layer] ?? 0) : heads;
    if (meta.slidingWindow && Array.isArray(meta.slidingWindowPattern) && meta.slidingWindowPattern[layer]) {
      fixedBytes += layerHeads * ((meta.keyLengthSwa ?? keyLength) + (meta.valueLengthSwa ?? valueLength))
        * KV_BYTES_PER_ELEMENT * meta.slidingWindow;
    } else {
      perTokenBytes += layerHeads * (keyLength + valueLength) * KV_BYTES_PER_ELEMENT;
    }
  }
  return { perTokenBytes, fixedBytes };
}
