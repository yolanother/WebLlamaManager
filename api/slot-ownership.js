// Llama Manager — safe llama.cpp slot ownership transitions.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Clears server-owned llama.cpp slots before assigning them to a cold
// conversation lineage. This fail-closed boundary prevents stale KV state from
// a prior lineage or authorization scope from participating in prompt reuse.

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
