// Llama Manager — module-scoped SSE chat streaming store.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Owns the in-flight chat completion for the whole app: cancellation,
// incremental SSE parsing, 50 ms render batching, usage accounting,
// structured upstream-error surfacing, capture of the router-selected model
// response header, and accumulation of reasoning-model `reasoning_content`
// deltas so the UI can show a "Thinking…" state with a live excerpt of the
// model's thoughts. State lives at module scope (read through
// `useSyncExternalStore`) rather than in component state so a generation
// survives navigating away from the chat page and back.

import { useSyncExternalStore } from 'react';

import { API_BASE } from '../../api.js';

/** Milliseconds between repaints while tokens arrive. */
const PAINT_INTERVAL_MS = 50;

/** Maximum characters of live reasoning text shown as a progress hint. */
const REASONING_TAIL_CHARS = 160;

/**
 * Parse one OpenAI-compatible SSE data payload and surface structured upstream
 * errors as JavaScript errors that retain the server's type and code.
 *
 * @param {string} data JSON text from an SSE `data:` line.
 * @returns {object} Parsed ordinary OpenAI streaming event.
 * @throws {Error} When JSON is malformed or the event contains an error envelope.
 */
function parseChatSseEvent(data) {
  const parsed = JSON.parse(data);
  if (parsed?.error && typeof parsed.error === 'object') {
    const streamError = new Error(parsed.error.message || 'Chat stream failed.');
    streamError.type = parsed.error.type;
    streamError.code = parsed.error.code;
    streamError.status = parsed.error.status;
    streamError.isChatSseError = true;
    throw streamError;
  }
  return parsed;
}

/**
 * Read the reasoning text carried by one streamed delta. Reasoning models put
 * their chain-of-thought in `reasoning_content` (llama.cpp / DeepSeek style)
 * or `reasoning` (OpenAI style) while `content` stays empty, so both spellings
 * are accepted.
 *
 * @param {object} [delta] One `choices[0].delta` object from an SSE event.
 * @returns {string} The reasoning text, or an empty string when absent.
 */
function reasoningDelta(delta) {
  const value = delta?.reasoning_content ?? delta?.reasoning;
  return typeof value === 'string' ? value : '';
}

/**
 * Condense accumulated reasoning text into a single-line progress hint: the
 * tail of the thoughts with all whitespace collapsed, capped so the hint can
 * never grow the layout.
 *
 * @param {string} text Accumulated reasoning text (may be empty).
 * @param {number} [limit] Maximum characters to keep.
 * @returns {string} A single-line excerpt, or an empty string for no input.
 */
function reasoningTail(text, limit = REASONING_TAIL_CHARS) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(flat.length - limit) : flat;
}

/** Mutable stream state; published to subscribers via {@link emit}. */
const state = {
  conversationId: null,
  error: '',
  isStreaming: false,
  reasoning: '',
  routedModel: '',
  startedAt: 0,
  streamingMessage: '',
};

/** Immutable snapshot handed to `useChatStream` subscribers. */
let snapshot = { ...state };

/** Set of store subscribers. */
const listeners = new Set();

/** Buffered content and reasoning between repaints. */
let latestContent = '';
let latestReasoning = '';
let paintTimer = null;
let controller = null;

/** Rebuild the public snapshot and notify subscribers. */
function emit() {
  snapshot = { ...state };
  for (const listener of listeners) listener();
}

/**
 * Subscribe to stream-state changes.
 * @param {() => void} callback Invoked on every state change.
 * @returns {() => void} Unsubscribe function.
 */
