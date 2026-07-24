// Llama Manager — scroll-aware chat transcript.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Maintains near-bottom auto-scroll behavior, a jump-to-latest affordance,
// streaming status, empty-state suggestions, and drag-and-drop feedback.

import { useEffect, useRef, useState } from 'react';

import { Message } from './Message.jsx';

const SUGGESTIONS = [
  'Explain how automatic model routing works.',
  'Write a concise system prompt for a research assistant.',
  'Compare the attached images and list meaningful differences.',
  'Paste a YouTube link and ask what happens at 01:15',
];

/**
 * Centered, scrollable message column with restrained auto-follow behavior.
 */
function MessageList({
  messages,
  streamingMessage,
  routedModel,
  isStreaming,
  onEdit,
  onRegenerate,
  onSuggestion,
  onDropFiles,
}) {
  const scrollRef = useRef(null);
  const [nearBottom, setNearBottom] = useState(true);
  const [dragging, setDragging] = useState(false);
  const dragDepthRef = useRef(0);

  const jumpToLatest = (behavior = 'smooth') => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
    setNearBottom(true);
  };

  useEffect(() => {
    if (nearBottom) jumpToLatest(isStreaming ? 'auto' : 'smooth');
  }, [messages, streamingMessage, isStreaming]);

  return (
    <div
      className={`chat-transcript ${dragging ? 'is-dragging' : ''}`}
      ref={scrollRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        setNearBottom(element.scrollHeight - element.scrollTop - element.clientHeight <= 100);
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        setDragging(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepthRef.current -= 1;
        if (dragDepthRef.current <= 0) {
          dragDepthRef.current = 0;
          setDragging(false);
        }
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setDragging(false);
        onDropFiles([...event.dataTransfer.files]);
      }}
    >
      <div className="chat-message-column">
        {messages.length === 0 && !isStreaming ? (
          <div className="chat-welcome">
            <div className="chat-welcome-mark">L</div>
            <span className="chat-eyebrow">First-class local intelligence</span>
            <h1>What are we exploring?</h1>
            <p>Ask anything, attach a visual, or bring a video timeline into the conversation.</p>
            <div className="chat-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  type="button"
                  className="glass-chip"
                  key={suggestion}
                  onClick={() => onSuggestion(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              onEdit={onEdit}
              onRegenerate={onRegenerate}
            />
          ))
        )}
        {isStreaming && (
          <Message
            isStreaming
            message={{
              id: 'streaming',
              role: 'assistant',
              content: streamingMessage,
              routedModel,
            }}
          />
        )}
      </div>
      {dragging && (
        <div className="chat-drop-overlay" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M12 16V4m0 0L7 9m5-5 5 5M5 14v6h14v-6" />
          </svg>
          <strong>Drop images or videos to attach</strong>
        </div>
      )}
      {!nearBottom && (
        <button type="button" className="glass-chip chat-jump-latest" onClick={() => jumpToLatest()}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 10 5 5 5-5" />
          </svg>
          Jump to latest
        </button>
      )}
    </div>
  );
}

export { MessageList };
