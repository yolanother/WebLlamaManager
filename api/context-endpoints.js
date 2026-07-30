// Llama Manager — exact token-count and prepared-context upstream contracts.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Builds safe llama.cpp requests for exact OpenAI chat/Responses input counting
// and KV preparation. Manager-only identity, prepared-handle, and raw slot
// controls are removed before proxying so actual slot ownership remains local.

import { CONTEXT_CACHE_CONTRACT_VERSION } from './context-cache.js';

const COUNT_PATHS = Object.freeze({
  chat: '/v1/chat/completions/input_tokens',
  responses: '/v1/responses/input_tokens',
});

const MANAGER_ONLY_FIELDS = new Set([
  'id_slot',
  'cache_prompt',
  'prepared_context_id',
  'conversation_cache_key',
  'prompt_cache_key',
  'context_cache_strict',
  'request_priority',
  'priority_class',
  'routing',
]);

/** Error returned when a native context operation fails upstream. */
export class ContextUpstreamError extends Error {
  /**
   * Create an upstream operation error.
   *
   * @param {string} message Safe diagnostic message.
   * @param {number} status HTTP status suitable for the manager response.
   * @param {string} [details] Bounded upstream response detail.
   */
  constructor(message, status = 502, details = '') {
    super(message);
    this.name = 'ContextUpstreamError';
    this.status = status;
    this.details = details;
  }
}

/**
 * Copy a generation/count body while removing fields controlled exclusively by
 * Llama Manager. The resolved model is always written explicitly.
 *
 * @param {Record<string, unknown>} body Caller request body.
 * @param {string} resolvedModel Alias-resolved model id.
 * @returns {Record<string, unknown>} Safe upstream body.
 */
export function managerControlledContextBody(body = {}, resolvedModel) {
  const safe = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (!MANAGER_ONLY_FIELDS.has(key)) safe[key] = value;
  }
  safe.model = resolvedModel;
  return safe;
}

/**
 * Call llama.cpp's native exact OpenAI input-token endpoint. These endpoints
 * apply the same template, tools, tokenizer, and multimodal processing as real
 * generation, so their result is authoritative for the resolved local model.
 *
 * @param {Object} input Count operation inputs.
 * @param {'chat'|'responses'} input.kind OpenAI request family.
 * @param {string} input.baseUrl llama.cpp/router base URL.
 * @param {string} input.requestedModel Original caller model or alias.
 * @param {string} input.resolvedModel Concrete model sent upstream.
 * @param {string} input.engine Effective serving engine.
 * @param {Record<string, unknown>} input.body Original request body.
 * @param {typeof fetch} [input.fetchImpl] Injectable fetch implementation.
 * @param {AbortSignal} [input.signal] Optional cancellation signal.
 * @returns {Promise<Record<string, unknown>>} Exact count plus manager metadata.
 * @throws {TypeError|ContextUpstreamError} For invalid input/upstream failure.
 */
export async function requestExactInputTokens({
  kind,
  baseUrl,
  requestedModel,
  resolvedModel,
  engine,
  body,
  fetchImpl = fetch,
  signal,
} = {}) {
  const path = COUNT_PATHS[kind];
  if (!path) throw new TypeError(`unsupported input-token request kind: ${kind}`);
  if (!baseUrl || !resolvedModel) throw new TypeError('baseUrl and resolvedModel are required');
  const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(managerControlledContextBody(body, resolvedModel)),
    signal,
  });
  if (!response.ok) {
    const details = (await response.text().catch(() => '')).slice(0, 1000);
    throw new ContextUpstreamError(`exact ${kind} input counting failed`, response.status, details);
  }
  const data = await response.json();
  if (!Number.isInteger(data?.input_tokens) || data.input_tokens < 0) {
    throw new ContextUpstreamError(`exact ${kind} input counting returned an invalid response`, 502);
  }
  return {
    object: data.object || 'response.input_tokens',
    input_tokens: data.input_tokens,
    requested_model: requestedModel,
    resolved_model: resolvedModel,
    engine,
    context_cache_contract: CONTEXT_CACHE_CONTRACT_VERSION,
  };
}
