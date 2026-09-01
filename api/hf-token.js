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
 * @param {{output?:string, exitCode?:number, forkpty?:boolean, hasToken?:boolean, cliMissing?:boolean, packaged?:boolean}} a
 * @returns {string}
 */
export function actionableDownloadError({ output = '', exitCode = 1, forkpty = false, hasToken = false, cliMissing = false, packaged = false }) {
  if (forkpty) {
    return 'PTY allocation failed (forkpty). Restart the Llama Manager service and retry.';
  }
  if (cliMissing) {
    // Checked FIRST: with no downloader installed every other explanation is
    // wrong. node-pty surfaces a missing binary as exit 1, not 127, so the
    // caller's "exit code 127" branch never catches this and the operator was
    // being told to check the network for a program that was never installed.
    // The remedy differs by install kind, and giving the wrong one is its own
    // dead end: an appliance is a packaged image with no ./install.sh to run,
    // so pointing there sends the operator hunting for a file that is not
    // present. On an appliance a missing downloader is a defect in the image,
    // and saying so plainly is more useful than a command that cannot work.
    return packaged
      ? 'Download failed: the model downloader (HuggingFace CLI) is not installed on this appliance, so no model can be downloaded. This is missing from the installed image rather than something you have misconfigured.'
      : 'Download failed: the model downloader (HuggingFace CLI) is not installed on this system, so no model can be downloaded. Run ./install.sh to set up the Python environment.';
  }
  if (isGatedOutput(output)) {
    return hasToken
      ? 'Download failed: access denied (gated model). Your HuggingFace token may lack access — accept the model license on huggingface.co, then retry.'
      : 'Download failed: this model is gated. Add a HuggingFace token in Settings (and accept the model license on huggingface.co), then retry.';
  }
  if (!hasToken) {
    // Nothing in the output says "gated", but no token is configured either.
    // On a fresh appliance that is the most common cause and the cheapest thing
    // to rule out, so name it -- while still stating what actually happened, so
    // an operator whose failure is really network or model-path is not sent
    // chasing a token. Deliberately phrased as "no token is configured", a fact,
    // rather than "the token is the problem", a guess.
    return `Download failed (exit code ${exitCode}). No HuggingFace token is configured — many models need one. Add a token in Settings and retry; if one is not needed, check the output for a network or model-path issue.`;
  }
  return `Download failed (exit code ${exitCode}). Check the output for details (network or model-path issue).`;
}
