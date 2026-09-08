// Llama Manager — per-request routing and scheduling extensions.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Parses manager-owned priority and routing controls from OpenAI-compatible
// requests and removes them, along with unsafe raw slot fields, before an
// inference body is sent to llama.cpp, DS4, or remote backends.

import { normalizeRequestPriority } from './request-queue.js';

const ROUTING_MODES = new Set(['auto', 'local_only']);
const MANAGER_FIELDS = new Set([
  'id_slot',
  'cache_prompt',
  'conversation_cache_key',
  'prompt_cache_key',
  'prepared_context_id',
  'context_cache_strict',
  'request_priority',
  'priority_class',
  'routing',
]);

/** Read a case-insensitive request header from a plain object or Fetch Headers. */
function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const exact = headers[name];
  if (exact != null) return Array.isArray(exact) ? exact[0] : exact;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found ? (Array.isArray(found[1]) ? found[1][0] : found[1]) : undefined;
}

/**
 * Parse manager request extensions with headers taking precedence over body fields.
 * @param {Record<string, unknown>} body Caller body.
 * @param {object} headers Caller headers.
 * @returns {{priority:'realtime'|'interactive'|'background',routing:'auto'|'local_only',localOnly:boolean,cachePrompt:false|undefined}}
 *   Policy. `cachePrompt` is false only when the caller explicitly opted out.
 */
export function managerRequestPolicy(body = {}, headers = {}) {
  const priority = normalizeRequestPriority(
    headerValue(headers, 'x-llama-priority') ?? body.request_priority ?? body.priority_class,
  );
  const rawRouting = headerValue(headers, 'x-llama-routing') ?? body.routing ?? 'auto';
  const routing = typeof rawRouting === 'string' ? rawRouting.toLowerCase() : rawRouting;
  if (!ROUTING_MODES.has(routing)) {
    throw new TypeError('routing must be auto or local_only');
  }
  return { priority, routing, localOnly: routing === 'local_only', cachePrompt: cachePromptOptOut(body, headers) };
}

/**
 * Read a caller's opt-out of llama.cpp prompt caching.
 *
 * Opting out is the only thing a caller may say. The manager decides when caching is
 * ON — that is a resource decision, not the caller's — so an explicit `true` is
 * ignored rather than treated as an override. Agentic callers need the opt-out so one
 * turn cannot inherit a previous turn's cached context.
 *
 * Only a real boolean false, or the exact header string "false", counts. The string
 * "false" in the BODY does not: JSON has booleans, and quietly reinterpreting a string
 * would make a typo silently disable caching.
 *
 * @param {Record<string, unknown>} body Caller body.
 * @param {object} headers Caller headers.
 * @returns {false|undefined} False when opted out, otherwise undefined.
 */
function cachePromptOptOut(body, headers) {
  const header = headerValue(headers, 'x-llama-cache-prompt');
  if (typeof header === 'string' && header.trim().toLowerCase() === 'false') return false;
  if (body?.cache_prompt === false) return false;
  return undefined;
}

/**
 * Copy a request body without manager-only or caller-controlled slot fields.
 * @param {Record<string, unknown>} body Original body.
 * @returns {Record<string, unknown>} Safe upstream body.
 */
export function stripManagerRequestFields(body = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (!MANAGER_FIELDS.has(key)) safe[key] = value;
  }
  return safe;
}
