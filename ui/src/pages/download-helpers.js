// Llama Manager download-page pure helpers.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Pure state/shape helpers behind the Download page's "Recommended models"
// chip row and fit-ranked quantization view. Consumes the
// GET /api/repo/:author/:model/files response — { engine, ggufDir?,
// recommended, quantizations:[{quantization, kind, files, totalSize,
// isSplit, totalParts, pattern, rank, fit, present}] } — and turns it into
// UI-ready buckets and outgoing download requests, so Download.jsx stays a
// thin render layer with no branching logic of its own.

/**
 * The static "Recommended models" chip list shown above the search bar.
 * Each id is an `author/model` HuggingFace repo id the chip pre-fills and
 * loads via selectRepo when clicked.
 * @type {Array<{id: string, label: string}>}
 */
export const RECOMMENDED_REPOS = [
  { id: 'antirez/deepseek-v4-gguf', label: 'DeepSeek V4 Flash' },
  { id: 'unsloth/Muse-Glimmer-30B-GGUF', label: 'Muse Glimmer 30B (vision)' },
  { id: 'Qwen/Qwen3-Embedding-0.6B-GGUF', label: 'Qwen3-Embedding-0.6B' },
  { id: 'nomic-ai/nomic-embed-text-v1.5-GGUF', label: 'nomic-embed-text-v1.5' },
  { id: 'BAAI/bge-m3-GGUF', label: 'BGE-M3' }
];

/**
 * Splits a /repo/:author/:model/files response's quantizations into the
 * buckets the selected-repo view renders in order: the entry matching
 * `data.recommended`, the remaining entries that fit, entries that don't fit,
 * and mmproj (vision projector) entries.
 *
 * Degrades gracefully against a partial/older response shape: an entry
 * without a `fit` object is treated as fitting, and an entry without `kind`
 * is treated as `kind: 'quant'`.
 *
 * @param {object} data - the files-endpoint response (or a partial/absent one).
 * @returns {{recommended: object|null, fits: object[], unfit: object[], mmproj: object[]}}
 */
export function partitionQuantizations(data) {
  const quantizations = (data && data.quantizations) || [];
  const recommendedKey = data && data.recommended;

  let recommended = null;
  const fits = [];
  const unfit = [];
  const mmproj = [];

  for (const q of quantizations) {
    const kind = q.kind || 'quant';
    if (kind === 'mmproj') {
      mmproj.push(q);
      continue;
    }
    if (recommendedKey && !recommended && q.quantization === recommendedKey) {
      recommended = q;
      continue;
    }
    const fits_ = !q.fit || q.fit.fits !== false;
    (fits_ ? fits : unfit).push(q);
  }

  return { recommended, fits, unfit, mmproj };
}

/**
 * Builds the download POST request(s) for one quantization entry, or for
 * the string `'recommended'` (which bundles the first mmproj entry, if any,
 * ahead of the recommended entry's own request).
 *
 * Routes to `/api/ds4/download` when `data.engine === 'ds4'`, otherwise
 * `/api/pull`; both take `{repo, pattern}`. Requires `data.repo` — callers
 * fetching from `/repo/:author/:model/files` must add the repo id onto the
 * response object before calling this (the endpoint itself doesn't echo it).
 *
 * @param {object} data - files-endpoint response plus a `repo` field.
 * @param {object|'recommended'} entry - a quantization entry, or 'recommended'.
 * @returns {Array<{url: '/pull'|'/ds4/download', body: {repo: string, pattern: string}}>}
 */
export function downloadRequests(data, entry) {
  if (!data || !data.repo) return [];
  const url = data.engine === 'ds4' ? '/ds4/download' : '/pull';
  const repo = data.repo;
  const buildRequest = (q) => ({ url, body: { repo, pattern: q.pattern } });

  if (entry === 'recommended') {
    const { recommended, mmproj } = partitionQuantizations(data);
    if (!recommended) return [];
    const requests = [];
    if (mmproj.length > 0) requests.push(buildRequest(mmproj[0]));
    requests.push(buildRequest(recommended));
    return requests;
  }

  if (!entry) return [];
  return [buildRequest(entry)];
}
