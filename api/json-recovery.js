// Llama Manager — recover a model's JSON answer from a reply that wrapped it in prose.
// Copyright (c) Llama Manager project. The LICENSE file in the repository root governs use
// of this file.
//
// A model asked for strict JSON frequently answers with commentary, a fenced block, or both,
// and the JSON inside is complete and correct. This module extracts that object so a caller
// does not have to re-run the request. It is deliberately conservative: it returns the
// parsed object or null, and never repairs, completes, or guesses at malformed JSON.

/**
 * The JSON object a model intended to return, recovered from a possibly wrapped reply.
 *
 * Strategy: parse strictly first; failing that, take the LAST balanced `{...}` in the text
 * and parse that. Fence syntax is ignored entirely — ```json, a bare ```, and no fence at
 * all are handled identically, because a real reply used each of the three and a
 * fence-label matcher mis-scored the bare one.
 *
 * The last balanced object is the right target rather than the first: replies commonly
 * mention brace-looking fragments in prose ("it returns {a: 1} in the happy path") before
 * emitting the real answer.
 *
 * The recovered object must be the FINAL content of the reply — only whitespace and fence
 * characters may follow it. Without that rule a truncated document yields an inner fragment:
 * a 119,704-char worker reply cut mid-string still contained one complete concern object,
 * and returning it would hand the caller a single finding dressed as the whole answer.
 * Truncated JSON returns null rather than a repaired object; closing the braces would
 * fabricate data.
 *
 * Measured motivation: on a `--parallel 1` engine a retry queues behind whatever is running
 * — up to 76 minutes in one measurement — so recovering a correct answer that is already
 * present is a latency fix as much as a correctness one.
 *
 * @param {unknown} text Raw assistant reply.
 * @returns {Record<string, unknown>|null} The recovered object, or null when there is none.
 */
export function recoverJsonObject(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const asObject = (value) => (
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  );

  try {
    return asObject(JSON.parse(trimmed));
  } catch {
    // Fall through to extraction.
  }

  let end = trimmed.lastIndexOf('}');
  while (end !== -1) {
    let depth = 0;
    for (let i = end; i >= 0; i -= 1) {
      const ch = trimmed[i];
      if (ch === '}') depth += 1;
      else if (ch === '{') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = asObject(JSON.parse(trimmed.slice(i, end + 1)));
            // Only accept it if nothing but a fence or whitespace follows: an object that
            // sits mid-document is a fragment of a truncated reply, not the answer.
            if (parsed && /^[\s`]*$/.test(trimmed.slice(end + 1))) return parsed;
          } catch {
            // This candidate is not valid JSON; try the next `}` to its left.
          }
          break;
        }
      }
    }
    end = trimmed.lastIndexOf('}', end - 1);
  }
  return null;
}
