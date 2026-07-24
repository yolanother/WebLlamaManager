// Llama Manager — scroll-aware chat transcript.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Maintains near-bottom auto-scroll behavior, a jump-to-latest affordance,
// streaming status, day-group rhythm, empty-state suggestions, artifact
// launchers, and drag-and-drop feedback.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { Message } from './Message.jsx';

const SUGGESTIONS = [
  'Explain how automatic model routing works.',
  'Write a concise system prompt for a research assistant.',
  'Compare the attached images and list meaningful differences.',
  'Paste a YouTube link and ask what happens at 01:15',
];

function dayDetails(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
  return {
    key,
    label: key === todayKey
      ? 'Today'
      : date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }),
  };
}

/**
 * Centered, scrollable message column with restrained auto-follow behavior.
 */
function MessageList({
  artifacts = [],
  messages,
  streamingMessage,
  routedModel,
  isStreaming,
  onEdit,
  onOpenArtifact,
  onRegenerate,
  onSuggestion,
  onDropFiles,
}) {
  const scrollRef = useRef(null);
  const [nearBottom, setNearBottom] = useState(true);
  const [dragging, setDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const artifactsById = useMemo(
    () => new Map(artifacts.map((artifact) => [artifact.id, artifact])),
    [artifacts],
  );
  const lastAssistantId = !isStreaming && messages.at(-1)?.role === 'assistant'
    ? messages.at(-1).id
    : null;

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
          messages.map((message, index) => {
            const day = dayDetails(message.timestamp);
            const previousDay = dayDetails(messages[index - 1]?.timestamp);
            const showDay = day && day.key !== previousDay?.key;
            const spacing = index > 0 && messages[index - 1].role === message.role
              ? 'same-role'
              : 'role-change';
            return (
              <Fragment key={message.id}>
                {showDay && (
                  <div className="chat-day-divider" role="separator" aria-label={day.label}>
                    <span className="glass-chip">{day.label}</span>
                  </div>
                )}
                <Message
                  artifacts={(message.artifactIds || [])
                    .map((id) => artifactsById.get(id))
                    .filter(Boolean)}
                  message={message}
                  onEdit={onEdit}
                  onOpenArtifact={onOpenArtifact}
                  onRegenerate={message.id === lastAssistantId ? onRegenerate : undefined}
                  spacing={spacing}
                />
              </Fragment>
            );
          })
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
            spacing={messages.at(-1)?.role === 'assistant' ? 'same-role' : 'role-change'}
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
