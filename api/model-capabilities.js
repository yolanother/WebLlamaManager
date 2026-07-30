// Llama Manager — GGUF-backed multimodal capability discovery for local models.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This module reads only the GGUF metadata header of a model projector and
// reports whether its CLIP tower has vision and audio encoders. It owns model-
// directory lookup and caching so request routing never reparses projector files.

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';

const GGUF_TYPES = Object.freeze({
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
});

const FIXED_TYPE_BYTES = new Map([
  [GGUF_TYPES.UINT8, 1],
  [GGUF_TYPES.INT8, 1],
  [GGUF_TYPES.UINT16, 2],
  [GGUF_TYPES.INT16, 2],
  [GGUF_TYPES.UINT32, 4],
  [GGUF_TYPES.INT32, 4],
  [GGUF_TYPES.FLOAT32, 4],
  [GGUF_TYPES.BOOL, 1],
  [GGUF_TYPES.UINT64, 8],
  [GGUF_TYPES.INT64, 8],
  [GGUF_TYPES.FLOAT64, 8],
]);

const CAPABILITY_KEYS = Object.freeze({
  'clip.has_vision_encoder': 'vision',
  'clip.has_audio_encoder': 'audio',
});

/**
 * Convert a GGUF unsigned 64-bit length to a safe JavaScript number.
 *
 * @param {bigint} value GGUF length or count.
 * @param {string} label field name used in malformed-file errors.
 * @returns {number} safe non-negative integer.
 * @throws {Error} When the value cannot be represented safely.
 */
function safeLength(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`GGUF ${label} exceeds JavaScript's safe integer range`);
  }
  return Number(value);
}

/**
 * Build a small positional reader over an open GGUF file descriptor.
 *
 * @param {number} fd open file descriptor.
 * @returns {{position:number, bytes:function(number):Buffer, skip:function(number):void, u8:function():number, u32:function():number, u64:function():bigint, string:function():string}} reader helpers.
 */
function createReader(fd) {
  return {
    position: 0,
    bytes(length) {
      const buffer = Buffer.allocUnsafe(length);
      const bytesRead = readSync(fd, buffer, 0, length, this.position);
      if (bytesRead !== length) throw new Error('Unexpected end of GGUF metadata');
      this.position += length;
      return buffer;
    },
    skip(length) {
      if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid GGUF metadata length');
      this.position += length;
    },
    u8() {
      return this.bytes(1).readUInt8(0);
    },
    u32() {
      return this.bytes(4).readUInt32LE(0);
    },
    u64() {
      return this.bytes(8).readBigUInt64LE(0);
    },
    string() {
      const length = safeLength(this.u64(), 'string length');
      return this.bytes(length).toString('utf8');
    },
  };
}

/**
 * Advance over one GGUF metadata value without materializing it.
 *
 * @param {ReturnType<typeof createReader>} reader positional GGUF reader.
 * @param {number} type GGUF metadata value type.
 * @returns {void}
 * @throws {Error} When the value type or encoded length is invalid.
 */
function skipValue(reader, type) {
  const fixedBytes = FIXED_TYPE_BYTES.get(type);
  if (fixedBytes) {
    reader.skip(fixedBytes);
    return;
  }
  if (type === GGUF_TYPES.STRING) {
    reader.skip(safeLength(reader.u64(), 'string length'));
    return;
  }
  if (type === GGUF_TYPES.ARRAY) {
    const elementType = reader.u32();
    const count = safeLength(reader.u64(), 'array length');
    const elementBytes = FIXED_TYPE_BYTES.get(elementType);
    if (elementBytes) {
      reader.skip(count * elementBytes);
      return;
    }
    for (let index = 0; index < count; index += 1) skipValue(reader, elementType);
    return;
  }
  throw new Error(`Unsupported GGUF metadata type ${type}`);
}

/**
 * Read a capability flag encoded as a GGUF boolean and skip unexpected types.
 *
 * @param {ReturnType<typeof createReader>} reader positional GGUF reader.
 * @param {number} type GGUF metadata value type.
 * @returns {boolean} decoded flag, or false for a non-boolean value.
 */
function readCapabilityFlag(reader, type) {
  if (type === GGUF_TYPES.BOOL) return reader.u8() !== 0;
  skipValue(reader, type);
  return false;
}

