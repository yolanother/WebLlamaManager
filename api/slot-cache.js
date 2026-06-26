// Llama Manager — slot KV-cache disk persistence (pure decision logic).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// The `--models-dir` router evicts and reloads child llama-server processes
// (especially the large gpt-oss-120b) as models are swapped under MODELS_MAX.
// Every reload drops all per-slot KV caches, so previously-warmed conversations
// get re-prefilled cold on their next turn — the dominant latency cost on this
// box. llama.cpp (build 9820) can persist a slot's KV cache to disk via
// `--slot-save-path` + `POST /slots/{id}?action=save|restore`. This module
// holds the PURE policy that the manager (api/server.js) uses to drive that:
// deriving a stable on-disk filename for a conversation, deciding when a saved
// slot should be restored (only into a cold slot, never disturbing a warm or
// in-flight one), and bounding disk usage by evicting the oldest dumps. Pure so
// the policy is unit-testable without touching the filesystem or the router.

import { createHash } from 'crypto';

/**
 * Derive a deterministic, filesystem-safe filename for a conversation's slot
 * dump from its prefix-cache key (`${model}|${prefixHash}`). The key contains
 * `/` and `|`, so we hash it rather than sanitize, keeping names short and
 * collision-resistant.
 *
 * @param {string} convKey - The conversation prefix-cache key.
 * @returns {string} A filename of the form `slot_<sha1>.bin`.
 */
export function slotCacheFilename(convKey) {
  const h = createHash('sha1').update(String(convKey)).digest('hex');
  return `slot_${h}.bin`;
}

/**
 * Decide which saved slot files to evict so the on-disk cache stays under both
 * a total-byte cap and a file-count cap. Oldest dumps (by `savedAt`) are evicted
 * first. The most recently written file should be passed as `keep` so a just-
 * saved dump is never immediately evicted, even when it is (transiently) the
 * oldest record in the list.
 *
 * @param {Object} args
 * @param {Array<{filename:string,bytes:number,savedAt:number}>} args.files - Current dumps.
 * @param {number} args.maxBytes - Total byte budget for all dumps.
 * @param {number} args.maxCount - Maximum number of dumps to retain.
 * @param {string} [args.keep] - A filename that must never be evicted.
 * @returns {string[]} Filenames to delete, oldest-first.
 */
export function planSlotEviction({ files, maxBytes, maxCount, keep }) {
  const sorted = [...(files || [])].sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
  let totalBytes = sorted.reduce((s, f) => s + (f.bytes || 0), 0);
  let count = sorted.length;
  const evict = [];
  for (const f of sorted) {
    if (totalBytes <= maxBytes && count <= maxCount) break;
    if (keep && f.filename === keep) continue; // never evict the protected file
    evict.push(f.filename);
    totalBytes -= (f.bytes || 0);
    count -= 1;
  }
  return evict;
}

/**
 * Decide whether to restore a conversation's saved slot dump before proxying a
 * request. Restore only when (a) a dump exists for the conversation AND (b) the
 * target slot is cold — empty and not currently processing. A warm slot already
 * holds matching (or reusable) KV, and a busy slot must not be disturbed; in
 * both cases restoring would waste work or corrupt in-flight inference. A
 * missing slot entry is treated as cold (e.g. just after a child reload).
 *
 * @param {Object} args
 * @param {Object|null} args.savedFile - The dump record for the conversation, or null.
 * @param {Object|null} args.slotState - The `/slots` entry for the target slot id, or null.
 * @returns {boolean} True if the dump should be restored into the slot.
 */
export function shouldRestoreSlot({ savedFile, slotState }) {
  if (!savedFile) return false;
  if (!slotState) return true; // slot unknown => treat as cold
  if (slotState.is_processing) return false;
  return (slotState.n_prompt_tokens || 0) === 0;
}