function subscribe(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * @returns {object} The current immutable stream snapshot (stable reference
 *   between mutations). Exported for imperative reads outside React.
 */
function getStreamSnapshot() {
  return snapshot;
}

/** Publish the buffered content and reasoning immediately. */
function flushPaint() {
  if (paintTimer) {
    clearTimeout(paintTimer);
    paintTimer = null;
  }
  if (state.streamingMessage === latestContent && state.reasoning === latestReasoning) return;
  state.streamingMessage = latestContent;
  state.reasoning = latestReasoning;
  emit();
}

/** Schedule a batched repaint of buffered content and reasoning. */
function schedulePaint() {
  if (paintTimer) return;
  paintTimer = setTimeout(flushPaint, PAINT_INTERVAL_MS);
}

/** Abort the in-flight generation, if any. */
function stop() {
  controller?.abort();
}

/**
 * Stream one chat completion, publishing incremental content and reasoning to
 * every subscriber until it completes, fails, or is stopped.
 *
 * @param {object} options
 * @param {string} [options.model] Model or router alias to request.
 * @param {object[]} options.messages OpenAI-format request messages.
 * @param {string} [options.conversationId] Conversation the generation belongs
 *   to, so the UI can show the streaming bubble only in that conversation.
 * @returns {Promise<object>} The final content, routed model, stopped flag, and
 *   token/timing stats.
 * @throws {Error} When the request fails for any reason other than being stopped.
 */
async function streamChat({ model = 'auto', messages, conversationId = null }) {
  controller?.abort();
  const requestController = new AbortController();
  controller = requestController;
  latestContent = '';
  latestReasoning = '';
  state.conversationId = conversationId;
  state.error = '';
  state.isStreaming = true;
  state.reasoning = '';
  state.routedModel = '';
  state.startedAt = Date.now();
  state.streamingMessage = '';
  emit();

  const startedAt = performance.now();
  let usage = null;
  let modelUsed = model;
  let tokenChunks = 0;
  let stopped = false;
  let routerChoice = '';

  try {
    const response = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        metadata: { llama_manager_chat: true },
      }),
      signal: requestController.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || `HTTP ${response.status}`);
    }
    if (!response.body) throw new Error('Streaming response body is unavailable.');

    routerChoice = response.headers.get('x-llama-router-choice') || '';
    state.routedModel = routerChoice;
    emit();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = '';

    const consumeLine = (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trimStart();
      if (!data || data === '[DONE]') return;
      try {
        const parsed = parseChatSseEvent(data);
        const delta = parsed.choices?.[0]?.delta;
        const thought = reasoningDelta(delta);
        if (thought) {
          latestReasoning += thought;
          schedulePaint();
        }
        if (delta?.content) {
          latestContent += delta.content;
          tokenChunks += 1;
          schedulePaint();
        }
        if (parsed.usage) usage = parsed.usage;
        if (parsed.model) modelUsed = parsed.model;
      } catch (parseError) {
        if (parseError?.isChatSseError) throw parseError;
        // Ignore keepalives and malformed partial event data.
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';
      lines.forEach(consumeLine);
    }
    lineBuffer += decoder.decode();
    if (lineBuffer) consumeLine(lineBuffer);
  } catch (streamError) {
    if (streamError.name === 'AbortError') {
      stopped = true;
    } else {
      state.error = streamError.message || 'Chat request failed.';
      throw streamError;
    }
  } finally {
    flushPaint();
    state.isStreaming = false;
    state.conversationId = null;
    state.startedAt = 0;
    emit();
    if (controller === requestController) controller = null;
  }

  const duration = Math.max(performance.now() - startedAt, 1);
  const completionTokens = usage?.completion_tokens || tokenChunks;
  return {
    content: latestContent,
    routedModel: routerChoice || (model === 'auto' ? '' : model),
    stopped,
    stats: {
      model: modelUsed,
      promptTokens: usage?.prompt_tokens || 0,
      completionTokens,
      totalTokens: usage?.total_tokens
        || (usage?.prompt_tokens || 0) + completionTokens,
      tokensPerSecond: Math.round((completionTokens / (duration / 1000)) * 10) / 10,
      duration: Math.round(duration),
    },
  };
}

/**
 * Subscribe a component to the shared chat stream.
 *
 * @returns {{conversationId: string|null, error: string, isStreaming: boolean,
 *   reasoning: string, routedModel: string, startedAt: number,
 *   streamingMessage: string, stop: () => void, streamChat: typeof streamChat}}
 *   The live stream state plus its stable control functions.
 */
function useChatStream() {
  const stream = useSyncExternalStore(subscribe, getStreamSnapshot, getStreamSnapshot);
  return { ...stream, stop, streamChat };
}

export {
  getStreamSnapshot,
  parseChatSseEvent,
  reasoningDelta,
  reasoningTail,
  streamChat,
  useChatStream,
};
