// Llama Manager — safe llama.cpp slot ownership transitions.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Clears server-owned llama.cpp slots before assigning them to a cold
// conversation lineage and waits through transient router child loading before
// inspecting slots for durable restore. These boundaries prevent stale KV state
// from a prior lineage or authorization scope from participating in reuse.

import { classifyUpstreamFailure, upstreamRetryPlan } from './upstream-retry.js';

/** Error raised when Llama Manager cannot establish clean slot ownership. */
export class SlotOwnershipError extends Error {
  /**
   * Create a slot ownership failure.
   *
   * @param {string} message Safe failure detail.
   * @param {number} [status=503] HTTP status suitable for callers.
   */
  constructor(message, status = 503) {
    super(message);
    this.name = 'SlotOwnershipError';
    this.status = status;
    this.statusCode = status;
  }
}

/**
 * Erase a newly assigned llama.cpp slot before a cold lineage uses it.
 *
 * @param {Object} input Erase operation inputs.
 * @param {string} input.baseUrl llama.cpp/router base URL.
 * @param {string} input.model Concrete model whose slot is being assigned.
 * @param {number} input.slotId Server-owned slot identifier.
 * @param {typeof fetch} [input.fetchImpl] Injectable fetch implementation.
 * @param {AbortSignal} [input.signal] Optional cancellation signal.
 * @returns {Promise<true>} True after llama.cpp confirms the erase.
 * @throws {TypeError|SlotOwnershipError} For invalid inputs or erase failure.
 */
export async function eraseSlotForColdAssignment({
  baseUrl,
  model,
  slotId,
  fetchImpl = fetch,
  signal,
} = {}) {
  if (!baseUrl || !model || !Number.isInteger(slotId) || slotId < 0) {
    throw new TypeError('baseUrl, model, and a non-negative integer slotId are required');
  }
  const response = await fetchImpl(
    `${String(baseUrl).replace(/\/+$/, '')}/slots/${slotId}?action=erase`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal,
    },
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 160);
    throw new SlotOwnershipError(`cannot establish clean cache slot ownership (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  return true;
}

/**
 * Fetch one concrete model child's slots, waiting once when the router reports
 * that the child is still loading. A model-specific `/slots` request triggers
 * lazy child loading; durable restore must not race that startup and silently
 * fall back cold.
 *
 * @param {Object} input Slot probe inputs.
 * @param {string} input.baseUrl llama.cpp/router base URL.
 * @param {string} input.model Concrete model whose slots are requested.
 * @param {typeof fetch} [input.fetchImpl] Injectable fetch implementation.
 * @param {(model:string)=>Promise<boolean>} input.waitForReady Model-ready waiter.
 * @param {AbortSignal} [input.signal] Optional cancellation signal.
 * @returns {Promise<Array<Record<string,unknown>>|null>} Slot rows, or null when unavailable.
 */
export async function fetchModelSlotsWhenReady({
  baseUrl,
  model,
  fetchImpl = fetch,
  waitForReady,
  signal,
} = {}) {
  if (!baseUrl || !model || typeof waitForReady !== 'function') {
    throw new TypeError('baseUrl, model, and waitForReady are required');
  }
  const url = `${String(baseUrl).replace(/\/+$/, '')}/slots?model=${encodeURIComponent(model)}`;
  let response;
  try {
    response = await fetchImpl(url, { signal });
  } catch {
    return null;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (classifyUpstreamFailure({ status: response.status, text: detail }).kind !== 'proxy') return null;
    if (!(await waitForReady(model))) return null;
    try {
      response = await fetchImpl(url, { signal });
    } catch {
      return null;
    }
  }
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  return Array.isArray(payload) ? payload : null;
}

/**
 * Restore a durable dump while tolerating the short interval where the router
 * reports a lazy child as loaded but its proxy socket still rejects requests.
 * Only classified child-loading failures retry; unsupported or invalid actions
 * fail cold without hiding their nature behind repeated requests.
 *
 * @param {Object} input Restore inputs.
 * @param {string} input.baseUrl llama.cpp/router base URL.
 * @param {string} input.model Concrete model whose slot is restored.
 * @param {number} input.slotId Server-owned slot identifier.
 * @param {string} input.filename Safe manager-owned slot dump filename.
 * @param {typeof fetch} [input.fetchImpl] Injectable fetch implementation.
 * @param {(model:string)=>Promise<boolean>} input.waitForReady Model-ready waiter.
 * @param {(milliseconds:number)=>Promise<void>} [input.sleep] Injectable delay.
 * @param {number} [input.retries=6] Maximum transient retries.
 * @param {AbortSignal} [input.signal] Optional cancellation signal.
 * @returns {Promise<Record<string,unknown>|null>} Upstream restore result, or null on failure.
 */
export async function restoreModelSlotWhenReady({
  baseUrl,
  model,
  slotId,
  filename,
  fetchImpl = fetch,
  waitForReady,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  retries = 6,
  signal,
} = {}) {
  if (!baseUrl || !model || !Number.isInteger(slotId) || slotId < 0 || !filename || typeof waitForReady !== 'function') {
    throw new TypeError('baseUrl, model, slotId, filename, and waitForReady are required');
  }
  const url = `${String(baseUrl).replace(/\/+$/, '')}/slots/${slotId}?action=restore`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, model }),
        signal,
      });
    } catch {
      return null;
    }
    if (response.ok) return await response.json().catch(() => ({}));
    const detail = await response.text().catch(() => '');
    if (classifyUpstreamFailure({ status: response.status, text: detail }).kind !== 'proxy') return null;
    const plan = upstreamRetryPlan({
      kind: 'proxy',
      attempt,
      retries,
      baseDelayMs: 500,
      maxDelayMs: 2000,
    });
    if (plan.action !== 'retry' || !(await waitForReady(model))) return null;
    await sleep(plan.delayMs);
  }
  return null;
}