/**
 * Parse CLIP vision/audio capability flags from a projector GGUF header.
 * Tensor data is never read, so this is safe for multi-gigabyte projectors.
 *
 * @param {string} projectorPath absolute path to an mmproj GGUF file.
 * @returns {{vision:boolean, audio:boolean}} projector encoder capabilities.
 * @throws {Error} When the file is not a readable, supported GGUF file.
 */
export function parseGgufCapabilities(projectorPath) {
  const fd = openSync(projectorPath, 'r');
  try {
    const reader = createReader(fd);
    if (reader.bytes(4).toString('ascii') !== 'GGUF') throw new Error('Invalid GGUF magic');
    const version = reader.u32();
    if (version < 2 || version > 3) throw new Error(`Unsupported GGUF version ${version}`);
    reader.u64(); // tensor count; tensor metadata starts after the KV table.
    const metadataCount = safeLength(reader.u64(), 'metadata count');
    const capabilities = { vision: false, audio: false };

    for (let index = 0; index < metadataCount; index += 1) {
      const key = reader.string();
      const type = reader.u32();
      const capability = CAPABILITY_KEYS[key];
      if (capability) {
        capabilities[capability] = readCapabilityFlag(reader, type);
        if (capabilities.vision && capabilities.audio) return capabilities;
      } else {
        skipValue(reader, type);
      }
    }
    return capabilities;
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolve the directory that should contain a model's companion projector.
 * Model records may supply an absolute scan path, a relative OpenAI model id,
 * or an alias target.
 *
 * @param {string} modelsDir root directory scanned by llama.cpp router mode.
 * @param {string|object} model model id or catalog record.
 * @returns {string} absolute directory to search for an mmproj GGUF.
 */
function modelDirectory(modelsDir, model) {
  const record = typeof model === 'string' ? { id: model } : model;
  const reference = record?.path || record?.aliasTarget || record?.id || record?.name || '';
  const candidate = isAbsolute(reference) ? reference : join(modelsDir, reference);
  try {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  } catch {
    // A concurrently removed model falls back to its expected parent directory.
  }
  if (/\.gguf$/i.test(reference) || String(reference).includes('/')) return dirname(candidate);
  return modelsDir;
}

/**
 * Reduce model/projector filenames to a family identity suitable for matching
 * quantized model files with differently quantized mmproj companions.
 *
 * @param {string} value filename or directory name.
 * @returns {string} lowercase alphanumeric model-family identity.
 */
function modelIdentity(value) {
  return basename(String(value || '')).replace(/\.gguf$/i, '').toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token
      && token !== 'mmproj'
      && token !== 'gguf'
      && token !== 'ud'
      && token !== 'k'
      && token !== 'm'
      && token !== 's'
      && token !== 'xl'
      && token !== '0'
      && !/^(?:q|iq)\d/.test(token)
      && !/^(?:f|fp|bf)\d+$/.test(token))
    .join('');
}

/**
 * Determine whether two normalized identities unambiguously name one family.
 *
 * @param {string} left first normalized identity.
 * @param {string} right second normalized identity.
 * @returns {boolean} whether the identities are equal or one qualifies the other.
 */
function relatedIdentity(left, right) {
  if (!left || !right) return false;
  return left === right || (Math.min(left.length, right.length) >= 5
    && (left.includes(right) || right.includes(left)));
}

/**
 * List projector GGUF paths in a directory without parsing their headers.
 *
 * @param {string} directory model file directory.
 * @returns {string[]} sorted absolute projector paths.
 */
function listProjectors(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /mmproj.*\.gguf$/i.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .map(name => join(directory, name));
  } catch {
    return [];
  }
}

/**
 * Select a projector associated with a specific model, never merely the first
 * projector in a shared directory.
 *
 * @param {string} modelsDir root models directory.
 * @param {string} directory resolved model directory.
 * @param {string|object} model model id or catalog record.
 * @param {string[]} projectors cached projector paths in the directory.
 * @returns {string|null} associated projector path, or null when ambiguous/unrelated.
 */
function associatedProjector(modelsDir, directory, model, projectors) {
  const record = typeof model === 'string' ? { id: model } : model;
  const reference = record?.path || record?.aliasTarget || record?.id || record?.name || '';
  const modelFamily = modelIdentity(reference);
  const matches = projectors.filter(path => relatedIdentity(modelFamily, modelIdentity(path)));
  if (matches.length) {
    const families = new Set(matches.map(modelIdentity));
    return families.size === 1 ? matches[0] : null;
  }

  // A generically named sole `mmproj.gguf` is safe only when the nested directory
  // itself clearly names the requested model family. Never inherit it at root.
  if (projectors.length === 1 && resolve(directory) !== resolve(modelsDir)) {
    const projectorFamily = modelIdentity(projectors[0]);
    if (!projectorFamily && relatedIdentity(modelFamily, modelIdentity(directory))) return projectors[0];
  }
  return null;
}

