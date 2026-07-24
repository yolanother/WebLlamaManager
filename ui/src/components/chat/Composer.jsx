// Llama Manager — multimodal chat composer.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Provides an auto-growing editor, smart paste, attachment menu and dialog,
// pending attachment chips, in-composer model selection, and stream controls.

import { useEffect, useRef, useState } from 'react';

import { AttachmentChip } from './AttachmentChip.jsx';
import { classifyPaste } from './attachments.js';
import { ModelPicker } from './ModelPicker.jsx';

function ComposerIcon({ type }) {
  if (type === 'plus') return <path d="M12 5v14M5 12h14" />;
  if (type === 'image') return <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m3 16 5-5 4 4 3-3 6 6M15 8h.01" /></>;
  if (type === 'video') return <><rect x="3" y="5" width="14" height="14" rx="2" /><path d="m17 10 4-2v8l-4-2" /></>;
  if (type === 'link') return <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1m3 6a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />;
  if (type === 'stop') return <rect x="6" y="6" width="12" height="12" rx="2" />;
  return <path d="M12 19V5m0 0-6 6m6-6 6 6" />;
}

/**
 * Docked floating input surface for text and multimodal chat requests.
 */
function Composer({
  artifactContext,
  attachments,
  disabled,
  editing,
  isStreaming,
  model,
  models,
  onCancelEdit,
  onChange,
  onDismissArtifactContext,
  onImageFiles,
  onLongText,
  onModelChange,
  onRemoveAttachment,
  onRetryAttachment,
  onStop,
  onSubmit,
  onUrl,
  onVideoFiles,
  value,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const textareaRef = useRef(null);
  const imageInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const menuRef = useRef(null);
  const busy = attachments.some((attachment) => attachment.status === 'uploading');
  const hasReadyAttachment = attachments.some((attachment) => attachment.status === 'ready');
  const canSend = !disabled && !busy && Boolean(value.trim() || hasReadyAttachment);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '44px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [value]);

  useEffect(() => {
    const close = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  const submit = () => {
    if (!canSend || isStreaming) return;
    onSubmit();
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const chooseFiles = (files) => {
    const images = files.filter((file) => file.type.startsWith('image/'));
    const videos = files.filter((file) => file.type.startsWith('video/'));
    if (images.length) onImageFiles(images);
    if (videos.length) onVideoFiles(videos);
  };

  return (
    <div className="chat-composer-wrap">
      {editing && (
        <div className="chat-edit-banner">
          <span>Editing your message — sending will replace later replies.</span>
          <button type="button" onClick={onCancelEdit}>Cancel</button>
        </div>
      )}
      <div className="chat-composer glass-panel glass-panel--floating">
        {artifactContext && (
          <div className="chat-artifact-context glass-chip">
            <span aria-hidden="true">&lt;/&gt;</span>
            <strong>Editing: {artifactContext.title} (v{artifactContext.versionIndex + 1})</strong>
            <button
              type="button"
              onClick={onDismissArtifactContext}
              aria-label={`Stop editing ${artifactContext.title} with the agent`}
            >
              ×
            </button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="chat-attachment-list">
            {attachments.map((attachment) => (
              <AttachmentChip
                key={attachment.id}
                attachment={attachment}
                onRemove={onRemoveAttachment}
                onRetry={onRetryAttachment}
              />
            ))}
          </div>
        )}
        <label className="chat-visually-hidden" htmlFor="chat-prompt">Message</label>
        <textarea
          id="chat-prompt"
          ref={textareaRef}
          className="chat-composer-textarea"
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={disabled ? 'Start a model to begin chatting' : 'Message Llama Manager'}
          onChange={(event) => onChange(event.target.value)}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData('text/plain');
            const classification = classifyPaste(pasted);
            if (classification.type === 'attachment-url') {
              event.preventDefault();
              onUrl(classification.url);
            } else if (classification.type === 'text-attachment') {
              event.preventDefault();
              onLongText(classification.text);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && editing) {
              event.preventDefault();
              onCancelEdit();
            } else if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="chat-composer-toolbar">
          <div className="chat-composer-tools">
            <div className="chat-attach-root" ref={menuRef}>
              <button
                type="button"
                className="chat-composer-icon"
                aria-label="Add attachment"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((current) => !current)}
                disabled={disabled || isStreaming}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><ComposerIcon type="plus" /></svg>
              </button>
              {menuOpen && (
                <div className="chat-attach-menu glass-panel glass-panel--floating">
                  <button type="button" onClick={() => {
                    imageInputRef.current?.click();
                    setMenuOpen(false);
                  }}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><ComposerIcon type="image" /></svg>
                    <span><strong>Image</strong><small>PNG, JPEG, WebP, and more</small></span>
                  </button>
                  <button type="button" onClick={() => {
                    videoInputRef.current?.click();
                    setMenuOpen(false);
                  }}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><ComposerIcon type="video" /></svg>
                    <span><strong>Video file</strong><small>Upload and sample frames</small></span>
                  </button>
                  <button type="button" onClick={() => {
                    setLinkOpen(true);
                    setMenuOpen(false);
                  }}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><ComposerIcon type="link" /></svg>
                    <span><strong>Video or YouTube link</strong><small>Ingest a public URL</small></span>
                  </button>
                </div>
              )}
            </div>
            <input
              type="file"
              hidden
              multiple
              accept="image/*"
              ref={imageInputRef}
              onChange={(event) => {
                chooseFiles([...event.target.files]);
                event.target.value = '';
              }}
            />
            <input
              type="file"
              hidden
              multiple
              accept="video/*"
              ref={videoInputRef}
              onChange={(event) => {
                chooseFiles([...event.target.files]);
                event.target.value = '';
              }}
            />
            <ModelPicker
              value={model}
              models={models}
              onChange={onModelChange}
              disabled={isStreaming}
            />
          </div>
          {isStreaming ? (
            <button type="button" className="chat-submit-button is-stop" onClick={onStop}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><ComposerIcon type="stop" /></svg>
              <span className="chat-visually-hidden">Stop generating</span>
            </button>
          ) : (
            <button type="button" className="chat-submit-button" onClick={submit} disabled={!canSend}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><ComposerIcon type="send" /></svg>
              <span className="chat-visually-hidden">Send message</span>
            </button>
          )}
        </div>
      </div>
      <p className="chat-composer-hint">Enter to send · Shift+Enter for a new line</p>
      {linkOpen && (
        <div className="chat-dialog-backdrop" role="presentation" onMouseDown={() => setLinkOpen(false)}>
          <div
            className="chat-link-dialog glass-panel glass-panel--floating"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-link-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="chat-icon-btn chat-dialog-close"
              onClick={() => setLinkOpen(false)}
              aria-label="Close link dialog"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
            </button>
            <span className="chat-eyebrow">Multimodal ingest</span>
            <h2 id="chat-link-title">Attach a video link</h2>
            <p>Paste a direct video URL or a YouTube link. We’ll sample frames for analysis.</p>
            <label htmlFor="chat-video-url">Video URL</label>
            <input
              id="chat-video-url"
              type="url"
              className="glass-input"
              autoFocus
              value={linkValue}
              onChange={(event) => setLinkValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setLinkOpen(false);
                if (event.key === 'Enter' && linkValue.trim()) {
                  onUrl(linkValue.trim());
                  setLinkValue('');
                  setLinkOpen(false);
                }
              }}
              placeholder="https://youtube.com/watch?v=…"
            />
            <button
              type="button"
              className="glass-btn chat-link-submit"
              disabled={!linkValue.trim()}
              onClick={() => {
                onUrl(linkValue.trim());
                setLinkValue('');
                setLinkOpen(false);
              }}
            >
              Attach video
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export { Composer };
