// Llama Manager — floating glass quick query panel.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Provides the themeable floating glass model picker and streaming prompt panel
// displayed alongside routed pages.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { API_BASE, copyTextToClipboard, formatModelName } from '../api.js';
import { useLayout } from '../theme/uiPrefs.js';
import { parseMessageWithCodeBlocks } from './CodeBlock.jsx';
import { SearchableSelect } from './SearchableSelect.jsx';

// Query Panel Component
function QueryPanel({ stats }) {
  const location = useLocation();
  const layout = useLayout();
  const [isOpen, setIsOpen] = useState(false);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState(() => {
    return localStorage.getItem('lastSelectedModel') || '';
  });
  const [prompt, setPrompt] = useState('');
  const [conversationId, setConversationId] = useState(null); // Track current conversation
  const [messages, setMessages] = useState([]); // Each message: { role, content, stats? }
  const [isLoading, setIsLoading] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState('');
  const [hoveredMessage, setHoveredMessage] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  // queueStatus tracks the request's position while waiting on the server's
  // local queue. The server emits `: queued position=N/T waited=Xs` as SSE
  // comments while blocked on acquireLocalSlot. Cleared once tokens arrive.
  // { position: number, total: number, waitedSec: number } | null
  const [queueStatus, setQueueStatus] = useState(null);
  // waitingForFirstToken: true between submit and first content chunk. Shows
  // a "Thinking..." indicator so the user knows the request is in flight even
  // before bytes start arriving.
  const [waitingForFirstToken, setWaitingForFirstToken] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  const copyToClipboard = async (text, messageId) => {
    try {
      await copyTextToClipboard(text);
      setCopiedId(messageId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // Save conversation to shared localStorage (same as ChatPage)
  const saveToSharedHistory = (convId, title, model, msgs) => {
    try {
      const saved = localStorage.getItem('chat_conversations');
      const conversations = saved ? JSON.parse(saved) : [];
      const existingIndex = conversations.findIndex(c => c.id === convId);
      const conversation = {
        id: convId,
        title: title,
        model: model,
        messages: msgs.map(m => ({
          id: m.id?.toString() || Date.now().toString(),
          role: m.role,
          content: m.content,
          timestamp: m.stats?.timestamp || new Date().toISOString(),
          stats: m.stats || null
        })),
        createdAt: existingIndex >= 0 ? conversations[existingIndex].createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (existingIndex >= 0) {
        conversations[existingIndex] = conversation;
      } else {
        conversations.unshift(conversation);
      }
      localStorage.setItem('chat_conversations', JSON.stringify(conversations));
    } catch (err) {
      console.error('Failed to save conversation:', err);
    }
  };

  // Fetch available models from our API (all local models)
  const fetchModels = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/v1/models`);
      if (response.ok) {
        const data = await response.json();
        const modelList = data.data || data || [];
        setModels(modelList);

        // Auto-select first model if none selected
        if (!selectedModel && modelList.length > 0) {
          const firstModel = modelList[0].id || modelList[0].model;
          setSelectedModel(firstModel);
          localStorage.setItem('lastSelectedModel', firstModel);
        }
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
    }
  }, [selectedModel]);

  useEffect(() => {
    if (isOpen) {
      fetchModels();
    }
  }, [isOpen, fetchModels]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingMessage]);

  // Hide on chat page - use the full-featured chat there
  if (location.pathname === '/chat') {
    return null;
  }

  // Hide on the chat-first shell's home route - the embedded ChatPage is
  // the full-featured chat there too; QueryPanel still floats over admin
  // pages reached via the shell's Manage group.
  if (location.pathname === '/' && layout === 'chat-first') {
    return null;
  }

  const handleModelChange = (e) => {
    const model = e.target.value;
    setSelectedModel(model);
    localStorage.setItem('lastSelectedModel', model);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!prompt.trim() || isLoading) return;

    // Create a new conversation if this is the first message
    let currentConvId = conversationId;
    const isFirstMessage = messages.length === 0;
    if (isFirstMessage) {
      currentConvId = `fab-${Date.now()}`;
      setConversationId(currentConvId);
    }

    const messageId = Date.now();
    const userMessage = { id: messageId, role: 'user', content: prompt.trim() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setPrompt('');
    setIsLoading(true);
    setStreamingMessage('');
    setWaitingForFirstToken(true);
    setQueueStatus(null);

    // Generate title from first message
    const title = isFirstMessage
      ? prompt.trim().slice(0, 50) + (prompt.trim().length > 50 ? '...' : '')
      : null;

    const startTime = Date.now();
    let tokenCount = 0;

    try {
      // Use our API wrapper to get stats tracking
      const response = await fetch(`${API_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: newMessages.map(m => ({ role: m.role, content: m.content })),
          stream: true
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let usage = null;
      let modelUsed = selectedModel;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          // SSE comment lines (": ...") carry server-side queue status
          // while we're blocked waiting on the local queue. Parse them
          // so the UI can show position + waited time.
          if (line.startsWith(': ')) {
            const m = line.match(/queued position=(\d+|\?)\/(\d+) waited=(\d+)s/);
            if (m) {
              setQueueStatus({
                position: m[1] === '?' ? null : parseInt(m[1], 10),
                total: parseInt(m[2], 10),
                waitedSec: parseInt(m[3], 10)
              });
            }
            continue;
          }
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content || '';
              if (content) {
                if (waitingForFirstToken) {
                  setWaitingForFirstToken(false);
                  setQueueStatus(null);
                }
                fullContent += content;
                tokenCount++;
                setStreamingMessage(fullContent);
              }
              // Capture usage stats if provided
              if (parsed.usage) {
                usage = parsed.usage;
              }
              if (parsed.model) {
                modelUsed = parsed.model;
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }

      const duration = Date.now() - startTime;
      const tokensPerSecond = duration > 0 ? (tokenCount / (duration / 1000)) : 0;

      const messageStats = {
        model: modelUsed,
        promptTokens: usage?.prompt_tokens || 0,
        completionTokens: usage?.completion_tokens || tokenCount,
        totalTokens: (usage?.prompt_tokens || 0) + (usage?.completion_tokens || tokenCount),
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
        duration: Math.round(duration),
        timestamp: new Date().toISOString()
      };

      const assistantMessage = {
        id: Date.now(),
        role: 'assistant',
        content: fullContent,
        stats: messageStats
      };

      const finalMessages = [...newMessages, assistantMessage];
      setMessages(finalMessages);
      setStreamingMessage('');
      setWaitingForFirstToken(false);
      setQueueStatus(null);

      // Save to shared history so ChatPage can see it
      const convTitle = title || (messages.length === 0 ? prompt.trim().slice(0, 50) : 'Quick Chat');
      saveToSharedHistory(currentConvId, convTitle, selectedModel, finalMessages);
    } catch (err) {
      console.error('Query failed:', err);
      setMessages(prev => [...prev, {
        id: Date.now(),
        role: 'assistant',
        content: `Error: ${err.message}`,
        stats: null
      }]);
      setWaitingForFirstToken(false);
      setQueueStatus(null);
    }

    setIsLoading(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const clearChat = () => {
    setMessages([]);
    setStreamingMessage('');
    setHoveredMessage(null);
    setConversationId(null); // Start fresh conversation next time
  };

  // Healthy when EITHER the llama server is up OR the ds4 engine is active and
  // serving (in ds4-exclusive mode llama is intentionally stopped, so ds4 health
  // is the real signal — otherwise the chat/status would show "not running").
  const isHealthy = stats?.llama?.status === 'ok' || stats?.ds4?.status === 'ok';

  return (
    <div className={`query-panel ${isOpen ? 'open' : ''}`}>
      <button
        className={`query-fab glass-btn ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title={isOpen ? 'Close chat' : 'Test query'}
      >
        <span className="fab-icon">{isOpen ? '✕' : '💬'}</span>
      </button>

      <div className="query-container glass-panel glass-panel--floating">
        <div className="query-header">
          <h3>Query Panel</h3>
          <div className="query-controls">
            <SearchableSelect
              value={selectedModel}
              onChange={(val) => {
                setSelectedModel(val);
                localStorage.setItem('queryPanelModel', val);
              }}
              options={models.length === 0 ? [] : models.map(m => ({
                value: m.id || m.model,
                label: formatModelName(m)
              }))}
              placeholder={models.length === 0 ? "No models available" : "Select model..."}
              disabled={!isHealthy || models.length === 0}
              storageKey="queryPanelModel"
            />
            <button className="btn-ghost btn-small glass-btn" onClick={clearChat} title="Clear chat">
              🗑️
            </button>
          </div>
        </div>

        <div className="query-messages">
          {messages.length === 0 && !streamingMessage && (
            <div className="query-empty">
              <p>Send a message to test the model</p>
              {!isHealthy && <p className="hint">Server is not running</p>}
            </div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`query-message ${msg.role}`}
            >
              <div className="message-header">
                <span className="message-role">
                  {msg.role === 'user' ? 'You' : `AI${msg.stats?.model ? ` - ${formatModelName({ id: msg.stats.model })}` : ''}`}
                </span>
                <div className="message-actions">
                  <button
                    className={`btn-icon glass-btn ${copiedId === msg.id ? 'copied' : ''}`}
                    onClick={() => copyToClipboard(msg.content, msg.id)}
                    title="Copy to clipboard"
                  >
                    {copiedId === msg.id ? '✓' : '📋'}
                  </button>
                </div>
              </div>
              <div className="message-content">{parseMessageWithCodeBlocks(msg.content)}</div>
              {msg.role === 'assistant' && msg.stats && (
                <div className="message-stats-inline">
                  {msg.stats.tokensPerSecond} tok/s · {msg.stats.completionTokens} tokens · {(msg.stats.duration / 1000).toFixed(2)}s
                </div>
              )}
            </div>
          ))}
          {streamingMessage && (
            <div className="query-message assistant streaming">
              <div className="message-header">
                <span className="message-role">AI{selectedModel ? ` - ${formatModelName({ id: selectedModel })}` : ''}</span>
              </div>
              <div className="message-content">{parseMessageWithCodeBlocks(streamingMessage)}</div>
            </div>
          )}
          {waitingForFirstToken && !streamingMessage && (
            <div className="query-message assistant waiting">
              <div className="message-header">
                <span className="message-role">AI{selectedModel ? ` - ${formatModelName({ id: selectedModel })}` : ''}</span>
              </div>
              <div className="message-content">
                <span className="query-thinking">
                  <span className="query-thinking-dot">·</span>
                  <span className="query-thinking-dot">·</span>
                  <span className="query-thinking-dot">·</span>
                  <span className="query-thinking-label">
                    {queueStatus
                      ? (queueStatus.position
                          ? `Queued: position ${queueStatus.position}/${queueStatus.total} — waited ${queueStatus.waitedSec}s`
                          : `Waiting in queue (${queueStatus.total} ahead) — ${queueStatus.waitedSec}s`)
                      : 'Thinking…'}
                  </span>
                </span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <form className="query-input" onSubmit={handleSubmit}>
          <textarea
            className="glass-input"
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isHealthy ? "Type a message... (Enter to send)" : "Server not running"}
            disabled={!isHealthy || isLoading}
            rows={1}
          />
          <button
            type="submit"
            className="btn-primary glass-btn"
            disabled={!isHealthy || isLoading || !prompt.trim()}
          >
            {isLoading ? '...' : '→'}
          </button>
        </form>
      </div>
    </div>
  );
}

export { QueryPanel };
