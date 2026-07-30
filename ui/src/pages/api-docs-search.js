// Llama Manager API documentation endpoint search utilities.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Provides the pure filtering behavior used by the API documentation endpoint
// navigator without changing the Manager and OpenAI inventory classification.

/**
 * Filters an endpoint inventory by the fields a reader sees in the navigator.
 * A blank query returns the original array so callers avoid unnecessary list work.
 *
 * @param {Array<{method?: string, path?: string, summary?: string, description?: string}>} endpoints
 *   The already-classified endpoint inventory to search.
 * @param {string} query The case-insensitive search query.
 * @returns {typeof endpoints} Matching endpoints in their original order.
 */
export function filterApiEndpoints(endpoints, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return endpoints;

  return endpoints.filter(endpoint => (
    [endpoint.method, endpoint.path, endpoint.summary, endpoint.description]
      .some(value => String(value ?? '').toLowerCase().includes(normalizedQuery))
  ));
}
