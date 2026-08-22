// Llama Manager — corrupted completion output detection and SSE filtering.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Detects the characteristic question-mark-only output produced by a broken
// inference backend. It validates complete OpenAI chat payloads and incrementally
// withholds suspect SSE output until the stream is proven valid or replaced by a
// structured upstream-output error.

const ERROR_MESSAGE = 'The inference backend returned corrupted question-mark-only output.';

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
    output += contentText(message?.reasoning_content);
    output += contentText(message?.reasoning);
    output += contentText(message?.thinking);
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
  return isQuestionMarkOnlyText(chatCompletionText(payload))
    ? QUESTION_MARK_ONLY_OUTPUT_ERROR
    : null;
}

/** Extract all generated text carried by one OpenAI streaming data payload. */
function streamPayloadText(payload) {
  if (!Array.isArray(payload?.choices)) return '';
  let output = '';
  for (const choice of payload.choices) {
    const delta = choice?.delta;
    output += contentText(delta?.content);
    output += contentText(delta?.reasoning_content);
    output += contentText(delta?.reasoning);
    output += contentText(delta?.thinking);
    output += contentText(delta?.text);
    output += contentText(choice?.text);
  }
  return output;
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
function corruptedStreamEnd() {
  return [
    `data: ${JSON.stringify(QUESTION_MARK_ONLY_OUTPUT_ERROR.body)}\n\n`,
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
 * @returns {{push:(chunk:string)=>string[],finish:()=>string[]}} Incremental guard.
 * @throws {TypeError} When push receives a non-string chunk.
 */
export function createChatCompletionStreamGuard() {
  let lineBuffer = '';
  let suspectBuffer = '';
  let suspect = false;
  let safe = false;
  let finished = false;

  const processLine = (line) => {
    const text = streamLineText(line);

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
      if (suspect) return corruptedStreamEnd();
      if (suspectBuffer) output.push(suspectBuffer);
      return output;
    },
  };
}
