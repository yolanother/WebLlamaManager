// Llama Manager — chat attachment status chip.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Renders image previews, audio/video metadata, upload progress, ingest errors,
// retry, and removal controls for pending multimodal composer inputs.

import { formatMediaTime } from './attachments.js';

/**
 * Visual attachment summary shown above the composer textarea.
 */
function AttachmentChip({ attachment, onRemove, onRetry }) {
  const isImage = attachment.kind === 'image';
  const isAudio = attachment.kind === 'audio';
  const isBusy = attachment.status === 'uploading';
  const isError = attachment.status === 'error';

  return (
    <div className={`chat-attachment-chip glass-chip ${isError ? 'is-error' : ''}`}>
      <div className="chat-attachment-preview" aria-hidden="true">
        {isImage && attachment.dataUrl ? (
          <img src={attachment.dataUrl} alt="" />
        ) : isAudio ? (
          <svg viewBox="0 0 24 24">
            <path d="M9 18V6l10-2v12M9 9l10-2M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm10-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
          </svg>
        ) : attachment.kind === 'text' ? (
          <svg viewBox="0 0 24 24">
            <path d="M6 3h8l4 4v14H6zM14 3v5h5M9 12h6M9 16h6" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24">
            <path d="M4 5h16v14H4zM8 5v14M16 5v14M4 9h4m8 0h4M4 15h4m8 0h4" />
          </svg>
        )}
      </div>
      <span className="chat-attachment-copy">
        <strong>{attachment.filename || 'Attachment'}</strong>
        <small>
          {isBusy && <><span className="chat-spinner" /> Processing…</>}
          {isError && (
            <>
              <span>{attachment.error}</span>
              {attachment.hint && <span>{attachment.hint}</span>}
            </>
          )}
          {!isBusy && !isError && attachment.kind === 'video' && (
            `${formatMediaTime(attachment.durationSec)} · ${attachment.frames?.length || 0} frames`
          )}
          {!isBusy && !isError && isAudio && formatMediaTime(attachment.durationSec)}
          {!isBusy && !isError && attachment.kind === 'text' && (
            `${attachment.text?.length.toLocaleString() || 0} characters`
          )}
          {!isBusy && !isError && isImage && 'Image'}
        </small>
      </span>
      {isError && (
        <button
          type="button"
          className="chat-attachment-action"
          onClick={() => onRetry(attachment.id)}
          aria-label={`Retry ${attachment.filename || 'attachment'}`}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className="chat-attachment-action"
        onClick={() => onRemove(attachment.id)}
        aria-label={`Remove ${attachment.filename || 'attachment'}`}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m7 7 10 10M17 7 7 17" />
        </svg>
      </button>
    </div>
  );
}

export { AttachmentChip };
