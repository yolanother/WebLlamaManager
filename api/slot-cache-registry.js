// Llama Manager — durable, scope-safe slot KV-cache metadata registry.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Persists opaque slot-dump ownership and compatibility metadata beside
// llama.cpp KV files, reconciles it after manager restart, enforces retention
// bounds, and deletes state by authenticated scope/lineage/model. The manifest
// never stores credentials, prompt text, caller identifiers, or token arrays.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** Durable slot registry manifest schema version. */
export const SLOT_CACHE_MANIFEST_VERSION = 1;

const SAFE_SLOT_FILENAME = /^slot_[a-f0-9]{40}\.bin$/;

/** Return the internal unique key for one scoped model lineage. */
function recordKey(record) {
  return `${record.scopeId}\u0000${record.resolvedModel}\u0000${record.lineageKey}`;
}

/**
 * Durable manifest and lifecycle manager for llama.cpp slot cache dumps.
 */
export class DurableSlotCacheRegistry {
  /**
   * Create a registry rooted at one slot-cache directory.
   *
   * @param {Object} options Registry options.
   * @param {string} options.directory Absolute cache directory.
   * @param {string} [options.manifestName='manifest.v1.json'] Manifest basename.
   * @param {number} [options.maxBytes=25769803776] Total retained byte cap.
   * @param {number} [options.maxCount=64] Retained dump count cap.
   * @param {number} [options.defaultTtlMs=604800000] Default dump TTL.
   * @param {() => number} [options.now] Clock returning epoch milliseconds.
   */
  constructor({
    directory,
    manifestName = 'manifest.v1.json',
    maxBytes = 24 * 1024 * 1024 * 1024,
    maxCount = 64,
    defaultTtlMs = 7 * 24 * 60 * 60_000,
    now = () => Date.now(),
  } = {}) {
    if (!directory) throw new TypeError('slot cache directory is required');
    this.directory = directory;
    this.manifestPath = join(directory, manifestName);
    this.tempManifestPath = join(directory, `${manifestName}.tmp`);
    this.maxBytes = Math.max(0, Number(maxBytes) || 0);
    this.maxCount = Math.max(0, Number(maxCount) || 0);
    this.defaultTtlMs = Math.max(1, Number(defaultTtlMs) || 1);
    this.now = now;
    this.records = new Map();
  }

  /**
   * Load and reconcile the manifest with files present on disk.
   * Invalid, expired, or missing-file records are discarded fail-closed.
   *
   * @returns {{loaded:number,discarded:number}} Reconciliation counts.
   */
  load() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.records.clear();
    let records = [];
    if (existsSync(this.manifestPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.manifestPath, 'utf8'));
        if (parsed?.version === SLOT_CACHE_MANIFEST_VERSION && Array.isArray(parsed.records)) {
          records = parsed.records;
        }
      } catch { /* corrupt manifests fail closed */ }
    }
    let discarded = 0;
    for (const record of records) {
      if (!this.#validRecord(record) || record.expiresAt <= this.now() || !existsSync(this.#filePath(record.filename))) {
        discarded++;
        continue;
      }
      try {
        const bytes = statSync(this.#filePath(record.filename)).size;
        this.records.set(recordKey(record), { ...record, bytes });
      } catch {
        discarded++;
      }
    }
    this.#enforceBounds();
    if (discarded > 0) this.persist();
    return { loaded: this.records.size, discarded };
  }

  /**
   * Add or replace one durable scoped lineage record and persist atomically.
   *
   * @param {Object} input Opaque slot ownership and compatibility metadata.
   * @returns {Object} Stored record.
   * @throws {TypeError} If required metadata or filename is invalid.
   */
  put(input = {}) {
    const now = this.now();
    const record = {
      ...input,
      savedAt: Number(input.savedAt) || now,
      lastUsedAt: now,
      expiresAt: Number(input.expiresAt) || (now + this.defaultTtlMs),
    };
    if (!this.#validRecord(record)) throw new TypeError('invalid durable slot cache record');
    const path = this.#filePath(record.filename);
    if (!existsSync(path)) throw new TypeError('slot cache file does not exist');
    record.bytes = statSync(path).size;
    this.records.set(recordKey(record), record);
    this.#enforceBounds(record.filename);
    this.persist();
    return { ...record };
  }

  /**
   * Find an exact scope/model/lineage/compatibility record.
   *
   * @param {Object} query Required identity fields.
   * @returns {Object|null} Matching record or null without cross-scope detail.
   */
  find(query = {}) {
    const record = this.records.get(recordKey(query));
    if (!record || record.compatibilityHash !== query.compatibilityHash) return null;
    if (record.expiresAt <= this.now() || !existsSync(this.#filePath(record.filename))) {
      this.#removeRecord(record, true);
      this.persist();
      return null;
    }
    record.lastUsedAt = this.now();
    return { ...record };
  }

  /** Atomically persist the redacted, versioned registry manifest. */
  persist() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({
      version: SLOT_CACHE_MANIFEST_VERSION,
      records: [...this.records.values()],
    }, null, 2);
    writeFileSync(this.tempManifestPath, `${body}\n`, { mode: 0o600 });
    renameSync(this.tempManifestPath, this.manifestPath);
    try { chmodSync(this.manifestPath, 0o600); } catch { /* best effort */ }
  }

  /**
   * Delete records matching an owned scope and optional lineage/model filters.
   *
   * @param {{scopeId:string,lineageKey?:string,resolvedModel?:string}} query Scope-bound filters.
   * @returns {{deleted:number,filenames:string[]}} Deletion result.
   */
  invalidate(query = {}) {
    if (!query.scopeId) throw new TypeError('scopeId is required for invalidation');
    const filenames = [];
    for (const record of [...this.records.values()]) {
      if (record.scopeId !== query.scopeId) continue;
      if (query.lineageKey && record.lineageKey !== query.lineageKey) continue;
      if (query.resolvedModel && record.resolvedModel !== query.resolvedModel) continue;
      filenames.push(record.filename);
      this.#removeRecord(record, true);
    }
    if (filenames.length > 0) this.persist();
    return { deleted: filenames.length, filenames };
  }

  /** Return safe manifest records for operator telemetry. */
  list() {
    return [...this.records.values()].map(record => ({ ...record }));
  }

  #validRecord(record) {
    return !!(
      record && record.scopeId && record.lineageKey && record.resolvedModel &&
      record.compatibilityHash && SAFE_SLOT_FILENAME.test(String(record.filename || '')) &&
      Number.isInteger(record.slotId) && record.slotId >= 0 && Number(record.expiresAt) > 0
    );
  }

  #filePath(filename) {
    if (!SAFE_SLOT_FILENAME.test(String(filename || ''))) throw new TypeError('unsafe slot cache filename');
    return join(this.directory, filename);
  }

  #removeRecord(record, unlinkFile) {
    this.records.delete(recordKey(record));
    if (unlinkFile) {
      try { unlinkSync(this.#filePath(record.filename)); } catch { /* already gone */ }
    }
  }

  #enforceBounds(keepFilename) {
    const sorted = [...this.records.values()].sort((a, b) => (a.lastUsedAt || a.savedAt) - (b.lastUsedAt || b.savedAt));
    let bytes = sorted.reduce((sum, record) => sum + (Number(record.bytes) || 0), 0);
    let count = sorted.length;
    for (const record of sorted) {
      if (bytes <= this.maxBytes && count <= this.maxCount) break;
      if (record.filename === keepFilename) continue;
      bytes -= Number(record.bytes) || 0;
      count--;
      this.#removeRecord(record, true);
    }
  }
}
