// Llama Manager — degenerate completion-output detection.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Detects the signature of a broken inference backend: a completion consisting of one
// punctuation character repeated to the exclusion of everything else, produced at full
// generation speed. Nothing downstream can tell that apart from a real answer, so without
// this it propagates — the chat router acted on '/////' as though it were a model name,
// and a duo chain step would pass it to the next model as a plan.
//
// It has happened twice with DIFFERENT characters: question marks from Qwen3-8B (which
// caused an engine bump to be rolled back) and forward slashes from Qwen3.6-35B-A3B. An
// earlier guard keyed specifically on '?' and so would not have caught the slashes, which
// is why this keys on the shape instead.
//
// The bar for flagging is deliberately high, because a false positive rejects a real
// answer and is worse than the bug. The whole trimmed output must be ONE punctuation
// character (whitespace aside): that catches both observed failures while leaving markdown
// rules, separator comments and slash-heavy code untouched, since those are never the
// entire response.
//
// Pure and side-effect-free; unit-tested in degenerate-output.test.js.

/**
 * Shortest output worth judging. Below this a repeated character is plausibly a real
 * answer ('?', '//', '...'), and the cost of being wrong outweighs the catch.
 */
const MIN_LENGTH = 8;

/**
 * Why an output looks degenerate, or null when it looks fine.
 *
 * @param {unknown} text Completion text to judge.
 * @returns {string|null} Human-readable reason naming the offending character, or null.
 */
export function degenerateOutputReason(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length < MIN_LENGTH) return null;

  // Collapse whitespace out: the real payloads arrived with newlines around them.
  const body = trimmed.replace(/\s+/g, '');
  if (body.length < MIN_LENGTH) return null;

  const first = body[0];
  // Letters and digits are excluded deliberately. A long run of a letter is a different
  // failure (looping text) and flagging it would risk rejecting real content.
  if (/[\p{L}\p{N}]/u.test(first)) return null;

  for (const ch of body) {
    if (ch !== first) return null;
  }
  return `output was ${body.length} repetitions of ${JSON.stringify(first)} and nothing else`;
}

/**
 * Whether a completion is degenerate. Thin predicate over {@link degenerateOutputReason}
 * for call sites that only need the boolean.
 *
 * @param {unknown} text Completion text to judge.
 * @returns {string|null} The reason (truthy) when degenerate, otherwise null.
 */
export function isDegenerateOutput(text) {
  return degenerateOutputReason(text);
}
