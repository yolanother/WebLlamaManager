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
// Two detectors share this signature. degenerateOutputReason judges a FINISHED
// completion; createRepetitionMonitor watches a STREAM and reports as soon as the
// run appears, because a corrupt child served 12288 repeated tokens over 304s at
// status 200 and judging it afterwards is far too late to help the caller.
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

/**
 * Consecutive identical characters that mark a stream as corrupt.
 *
 * A corrupt child on Drakemore emitted 12288 '/' tokens over 304s at status 200, so
 * waiting for the completion to finish is not a usable defence. This is deliberately
 * far above any legitimate run — the longest real ones are indentation and markdown
 * rules, both well under 100 — because a false abort discards a real answer and is
 * worse than the bug being guarded against.
 */
export const STREAM_REPEAT_LIMIT = 256;

/**
 * Consecutive repeats of one line that mark a stream as looping.
 *
 * A Qwen3.6 reviewer request degenerated into '- **Input Format:**' repeated 1677
 * times across 265s at HTTP 200, returning nothing usable. The character-run check
 * above could not see it: the longest single-character run in that output was zero.
 *
 * Set far above any plausible real output for the same reason as the character
 * limit: a false abort discards a real answer, which is worse than the bug.
 */
export const STREAM_LINE_REPEAT_LIMIT = 30;

/** Shortest line worth judging; below this a repeat is plausibly real structure. */
const MIN_LINE_LENGTH = 3;

/**
 * Whether a line is substantial enough that repeating it many times means a loop.
 *
 * Punctuation-only lines are excluded because real code stacks them — closing braces,
 * brackets and commas legitimately repeat down a listing. Requiring a letter or digit
 * keeps the check on prose-like lines, which is where the observed loops occur.
 *
 * @param {string} line Trimmed line.
 * @returns {boolean} True when a long run of this line indicates degeneration.
 */
function loopWorthyLine(line) {
  return line.length >= MIN_LINE_LENGTH && /[\p{L}\p{N}]/u.test(line);
}

/**
 * Create a stateful monitor that watches a streamed completion for the corrupt-child
 * signature and reports as soon as it appears, rather than after the token limit.
 *
 * Unlike {@link degenerateOutputReason}, which judges a finished completion and
 * deliberately ignores letters and digits to protect real content, this counts a run
 * of ANY character: at this threshold no legitimate output qualifies, and the same
 * failure has been seen looping on a letter.
 *
 * Two shapes are watched. A run of one repeated CHARACTER, and one repeated LINE — the
 * latter because a real 265s failure looped a whole phrase, which the character check
 * cannot see. Blank lines do not reset the line run: the observed payload alternated
 * the phrase with blank lines, so counting those as breaks would have missed it.
 *
 * Both runs are tracked across chunk boundaries, since a stream delivers a few tokens
 * at a time and no single chunk is long enough to trip on its own. Once tripped the
 * monitor stays tripped, so a caller that misses one return value still aborts.
 *
 * @param {{limit?: number}} [options] Trip threshold; defaults to {@link STREAM_REPEAT_LIMIT}.
 * @returns {{push: (chunk: unknown) => string|null}} Monitor whose `push` returns a
 *   human-readable reason once the stream looks corrupt, otherwise null.
 */
export function createRepetitionMonitor({
  limit = STREAM_REPEAT_LIMIT,
  lineLimit = STREAM_LINE_REPEAT_LIMIT,
} = {}) {
  let lastChar = null;
  let run = 0;
  let pendingLine = '';
  let lastLine = null;
  let lineRun = 0;
  let tripped = null;

  /** Judge one completed line, returning a trip reason or null. */
  const endLine = () => {
    const line = pendingLine.trim();
    pendingLine = '';
    // Blank lines are skipped rather than treated as a break in the run.
    if (line === '') return null;
    if (line === lastLine) lineRun += 1;
    else { lastLine = line; lineRun = 1; }
    if (lineRun >= lineLimit && loopWorthyLine(line)) {
      return `stream repeated the line ${JSON.stringify(line.slice(0, 80))} ${lineRun} times`;
    }
    return null;
  };

  return {
    push(chunk) {
      if (tripped) return tripped;
      if (typeof chunk !== 'string' || chunk.length === 0) return null;
      for (const ch of chunk) {
        if (ch === lastChar) run += 1;
        else { lastChar = ch; run = 1; }
        if (run >= limit) {
          tripped = `stream emitted ${run} consecutive ${JSON.stringify(ch)} characters`;
          return tripped;
        }
        if (ch === '\n') {
          const looping = endLine();
          if (looping) { tripped = looping; return tripped; }
        } else {
          pendingLine += ch;
        }
      }
      return null;
    },
  };
}
