// Llama Manager — corrupted completion output detection and SSE filtering.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Detects output produced by a broken inference backend and replaces it with a
// structured upstream-output error, both for complete OpenAI chat payloads and
// incrementally for raw SSE streams.
//
// Two failure shapes are covered. The original is question-mark-only output, whose
// suspect fragments are withheld until real text proves the stream valid. The second
// is a child whose forward pass has gone corrupt and emits ONE character forever: on
// Drakemore a Qwen3.6-35B-A3B child served HTTP 200 while producing 12288 '/' tokens
// over 304s, twice. That shape needs different handling — each SSE delta carries a
// single character, which looks perfectly valid on its own, so it is only visible by
// accumulating a run across lines, and it lived entirely in reasoning_content while
// visible content stayed empty.

import { createRepetitionMonitor, degenerateOutputReason } from './degenerate-output.js';

const ERROR_MESSAGE = 'Inference backend returned invalid question-mark-only output';
const DEGENERATE_MESSAGE = 'Inference backend returned degenerate repeated-character output';

/**
 * Frozen HTTP/error descriptor used when generated text contains only question
 * marks and whitespace.
 */
export const QUESTION_MARK_ONLY_OUTPUT_ERROR = Object.freeze({
  status: 502,
  body: Object.freeze({
    error: Object.freeze({
      message: ERROR_MESSAGE,
      type: 'upstream_output_error',
      code: 'QUESTION_MARK_ONLY_OUTPUT',
    }),
  }),
});

/**
 * Return whether a non-empty string contains at least one question mark and no
 * characters other than question marks or whitespace.
 *
 * @param {unknown} text Candidate generated text.
 * @returns {boolean} True only for question-mark-only generated output.
 */
export function isQuestionMarkOnlyText(text) {
  return typeof text === 'string' && text.includes('?') && /^[?\s]+$/u.test(text);
}

/**
 * Frozen HTTP/error descriptor used when a completion degenerates into one character
 * repeated to the token limit. Distinct from the question-mark descriptor so operators
 * can tell a corrupt child apart from the older backend fault in logs.
 */
export const DEGENERATE_OUTPUT_ERROR = Object.freeze({
  status: 502,
  body: Object.freeze({
    error: Object.freeze({
      message: DEGENERATE_MESSAGE,
      type: 'upstream_output_error',
      code: 'DEGENERATE_OUTPUT',
    }),
  }),
});

