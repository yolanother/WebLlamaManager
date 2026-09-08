// Llama Manager — corrupt-output detection for the OpenAI Responses transport.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// The chat transport has been guarded since a llama.cpp child entered a persistent
// corrupt state and served HTTP 200 garbage for every request. /v1/responses had no
// guard at all — and that is the production podcast transport, used with
// background:true, so the production path was the unguarded one.
//
// This is not a copy of the chat guard. Three things differ:
//
//  - Event shape. Responses carries generated text as response.output_text.delta and
//    response.reasoning_text.delta rather than choices[].delta, so the chat guard's
//    extractor sees nothing at all here.
//
//  - Failure shape. executeBackgroundResponse only records a final response from
//    events typed response.completed/failed/cancelled/incomplete that carry
//    event.response. A chat-style bare `data: {error:{...}}` would leave a background
//    job holding null with status 200 — a silently empty result instead of a failure.
//    So corruption is reported as a real response.failed event.
//
//  - No withhold-and-release buffering. That machinery exists in the chat guard for
//    the question-mark case, where a suspect opening must be held until real text
//    proves it fine. Here the detector needs a long run before it fires, so bytes are
//    forwarded unchanged as they arrive and only a trip stops the stream.
//
// Detection itself is shared: createRepetitionMonitor and degenerateOutputReason, so
// there is exactly one definition of what "corrupt" means across both transports.

import { createRepetitionMonitor, degenerateOutputReason } from './degenerate-output.js';
import { DEGENERATE_OUTPUT_ERROR } from './completion-output-guard.js';

/**
 * Event types whose `delta` is model-generated prose worth judging.
 *
 * response.function_call_arguments.delta is deliberately absent: tool arguments are
 * structured JSON where repetition is plausible, and falsely aborting a valid tool
 * call is worse than the failure this guards against.
 */
const TEXT_DELTA_TYPES = new Set([
  'response.output_text.delta',
  'response.reasoning_text.delta',
]);

/**
 * Generated text carried by one Responses stream event.
 *
 * @param {unknown} event Parsed SSE event object.
 * @returns {string} The generated text, or '' for events that carry none.
 */
export function responsesEventText(event) {
  if (!event || typeof event !== 'object') return '';
  if (!TEXT_DELTA_TYPES.has(event.type)) return '';
  return typeof event.delta === 'string' ? event.delta : '';
}

/** Collect the text of one completed Responses output item. */
function outputItemText(item) {
  if (!item || !Array.isArray(item.content)) return '';
  return item.content
    .map(part => (part && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/**
 * Judge a complete (non-streaming) Responses payload.
 *
 * Visible message output is judged first and alone, so valid reasoning never excuses
 * corrupt visible output. Reasoning is consulted only when there was no visible text
 * at all — which is exactly how the observed failures presented: empty output, and a
 * reasoning block that had degenerated.
 *
 * @param {unknown} payload A Responses object with an `output` array.
 * @returns {typeof DEGENERATE_OUTPUT_ERROR|null} Corruption descriptor, or null.
 */
export function validateResponsesPayload(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.output)) return null;
  let visible = '';
  let reasoning = '';
  for (const item of payload.output) {
    if (item?.type === 'reasoning') reasoning += outputItemText(item);
    else visible += outputItemText(item);
  }
  const text = visible || reasoning;
  // Two checks, because they catch different shapes and both have been seen in the
  // field. degenerateOutputReason judges a whole completion that is one punctuation
  // character. The monitor, fed the finished text in one go, additionally catches the
  // long character runs and the repeated-line loops that a batch payload can contain.
  if (degenerateOutputReason(text)) return DEGENERATE_OUTPUT_ERROR;
  return createRepetitionMonitor().push(text) ? DEGENERATE_OUTPUT_ERROR : null;
}

/** Render the terminal failure events a corrupt stream ends with. */
function failedStreamEnd(responseId) {
  const { message, type, code } = DEGENERATE_OUTPUT_ERROR.body.error;
  const failure = {
    type: 'response.failed',
    response: {
      // The id the stream already announced, so a caller correlating events does not
      // suddenly see a different response.
      ...(responseId ? { id: responseId } : {}),
      object: 'response',
      status: 'failed',
      error: { code, message, type },
    },
  };
  return [`data: ${JSON.stringify(failure)}\n\n`, 'data: [DONE]\n\n'];
}

/**
 * Create an incremental guard for a Responses SSE stream.
 *
 * Bytes are forwarded unchanged while the generated text is monitored. When a run of
 * repeated characters or repeated lines passes the shared threshold the stream is
 * terminated with a response.failed event and `[DONE]`, and nothing further is
 * forwarded, so corrupt output cannot leak to the caller after the verdict.
 *
 * @returns {{push:(chunk:string)=>string[], finish:()=>string[], readonly corrupted:boolean,
 *            readonly corruptionError:typeof DEGENERATE_OUTPUT_ERROR|null}} The guard.
 */
export function createResponsesStreamGuard() {
  const monitor = createRepetitionMonitor();
  let buffer = '';
  let responseId = null;
  let corrupted = false;
  let finished = false;

  /** Feed one complete SSE block, returning a trip reason or null. */
  const consumeBlock = (block) => {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let event;
      try { event = JSON.parse(payload); } catch { continue; }
      if (!responseId && event?.response?.id) responseId = event.response.id;
      const tripped = monitor.push(responsesEventText(event));
      if (tripped) return tripped;
    }
    return null;
  };

  return {
    push(chunk) {
      if (finished || typeof chunk !== 'string' || chunk === '') return [];
      buffer += chunk;
      const out = [];
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary + 2);
        buffer = buffer.slice(boundary + 2);
        if (consumeBlock(block)) {
          corrupted = true;
          finished = true;
          buffer = '';
          return [...out, ...failedStreamEnd(responseId)];
        }
        out.push(block);
      }
      return out;
    },

    finish() {
      if (finished) return [];
      finished = true;
      const tail = buffer;
      buffer = '';
      if (tail && consumeBlock(tail)) {
        corrupted = true;
        return failedStreamEnd(responseId);
      }
      return tail ? [tail] : [];
    },

    get corrupted() { return corrupted; },
    get corruptionError() { return corrupted ? DEGENERATE_OUTPUT_ERROR : null; },
  };
}
