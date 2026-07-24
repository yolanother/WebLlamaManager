// Llama Manager — batched SSE chat streaming hook.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Owns cancellation, incremental SSE parsing, 50 ms render batching, usage
// accounting, and capture of the router-selected model response header.

import { useCallback, useEffect, useRef, useState } from 'react';

import { API_BASE } from '../../api.js';

/**
 * Stream one chat completion while exposing render-friendly incremental state.
 */
function useChatStream() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState('');
  const [routedModel, setRoutedModel] = useState('');
  const [error, setError] = useState('');
  const controllerRef = useRef(null);
  const paintTimerRef = useRef(null);
  const latestContentRef = useRef('');

  const flushPaint = useCallback(() => {
    if (paintTimerRef.current) {
      clearTimeout(paintTimerRef.current);
      paintTimerRef.current = null;
    }
    setStreamingMessage(latestContentRef.current);
  }, []);

  const schedulePaint = useCallback(() => {
    if (paintTimerRef.current) return;
    paintTimerRef.current = setTimeout(flushPaint, 50);
  }, [flushPaint]);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    latestContentRef.current = '';
    setStreamingMessage('');
    setRoutedModel('');
    setError('');
  }, []);

  const streamChat = useCallback(async ({ model = 'auto', messages }) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    latestContentRef.current = '';
    setStreamingMessage('');
    setRoutedModel('');
    setError('');
    setIsStreaming(true);

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
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `HTTP ${response.status}`);
      }
      if (!response.body) throw new Error('Streaming response body is unavailable.');

      routerChoice = response.headers.get('x-llama-router-choice') || '';
      setRoutedModel(routerChoice);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let lineBuffer = '';

      const consumeLine = (line) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trimStart();
        if (!data || data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            latestContentRef.current += delta;
            tokenChunks += 1;
            schedulePaint();
          }
          if (parsed.usage) usage = parsed.usage;
          if (parsed.model) modelUsed = parsed.model;
        } catch {
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
        const message = streamError.message || 'Chat request failed.';
        setError(message);
        throw streamError;
      }
    } finally {
      flushPaint();
      setIsStreaming(false);
      if (controllerRef.current === controller) controllerRef.current = null;
    }

    const duration = Math.max(performance.now() - startedAt, 1);
    const completionTokens = usage?.completion_tokens || tokenChunks;
    return {
      content: latestContentRef.current,
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
  }, [flushPaint, schedulePaint]);

  useEffect(() => () => {
    controllerRef.current?.abort();
    if (paintTimerRef.current) clearTimeout(paintTimerRef.current);
  }, []);

  return {
    error,
    isStreaming,
    reset,
    routedModel,
    stop,
    streamChat,
    streamingMessage,
  };
}

export { useChatStream };
