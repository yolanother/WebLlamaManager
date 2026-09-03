// Llama Manager — exact token-count and prepared-context upstream contracts.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Builds safe llama.cpp requests for exact OpenAI chat/Responses input counting,
// KV preparation, and text-only suffix composition with a retained prepared
// prefix. Manager-only identity, prepared-handle, and raw slot controls are
// removed before proxying so actual slot ownership remains local.
// The exact-count call optionally brackets itself on a timing-evidence recorder
// so input tokenization is measured discretely and never inferred from prefill.

import { canonicalHash, CONTEXT_CACHE_CONTRACT_VERSION } from './context-cache.js';

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
  'mode',
  'allow_model_load',
]);

const PREFIX_FIELDS = Object.freeze([
  'messages', 'input', 'prompt', 'tools', 'tool_choice', 'response_format',
  'chat_template', 'chat_template_kwargs', 'reasoning_format',
]);

/** Clone JSON-compatible request data so retained prefixes cannot be mutated by callers. */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Build a fail-closed append-mode validation error for the HTTP handler. */
function appendConflict(message, code = 'PREPARED_CONTEXT_APPEND_CONFLICT') {
  const error = new TypeError(message);
  error.statusCode = 409;
  error.code = code;
  return error;
}

/**
 * Compose a retained prepared-context prefix with a text-only message suffix.
 *
 * Input-affecting fields other than `messages` always come from the retained
 * prefix. A suffix may repeat an identical value but cannot replace, add, or
 * otherwise conflict with prepared template/tool/input state. Output controls
 * and manager scheduling fields remain caller-controlled through `suffixBody`.
 *
 * @param {Object} input Append composition inputs.
 * @param {Record<string, unknown>} input.preparedBody Private prepared request copy.
 * @param {Record<string, unknown>} input.suffixBody Caller append-mode request.
 * @returns {Record<string, unknown>} New full request body with prefix and suffix messages.
 * @throws {TypeError} With statusCode 409 when retained state or suffix input is unsafe.
 */
export function composePreparedContextAppend({ preparedBody, suffixBody } = {}) {
  if (!preparedBody || typeof preparedBody !== 'object' || !Array.isArray(preparedBody.messages)) {
    throw appendConflict('prepared context does not retain a reusable message prefix', 'PREPARED_CONTEXT_PREFIX_UNAVAILABLE');
  }
  if (!suffixBody || typeof suffixBody !== 'object' || !Array.isArray(suffixBody.messages) || suffixBody.messages.length === 0) {
    throw appendConflict('append mode requires a non-empty messages suffix');
  }
  for (const message of suffixBody.messages) {
    if (!message || typeof message !== 'object' || typeof message.role !== 'string' || typeof message.content !== 'string') {
      throw appendConflict('append mode accepts text-only message suffixes', 'PREPARED_CONTEXT_MULTIMODAL_UNSUPPORTED');
    }
  }

  const composed = cloneJson(suffixBody);
  for (const field of PREFIX_FIELDS) {
    if (field === 'messages') continue;
    const preparedValue = preparedBody[field];
    if (suffixBody[field] !== undefined && (
      preparedValue === undefined || canonicalHash(suffixBody[field]) !== canonicalHash(preparedValue)
    )) {
      throw appendConflict(`append mode cannot replace prepared field: ${field}`);
    }
    if (preparedValue !== undefined) composed[field] = cloneJson(preparedValue);
    else delete composed[field];
  }
  composed.messages = [...cloneJson(preparedBody.messages), ...cloneJson(suffixBody.messages)];
  return composed;
}

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
 * Hash only request fields that can change rendered input, excluding output
 * controls such as streaming and maximum generated tokens.
 * @param {Record<string, unknown>} body Original request body.
 * @param {string} resolvedModel Concrete model identity.
 * @returns {string} Opaque request-prefix hash used for handle validation.
 */
export function contextPrefixRequestHash(body = {}, resolvedModel) {
  const material = { model: resolvedModel };
  for (const field of PREFIX_FIELDS) {
    if (body?.[field] !== undefined) material[field] = body[field];
  }
  return `request_${canonicalHash(material).slice(0, 40)}`;
}

/**
 * Ask llama.cpp to render the exact chat template and return only its hash.
 * Raw rendered prompt text never leaves this trusted helper.
 *
 * @param {Object} input Render operation inputs.
 * @returns {Promise<{prefix_hash:string}>} Exact rendered-prefix fingerprint.
 */
export async function requestRenderedPrefix({
  baseUrl,
  resolvedModel,
  body,
  fetchImpl = fetch,
  signal,
} = {}) {
  if (!baseUrl || !resolvedModel) throw new TypeError('baseUrl and resolvedModel are required');
  const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/apply-template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(managerControlledContextBody(body, resolvedModel)),
    signal,
  });
  if (!response.ok) {
    const details = (await response.text().catch(() => '')).slice(0, 1000);
    throw new ContextUpstreamError('exact chat-template rendering failed', response.status, details);
  }
  const data = await response.json();
  const prompt = typeof data?.prompt === 'string' ? data.prompt : data?.content;
  if (typeof prompt !== 'string') {
    throw new ContextUpstreamError('exact chat-template rendering returned an invalid response', 502);
  }
  return { prefix_hash: `prefix_${canonicalHash(prompt).slice(0, 40)}` };
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
 * @param {import('./timing-evidence.js').TimingEvidenceRecorder} [input.recorder]
 *   Optional timing recorder. When supplied, the discrete upstream tokenization
 *   call — and nothing else — is bracketed by the `tokenization_started` and
 *   `tokenization_completed` lifecycle marks. A failed or aborted call leaves
 *   `tokenization_completed` unmarked so the dimension reports an explicit
 *   unsupported reason rather than a synthesized duration.
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
  recorder,
} = {}) {
  const path = COUNT_PATHS[kind];
  if (!path) throw new TypeError(`unsupported input-token request kind: ${kind}`);
  if (!baseUrl || !resolvedModel) throw new TypeError('baseUrl and resolvedModel are required');
  recorder?.mark('tokenization_started');
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
  recorder?.mark('tokenization_completed');
  return {
    object: data.object || 'response.input_tokens',
    input_tokens: data.input_tokens,
    requested_model: requestedModel,
    resolved_model: resolvedModel,
    engine,
    context_cache_contract: CONTEXT_CACHE_CONTRACT_VERSION,
  };
}