/**
 * Create a cached resolver for models under one llama.cpp models directory.
 * Each model directory is scanned and its projector parsed at most once for the
 * lifetime of the resolver. `source` distinguishes explicit projector metadata
 * from the no-projector case used by routing's legacy name fallback.
 *
 * @param {string} modelsDir root directory scanned by llama.cpp router mode.
 * @param {{parse?: function(string): {vision:boolean,audio:boolean}}} [options] injectable parser for tests.
 * @returns {function(string|object): {vision:boolean,audio:boolean,source:'mmproj'|'none'}} cached capability resolver.
 */
export function createModelCapabilityResolver(modelsDir, { parse = parseGgufCapabilities } = {}) {
  const directoryCache = new Map();
  const projectorCache = new Map();
  const modelCache = new Map();
  return model => {
    const directory = modelDirectory(modelsDir, model);
    const record = typeof model === 'string' ? { id: model } : model;
    const reference = record?.path || record?.aliasTarget || record?.id || record?.name || '';
    const cacheKey = `${directory}\0${reference}`;
    if (modelCache.has(cacheKey)) return modelCache.get(cacheKey);
    if (!directoryCache.has(directory)) directoryCache.set(directory, listProjectors(directory));
    const projectorPath = associatedProjector(modelsDir, directory, model, directoryCache.get(directory));
    let result = { vision: false, audio: false, source: 'none' };
    if (projectorPath) {
      if (!projectorCache.has(projectorPath)) {
        try {
          projectorCache.set(projectorPath, Object.freeze({ ...parse(projectorPath), source: 'mmproj' }));
        } catch {
          // A present but malformed projector is explicit unknown/false metadata;
          // do not crash model listing or silently promote it by filename regex.
          projectorCache.set(projectorPath, Object.freeze({ vision: false, audio: false, source: 'mmproj' }));
        }
      }
      result = projectorCache.get(projectorPath);
    }
    const frozen = Object.isFrozen(result) ? result : Object.freeze(result);
    modelCache.set(cacheKey, frozen);
    return frozen;
  };
}

/**
 * Convert projector flags to the ordered modality list exposed by `/v1/models`.
 * Text is always present because every listed inference model accepts text.
 *
 * @param {{vision?:boolean,audio?:boolean}|null|undefined} capabilities resolved projector flags.
 * @returns {Array<'text'|'image'|'audio'>} ordered OpenAI-facing modalities.
 */
export function modalitiesForCapabilities(capabilities) {
  const modalities = ['text'];
  if (capabilities?.vision) modalities.push('image');
  if (capabilities?.audio) modalities.push('audio');
  return modalities;
}

/**
 * Add ordered modalities and projector-source metadata to model-list entries.
 * Alias records are passed through unchanged to the resolver, which follows
 * their `aliasTarget` when locating the companion model directory.
 *
 * @param {Array<object>} models OpenAI-style model-list entries.
 * @param {function(object): {vision:boolean,audio:boolean,source:'mmproj'|'none'}} resolveCapabilities cached model resolver.
 * @param {Array<{name?:string,path?:string}>} [localModels] scanned local records used to map bare live-router ids to disk paths.
 * @returns {Array<object>} copied entries with `modalities` and `capabilitySource`.
 */
export function addModelCapabilityMetadata(models, resolveCapabilities, localModels = []) {
  const localByReference = new Map();
  const addLocalReference = (reference, local) => {
    const key = String(reference || '').toLowerCase();
    if (!key) return;
    localByReference.set(key, localByReference.has(key) ? null : local);
  };
  for (const local of localModels) {
    addLocalReference(local.name, local);
    addLocalReference(local.path, local);
    addLocalReference(basename(local.name || local.path || ''), local);
  }

  return models.map(model => {
    const reference = model.aliasTarget || model.id || model.name || '';
    const local = localByReference.get(String(reference).toLowerCase())
      || localByReference.get(basename(String(reference)).toLowerCase());
    const resolutionRecord = local
      ? { ...model, name: local.name, path: local.path }
      : model;
    const capabilities = resolveCapabilities(resolutionRecord);
    return {
      ...model,
      modalities: modalitiesForCapabilities(capabilities),
      capabilitySource: capabilities.source,
    };
  });
}
