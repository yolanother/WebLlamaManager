// Llama Manager — embedding helpers.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, side-effect-free helpers for the OpenAI-compatible embeddings feature:
// resolving the dedicated embed server's config (config.json + env overrides),
// building its local target URL, estimating token counts for telemetry, and
// shaping LLM-log entries. Kept separate from server.js so it can be unit-tested
// without booting the server.

const DEFAULTS = { port: 5252, gpuLayers: 99, ctxSize: 0 };

/**
 * Resolve the embedding server configuration from config.json + environment.
 * Env (EMBED_*) overrides the config.embed block; both fall back to defaults.
 * @param {object} config Parsed config.json (may lack an `embed` block).
 * @param {object} env Environment object (e.g. process.env).
 * @returns {{enabled:boolean, model:string, port:number, gpuLayers:number, ctxSize:number, runnable:boolean}}
 *   `runnable` is true only when enabled AND a model is set (i.e. safe to spawn).
 */
export function resolveEmbedConfig(config = {}, env = {}) {
  const e = config.embed || {};
  const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  const enabled = env.EMBED_ENABLED !== undefined
    ? env.EMBED_ENABLED === 'true'
    : Boolean(e.enabled);
  const model = env.EMBED_MODEL !== undefined ? env.EMBED_MODEL : (e.model || '');
  const port = num(env.EMBED_PORT, num(e.port, DEFAULTS.port));
  const gpuLayers = num(env.EMBED_GPU_LAYERS, num(e.gpuLayers, DEFAULTS.gpuLayers));
  const ctxSize = num(env.EMBED_CTX, num(e.ctxSize, DEFAULTS.ctxSize));
  return { enabled, model, port, gpuLayers, ctxSize, runnable: enabled && !!model };
}

/**
 * Local URL of the dedicated embed server's OpenAI embeddings endpoint.
 * @param {number} port EMBED_PORT.
 * @returns {string}
 */
export function embedTargetUrl(port) {
  return `http://localhost:${port}/v1/embeddings`;
}

/**
 * Rough whitespace token estimate used only for telemetry when the upstream
 * response lacks a usage.prompt_tokens count. Accepts a string or string[].
 * @param {string|string[]|undefined} input
 * @returns {number}
 */
export function estimateEmbedTokens(input) {
  const count = (s) => (typeof s === 'string' && s.trim() ? s.trim().split(/\s+/).length : 0);
  if (Array.isArray(input)) return input.reduce((a, s) => a + count(s), 0);
  return count(input);
}

/**
 * Build an LLM-log entry for an embeddings request (mirrors the chat path's
 * shape). completionTokens is always 0 (embeddings do not generate).
 * @param {{reqBody:object, usage?:object|null, status:number, durationMs:number, backend:string, error?:string|null}} a
 * @returns {object} entry for addLlmLog()
 */
export function buildEmbedLogEntry({ reqBody, usage, status, durationMs, backend, error = null }) {
  const promptTokens = usage && typeof usage.prompt_tokens === 'number'
    ? usage.prompt_tokens
    : estimateEmbedTokens(reqBody?.input);
  return {
    endpoint: 'embeddings',
    model: reqBody?.model || 'unknown',
    stream: false,
    status,
    duration: durationMs,
    promptTokens,
    completionTokens: 0,
    tokensPerSecond: 0,
    messages: null,
    prompt: null,
    response: null,
    error,
    backend,
    requestBody: reqBody
  };
}
