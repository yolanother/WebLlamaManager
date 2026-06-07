// Llama Manager — HuggingFace token helpers.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, side-effect-free helpers for resolving and protecting the HuggingFace
// token. The token may be stored in config.json (preferred, set via Settings) or
// supplied via the HF_TOKEN environment variable (fallback). These helpers keep
// the raw token out of API responses/logs and turn download failures into
// actionable operator messages. Kept separate from server.js for unit testing.

/**
 * Resolve the effective HuggingFace token. A non-blank `config.hfToken` wins;
 * otherwise fall back to `env.HF_TOKEN`. Always returns a trimmed string ('' if none).
 * @param {object} config Parsed config.json (may lack hfToken).
 * @param {object} env Environment object (e.g. process.env).
 * @returns {string}
 */
export function resolveHfToken(config = {}, env = {}) {
  const fromConfig = typeof config.hfToken === 'string' ? config.hfToken.trim() : '';
  if (fromConfig) return fromConfig;
  return (env.HF_TOKEN || '').trim();
}

/**
 * Mask a token for display: first 4 + ellipsis + last 2, or '****' if short.
 * @param {string|undefined} token
 * @returns {string|null} masked form, or null when no token.
 */
export function maskToken(token) {
  if (!token) return null;
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-2)}`;
}

/**
 * Return a shallow copy of config with the raw `hfToken` removed, so config can
 * be returned to clients/logged without leaking the secret. Non-mutating.
 * @param {object} config
 * @returns {object}
 */
export function redactConfig(config = {}) {
  const { hfToken, ...rest } = config;
  return rest;
}

/**
 * Detect whether download output indicates a gated/auth failure.
 * @param {string} output
 * @returns {boolean}
 */
export function isGatedOutput(output) {
  return /\b401\b|\b403\b|gated|restricted|awaiting a review|access to model|not authorized|must be authenticated|cannot access/i
    .test(String(output || ''));
}

/**
 * Direct URL to a model's HuggingFace page, stripping any `:quant` suffix.
 * @param {string} repo e.g. "google/gemma-4-12B-it-qat-q4_0-gguf:Q4_0"
 * @returns {string|null} the model page URL, or null when repo is empty.
 */
export function hfModelUrl(repo) {
  const r = String(repo || '').trim().split(':')[0];
  return r ? `https://huggingface.co/${r}` : null;
}

/**
 * Build an actionable, user-facing message for a failed model download.
 * @param {{output?:string, exitCode?:number, forkpty?:boolean, hasToken?:boolean}} a
 * @returns {string}
 */
export function actionableDownloadError({ output = '', exitCode = 1, forkpty = false, hasToken = false }) {
  if (forkpty) {
    return 'PTY allocation failed (forkpty). Restart the Llama Manager service and retry.';
  }
  if (isGatedOutput(output)) {
    return hasToken
      ? 'Download failed: access denied (gated model). Your HuggingFace token may lack access — accept the model license on huggingface.co, then retry.'
      : 'Download failed: this model is gated. Add a HuggingFace token in Settings (and accept the model license on huggingface.co), then retry.';
  }
  return `Download failed (exit code ${exitCode}). Check the output for details (network or model-path issue).`;
}
