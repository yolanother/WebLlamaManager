// Llama Manager — one stable key for "is this the same model?".
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// The manager learns about a model from two independent places that name it
// differently: the running llama.cpp router reports an id ("Qwen3-8B-Q4_K_M"),
// while the filesystem scan reports a filename ("Qwen3-8B-Q4_K_M.gguf"). Any
// code that merges those two lists has to decide whether it is looking at one
// model or two, and getting it wrong is directly visible — /api/v1/models
// deduped on a key that kept the extension, so the chat model picker listed the
// same model twice, once per source.
//
// Kept as its own module, and pure, because server.js cannot be imported by a
// test without starting a real HTTP server and an engine.

// Extensions a local model file may carry. Only these are stripped, and only
// from the end: "gguf" inside a name ("gguf-tuned-model") is part of the name.
const MODEL_EXTENSIONS = ['.gguf', '.bin', '.safetensors'];

/**
 * Collapse a model id or filename to a comparable key.
 *
 * Strips a trailing model file extension, lowercases, and removes every
 * non-alphanumeric character, so punctuation and casing differences between the
 * router's id and the on-disk filename do not read as different models.
 *
 * Deliberately does NOT collapse split-part suffixes (`-00001-of-00004`): those
 * are distinct files the router treats specially, and merging a part into the
 * base model would hide it.
 *
 * @param {string} name A model id or filename, from either source.
 * @returns {string} A normalized key; '' for empty or non-string input.
 */
export function normalizeModelKey(name) {
  let s = String(name ?? '');
  const lower = s.toLowerCase();
  for (const ext of MODEL_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      s = s.slice(0, -ext.length);
      break;
    }
  }
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}