/** Return text carried by a string or OpenAI content-part array. */
function contentText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter((part) => part && typeof part === 'object' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/** Collect generated text from all OpenAI chat-completion choices. */
function chatCompletionText(payload) {
  if (!Array.isArray(payload?.choices)) return '';
  let output = '';
  for (const choice of payload.choices) {
    const message = choice?.message;
    output += contentText(message?.content);
    output += contentText(message?.text);
    output += contentText(choice?.text);
  }
  return output;
}

/**
 * Validate a complete OpenAI chat-completion payload.
 *
 * Empty output and tool-call-only messages are valid. Normal or mixed text is
 * returned unchanged by callers because this function only reports corruption.
 *
 * @param {unknown} payload OpenAI-compatible chat-completion response.
 * @returns {typeof QUESTION_MARK_ONLY_OUTPUT_ERROR|null} Corruption descriptor,
 *   or null when the payload is safe to return.
 */
export function validateChatCompletionPayload(payload) {
  const visible = chatCompletionText(payload);
  if (isQuestionMarkOnlyText(visible)) return QUESTION_MARK_ONLY_OUTPUT_ERROR;
  // Visible content is judged first and alone, so valid reasoning never excuses
  // corrupt visible output. Reasoning is only consulted when nothing was visible,
  // which is exactly how the corrupt child presented: empty content, 12288 slashes.
  if (degenerateOutputReason(visible || chatCompletionReasoning(payload))) {
    return DEGENERATE_OUTPUT_ERROR;
  }
  return null;
}

/** Collect hidden reasoning text from all choices of a complete chat completion. */
function chatCompletionReasoning(payload) {
  if (!Array.isArray(payload?.choices)) return '';
  let output = '';
  for (const choice of payload.choices) {
    const message = choice?.message;
    output += contentText(message?.reasoning_content);
    output += contentText(message?.reasoning);
    output += contentText(message?.thinking);
  }
  return output;
}

/** Extract all generated text carried by one OpenAI streaming data payload. */
function streamPayloadText(payload) {
  if (!Array.isArray(payload?.choices)) return '';
  let output = '';
  for (const choice of payload.choices) {
    const delta = choice?.delta;
    output += contentText(delta?.content);
    output += contentText(delta?.text);
    output += contentText(choice?.text);
  }
  return output;
}

/** Extract hidden reasoning text carried by one OpenAI streaming data payload. */
function streamPayloadReasoning(payload) {
  if (!Array.isArray(payload?.choices)) return '';
  let output = '';
  for (const choice of payload.choices) {
    const delta = choice?.delta;
    output += contentText(delta?.reasoning_content);
    output += contentText(delta?.reasoning);
    output += contentText(delta?.thinking);
  }
  return output;
}

/** Parse every generated character of one SSE line, reasoning included. */
function streamLineAllText(line) {
  if (!line.startsWith('data:')) return '';
  const raw = line.slice(5).trimStart().replace(/\r?\n$/u, '');
  if (!raw || raw === '[DONE]') return '';
  try {
    const payload = JSON.parse(raw);
    return streamPayloadText(payload) + streamPayloadReasoning(payload);
  } catch {
    return '';
  }
}

/** Parse generated text from one complete SSE line, or null for non-output lines. */
function streamLineText(line) {
  if (!line.startsWith('data:')) return null;
  const raw = line.slice(5).trimStart().replace(/\r?\n$/u, '');
  if (!raw || raw === '[DONE]') return null;
  try {
    return streamPayloadText(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Return the first complete line, including its original line ending. */
function shiftLine(input) {
  const newline = input.indexOf('\n');
  if (newline < 0) return null;
  return [input.slice(0, newline + 1), input.slice(newline + 1)];
}

/** Build the terminal OpenAI-compatible streaming error and completion marker. */
function corruptedStreamEnd(descriptor = QUESTION_MARK_ONLY_OUTPUT_ERROR) {
  return [
    `data: ${JSON.stringify(descriptor.body)}\n\n`,
    'data: [DONE]\n\n',
  ];
}

/**
 * Create an incremental OpenAI chat-completion SSE guard.
 *
 * Complete SSE lines are preserved byte-for-byte as decoded strings. Candidate
 * question-mark output and every following fragment are withheld until real text
 * proves the complete output valid. If the stream finishes while still suspect,
 * the buffered fragments are discarded and a single structured error followed by
 * `[DONE]` is returned.
 *
 * Independently of that, a run of one repeated character accumulating across lines
 * (content or reasoning) terminates the stream as soon as it passes the threshold,
 * rather than at the token limit — the corrupt child this guards against took over
 * 300 seconds to reach its limit, so detecting it only at the end helps nobody.
 *
 * @returns {{push:(chunk:string)=>string[],finish:()=>string[],readonly corrupted:boolean}}
 *   Incremental guard and its terminal corruption classification.
 * @throws {TypeError} When push receives a non-string chunk.
 */
export function createChatCompletionStreamGuard() {
  let lineBuffer = '';
  let suspectBuffer = '';
  let suspect = false;
  let safe = false;
  let finished = false;
  let corrupted = false;
  let corruptionError = null;
  const repetition = createRepetitionMonitor();

  const processLine = (line) => {
    const text = streamLineText(line);

    // Checked before everything else, and deliberately outside the `safe` latch: a
    // stream can start with a real answer and degenerate afterwards, and the run
    // that gives it away is only visible once accumulated across lines.
    if (repetition.push(streamLineAllText(line))) {
      finished = true;
      corrupted = true;
      corruptionError = DEGENERATE_OUTPUT_ERROR;
      suspectBuffer = '';
      suspect = false;
      return corruptedStreamEnd(DEGENERATE_OUTPUT_ERROR);
    }

    if (safe) return [line];
    if (text && !isQuestionMarkOnlyText(text) && text.trim().length > 0) {
      safe = true;
      const released = suspectBuffer + line;
      suspectBuffer = '';
      suspect = false;
      return [released];
    }
    if (isQuestionMarkOnlyText(text)) suspect = true;
    if (suspect) {
      suspectBuffer += line;
      return [];
    }
    return [line];
  };

  return {
    /**
     * Consume one decoded transport chunk and return complete safe SSE fragments.
     * @param {string} chunk Decoded upstream bytes.
     * @returns {string[]} Raw fragments safe to forward.
     */
    push(chunk) {
      if (finished) return [];
      if (typeof chunk !== 'string') throw new TypeError('SSE guard chunks must be strings');
      lineBuffer += chunk;
      const output = [];
      while (true) {
        const shifted = shiftLine(lineBuffer);
        if (!shifted) break;
        const [line, rest] = shifted;
        lineBuffer = rest;
        output.push(...processLine(line));
        // A degenerate run terminates the stream mid-chunk; anything still buffered
        // is corrupt output the caller must not receive.
        if (finished) { lineBuffer = ''; break; }
      }
      return output;
    },

    /**
     * Finish the stream, classifying any final unterminated SSE line.
     * @returns {string[]} Final safe fragments or the corruption error and `[DONE]`.
     */
    finish() {
      if (finished) return [];
      finished = true;
      const output = [];
      if (lineBuffer) {
        output.push(...processLine(lineBuffer));
        lineBuffer = '';
      }
      if (suspect) {
        corrupted = true;
        corruptionError = QUESTION_MARK_ONLY_OUTPUT_ERROR;
        return corruptedStreamEnd();
      }
      if (suspectBuffer) output.push(suspectBuffer);
      return output;
    },

    /** True once corrupt output has been replaced with a structured error. */
    get corrupted() {
      return corrupted;
    },

    /**
     * Which corruption was detected, so callers log the failure that actually
     * happened rather than assuming the older question-mark one.
     * @returns {typeof QUESTION_MARK_ONLY_OUTPUT_ERROR|typeof DEGENERATE_OUTPUT_ERROR|null}
     */
    get corruptionError() {
      return corruptionError;
    },
  };
}
