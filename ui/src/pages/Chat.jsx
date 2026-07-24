// Llama Manager — chat page.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Provides persisted conversations, model selection, image attachments, message
// rendering, and streaming chat completions.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { API_BASE, copyTextToClipboard, formatModelName } from '../api.js';
import { parseMessageWithCodeBlocks } from '../components/CodeBlock.jsx';
import { SearchableSelect } from '../components/SearchableSelect.jsx';

// Chat Page
function ChatPage({ stats }) {
  const [conversations, setConversations] = useState(() => {
    try {
      const saved = localStorage.getItem('chat_conversations');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [activeConversationId, setActiveConversationId] = useState(() => {
    try {
      return localStorage.getItem('chat_active_conversation') || null;
    } catch {
      return null;
    }
  });
  const [models, setModels] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState('');
  const [pendingImages, setPendingImages] = useState([]);
  const [hoveredMessage, setHoveredMessage] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [copiedId, setCopiedId] = useState(null);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);

  const activeConversation = conversations.find(c => c.id === activeConversationId);

  // Persist conversations
  useEffect(() => {
    localStorage.setItem('chat_conversations', JSON.stringify(conversations));
  }, [conversations]);

  useEffect(() => {
    if (activeConversationId) {
      localStorage.setItem('chat_active_conversation', activeConversationId);
    }
  }, [activeConversationId]);

  // Fetch models
  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/v1/models`);
      if (res.ok) {
        const data = await res.json();
        setModels(data.data || []);
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
    }
  }, []);

  useEffect(() => {
    fetchModels();
    const interval = setInterval(fetchModels, 10000);
    return () => clearInterval(interval);
  }, [fetchModels]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversation?.messages, streamingMessage]);

  const createConversation = () => {
    const newConv = {
      id: Date.now().toString(),
      title: 'New Chat',
      model: models[0]?.id || '',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setConversations(prev => [newConv, ...prev]);
    setActiveConversationId(newConv.id);
  };

  const deleteConversation = (id) => {
    setConversations(prev => prev.filter(c => c.id !== id));
    if (activeConversationId === id) {
      const remaining = conversations.filter(c => c.id !== id);
      setActiveConversationId(remaining[0]?.id || null);
    }
  };

  const updateConversation = (id, updates) => {
    setConversations(prev => prev.map(c =>
      c.id === id ? { ...c, ...updates, updatedAt: new Date().toISOString() } : c
    ));
  };

  const copyToClipboard = async (text, messageId) => {
    try {
      await copyTextToClipboard(text);
      setCopiedId(messageId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleImageUpload = (e) => {
    const files = Array.from(e.target.files);
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (event) => {
        setPendingImages(prev => [...prev, {
          id: Date.now() + Math.random(),
          name: file.name,
          url: event.target.result
        }]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const removePendingImage = (id) => {
    setPendingImages(prev => prev.filter(img => img.id !== id));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if ((!prompt.trim() && pendingImages.length === 0) || isLoading || !activeConversation) return;

    // Build message content
    let content;
    if (pendingImages.length > 0) {
      content = [];
      if (prompt.trim()) {
        content.push({ type: 'text', text: prompt.trim() });
      }
      pendingImages.forEach(img => {
        content.push({
          type: 'image_url',
          image_url: { url: img.url }
        });
      });
    } else {
      content = prompt.trim();
    }

    const userMessage = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: new Date().toISOString()
    };

    // Update title from first message
    if (activeConversation.messages.length === 0 && typeof content === 'string') {
      updateConversation(activeConversation.id, {
        title: content.slice(0, 50) + (content.length > 50 ? '...' : '')
      });
    }

    updateConversation(activeConversation.id, {
      messages: [...activeConversation.messages, userMessage]
    });

    setPrompt('');
    setPendingImages([]);
    setIsLoading(true);
    setStreamingMessage('');

    const startTime = Date.now();
    let tokenCount = 0;

    try {
      // Build messages array for API
      const apiMessages = [...activeConversation.messages, userMessage].map(m => ({
        role: m.role,
        content: m.content
      }));

      const response = await fetch(`${API_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: activeConversation.model,
          messages: apiMessages,
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
      let modelUsed = activeConversation.model;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content || '';
              if (content) {
                fullContent += content;
                tokenCount++;
                setStreamingMessage(fullContent);
              }
              if (parsed.usage) usage = parsed.usage;
              if (parsed.model) modelUsed = parsed.model;
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }

      const duration = Date.now() - startTime;
      const tokensPerSecond = duration > 0 ? (tokenCount / (duration / 1000)) : 0;

      const assistantMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: fullContent,
        timestamp: new Date().toISOString(),
        stats: {
          model: modelUsed,
          promptTokens: usage?.prompt_tokens || 0,
          completionTokens: usage?.completion_tokens || tokenCount,
          totalTokens: (usage?.prompt_tokens || 0) + (usage?.completion_tokens || tokenCount),
          tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
          duration: Math.round(duration)
        }
      };

      updateConversation(activeConversation.id, {
        messages: [...activeConversation.messages, userMessage, assistantMessage]
      });
      setStreamingMessage('');
    } catch (err) {
      console.error('Chat failed:', err);
      const errorMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: `Error: ${err.message}`,
        timestamp: new Date().toISOString()
      };
      updateConversation(activeConversation.id, {
        messages: [...activeConversation.messages, userMessage, errorMessage]
      });
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
    if (activeConversation) {
      updateConversation(activeConversation.id, { messages: [] });
    }
    setStreamingMessage('');
    setHoveredMessage(null);
  };

  // Healthy when EITHER the llama server is up OR the ds4 engine is active and
  // serving (in ds4-exclusive mode llama is intentionally stopped, so ds4 health
  // is the real signal — otherwise the chat/status would show "not running").
  const isHealthy = stats?.llama?.status === 'ok' || stats?.ds4?.status === 'ok';

  const formatTimestamp = (ts) => {
    const date = new Date(ts);
    const now = new Date();
    const diff = now - date;
    if (diff < 86400000) {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const renderMessageContent = (content) => {
    if (typeof content === 'string') {
      return parseMessageWithCodeBlocks(content);
    }
    // Multimodal content
    return content.map((part, i) => {
      if (part.type === 'text') {
        return <span key={i}>{parseMessageWithCodeBlocks(part.text)}</span>;
      }
      if (part.type === 'image_url') {
        return <img key={i} src={part.image_url.url} alt="User uploaded" className="message-image" />;
      }
      return null;
    });
  };

  return (
    <div className="page chat-page">
      <div className="chat-layout">
        {/* Conversations Sidebar */}
        <div className="chat-sidebar">
          <div className="chat-sidebar-header">
            <h3>Conversations</h3>
            <button className="btn-primary btn-small" onClick={createConversation}>
              + New
            </button>
          </div>
          <div className="conversation-list">
            {conversations.length === 0 ? (
              <div className="chat-empty-sidebar">
                <p>No conversations yet</p>
              </div>
            ) : (
              conversations.map(conv => (
                <div
                  key={conv.id}
                  className={`conversation-item ${conv.id === activeConversationId ? 'active' : ''}`}
                  onClick={() => setActiveConversationId(conv.id)}
                >
                  <div className="conv-title">{conv.title}</div>
                  <div className="conv-meta">
                    {formatTimestamp(conv.updatedAt)}
                    <button
                      className="conv-delete"
                      onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Main Chat Area */}
        <div className="chat-main">
          {activeConversation ? (
            <>
              <div className="chat-header">
                <SearchableSelect
                  value={activeConversation.model}
                  onChange={(val) => updateConversation(activeConversation.id, { model: val })}
                  options={models.length === 0 ? [] : models.map(m => ({
                    value: m.id,
                    label: formatModelName(m)
                  }))}
                  placeholder={models.length === 0 ? "No models available" : "Select model..."}
                  disabled={!isHealthy || models.length === 0}
                  storageKey="chatModel"
                />
                <button className="btn-ghost btn-small" onClick={clearChat} title="Clear chat">
                  Clear
                </button>
              </div>

              <div className="chat-messages">
                {activeConversation.messages.length === 0 && !streamingMessage && (
                  <div className="chat-empty">
                    <p>Send a message to start the conversation</p>
                    {!isHealthy && <p className="hint">Server is not running</p>}
                  </div>
                )}
                {activeConversation.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`chat-message ${msg.role}`}
                  >
                    <div className="message-header">
                      <span className="message-role">
                        {msg.role === 'user' ? 'You' : `AI${msg.stats?.model ? ` - ${formatModelName({ id: msg.stats.model })}` : ''}`}
                      </span>
                      <div className="message-actions">
                        <button
                          className={`btn-icon ${copiedId === msg.id ? 'copied' : ''}`}
                          onClick={() => copyToClipboard(
                            typeof msg.content === 'string' ? msg.content : msg.content.map(p => p.text || '').join(''),
                            msg.id
                          )}
                          title="Copy"
                        >
                          {copiedId === msg.id ? '✓' : '📋'}
                        </button>
                      </div>
                    </div>
                    <div className="message-content">{renderMessageContent(msg.content)}</div>
                    {msg.role === 'assistant' && msg.stats && (
                      <div className="message-stats-inline">
                        {msg.stats.tokensPerSecond} tok/s · {msg.stats.completionTokens} tokens · {(msg.stats.duration / 1000).toFixed(2)}s
                      </div>
                    )}
                  </div>
                ))}
                {streamingMessage && (
                  <div className="chat-message assistant streaming">
                    <div className="message-header">
                      <span className="message-role">AI{activeConversation.model ? ` - ${formatModelName({ id: activeConversation.model })}` : ''}</span>
                    </div>
                    <div className="message-content">{parseMessageWithCodeBlocks(streamingMessage)}</div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Pending Images */}
              {pendingImages.length > 0 && (
                <div className="pending-images">
                  {pendingImages.map(img => (
                    <div key={img.id} className="pending-image">
                      <img src={img.url} alt={img.name} />
                      <button onClick={() => removePendingImage(img.id)}>×</button>
                    </div>
                  ))}
                </div>
              )}

              <form className="chat-input-area" onSubmit={handleSubmit}>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleImageUpload}
                  accept="image/*"
                  multiple
                  style={{ display: 'none' }}
                />
                <button
                  type="button"
                  className="btn-ghost btn-small"
                  onClick={() => fileInputRef.current?.click()}
                  title="Upload image"
                >
                  📎
                </button>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={isHealthy ? "Type a message... (Enter to send)" : "Server not running"}
                  disabled={!isHealthy || isLoading}
                  rows={1}
                  className="chat-input"
                />
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={!isHealthy || isLoading || (!prompt.trim() && pendingImages.length === 0)}
                >
                  {isLoading ? '...' : '→'}
                </button>
              </form>
            </>
          ) : (
            <div className="chat-empty">
              <p>Select a conversation or create a new one</p>
              <button className="btn-primary" onClick={createConversation}>
                + New Conversation
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ChatPage;
