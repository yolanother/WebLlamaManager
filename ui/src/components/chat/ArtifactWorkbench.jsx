// Llama Manager — editable artifact workbench panel.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Presents line-numbered highlighted output, immutable history navigation,
// renaming, copying, downloading, and a zero-dependency overlay editor.

import hljs from 'highlight.js';
import { useEffect, useRef, useState } from 'react';

import { copyTextToClipboard } from '../../api.js';
import {
  extensionForLanguage,
  getArtifactVersion,
} from './artifacts.js';

function WorkbenchIcon({ type }) {
  if (type === 'copy') return <path d="M8 8h11v11H8zM5 16H4V4h12v1" />;
  if (type === 'download') return <path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14" />;
  if (type === 'edit') return <path d="m4 16-1 5 5-1L19 9l-4-4L4 16ZM13 7l4 4" />;
  if (type === 'close') return <path d="m7 7 10 10M17 7 7 17" />;
  return null;
}

function HighlightedLine({ language, line, number }) {
  const codeRef = useRef(null);
  useEffect(() => {
    const code = codeRef.current;
    if (!code) return;
    code.removeAttribute('data-highlighted');
    try {
      hljs.highlightElement(code);
    } catch {
      // Unsupported language names remain readable plain text.
    }
  }, [language, line]);

  return (
    <span className="chat-workbench-code-line">
      <span className="chat-workbench-line-number" aria-hidden="true">{number}</span>
      <code ref={codeRef} className={language ? `language-${language}` : ''}>
        {line || ' '}
      </code>
    </span>
  );
}

function HighlightedCode({ content, language }) {
  const lines = String(content ?? '').split('\n');
  return (
    <pre className="chat-workbench-code">
      {lines.map((line, index) => (
        <HighlightedLine
          key={`${index}-${line}`}
          language={language}
          line={line}
          number={index + 1}
        />
      ))}
    </pre>
  );
}

/**
 * Right-side complementary region for viewing and editing one artifact.
 */
function ArtifactWorkbench({
  artifact,
  onClose,
  onCommit,
  onNavigate,
  onRename,
}) {
  const version = getArtifactVersion(artifact);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(version.content);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(artifact.title);
  const [copied, setCopied] = useState(false);
  const baseContentRef = useRef(version.content);
  const highlightScrollRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (isEditing) return;
    setDraft(version.content);
    baseContentRef.current = version.content;
  }, [artifact.id, artifact.versionIndex, isEditing, version.content]);

  useEffect(() => {
    setNameDraft(artifact.title);
  }, [artifact.id, artifact.title]);

  const commitDraft = () => {
    if (draft !== baseContentRef.current) {
      onCommit(draft);
      baseContentRef.current = draft;
    }
  };

  const finishEditing = () => {
    commitDraft();
    setIsEditing(false);
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.target.closest?.('.chat-link-dialog, .chat-model-menu, .chat-attach-menu')) return;
      event.preventDefault();
      if (isEditing) finishEditing();
      else if (renaming) setRenaming(false);
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const commitName = () => {
    const nextName = nameDraft.trim();
    if (nextName && nextName !== artifact.title) onRename(nextName);
    else setNameDraft(artifact.title);
    setRenaming(false);
  };

  const download = () => {
    const extension = extensionForLanguage(artifact.language);
    const safeTitle = artifact.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim()
      || `artifact.${extension}`;
    const filename = /\.[a-z0-9]{1,8}$/i.test(safeTitle)
      ? safeTitle
      : `${safeTitle}.${extension}`;
    const url = URL.createObjectURL(new Blob([version.content], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <aside
      className="chat-workbench glass-panel glass-panel--floating"
      role="complementary"
      aria-label={`Artifact workbench: ${artifact.title}`}
    >
      <header className="chat-workbench-header">
        <div className="chat-workbench-title-group">
          {renaming ? (
            <input
              className="chat-workbench-title-input"
              autoFocus
              value={nameDraft}
              aria-label="Artifact title"
              onBlur={commitName}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitName();
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setNameDraft(artifact.title);
                  setRenaming(false);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="chat-workbench-title"
              onClick={() => setRenaming(true)}
              title="Rename artifact"
            >
              {artifact.title}
            </button>
          )}
          <span className="glass-chip chat-workbench-language">
            {artifact.language || 'text'}
          </span>
        </div>
        <div className="chat-workbench-actions">
          <button
            type="button"
            className="glass-btn"
            onClick={async () => {
              await copyTextToClipboard(version.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            title="Copy artifact"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><WorkbenchIcon type="copy" /></svg>
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <button type="button" className="glass-btn" onClick={download} title="Download artifact">
            <svg viewBox="0 0 24 24" aria-hidden="true"><WorkbenchIcon type="download" /></svg>
            <span>Download</span>
          </button>
          <button
            type="button"
            className={`glass-btn ${isEditing ? 'is-active' : ''}`}
            aria-pressed={isEditing}
            onClick={() => {
              if (isEditing) finishEditing();
              else {
                setIsEditing(true);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }
            }}
            title="Edit artifact"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><WorkbenchIcon type="edit" /></svg>
            <span>{isEditing ? 'Done' : 'Edit'}</span>
          </button>
          <div className="chat-workbench-versions" aria-label="Artifact versions">
            <button
              type="button"
              onClick={() => onNavigate(-1)}
              disabled={isEditing || artifact.versionIndex <= 0}
              aria-label="Previous artifact version"
            >
              ‹
            </button>
            <span>v{artifact.versionIndex + 1}/{artifact.versions.length}</span>
            <button
              type="button"
              onClick={() => onNavigate(1)}
              disabled={isEditing || artifact.versionIndex >= artifact.versions.length - 1}
              aria-label="Next artifact version"
            >
              ›
            </button>
          </div>
          <button type="button" className="chat-icon-btn" onClick={onClose} aria-label="Close artifact">
            <svg viewBox="0 0 24 24" aria-hidden="true"><WorkbenchIcon type="close" /></svg>
          </button>
        </div>
      </header>
      <div className={`chat-workbench-body ${isEditing ? 'is-editing' : ''}`}>
        {isEditing ? (
          <div className="chat-workbench-editor">
            <div className="chat-workbench-highlight" ref={highlightScrollRef} aria-hidden="true">
              <HighlightedCode content={draft} language={artifact.language} />
            </div>
            <textarea
              ref={textareaRef}
              className="chat-workbench-textarea"
              value={draft}
              aria-label={`Edit ${artifact.title}`}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              wrap="off"
              onBlur={commitDraft}
              onChange={(event) => setDraft(event.target.value)}
              onScroll={(event) => {
                if (!highlightScrollRef.current) return;
                highlightScrollRef.current.scrollTop = event.currentTarget.scrollTop;
                highlightScrollRef.current.scrollLeft = event.currentTarget.scrollLeft;
              }}
            />
          </div>
        ) : (
          <div className="chat-workbench-view">
            <HighlightedCode content={version.content} language={artifact.language} />
          </div>
        )}
      </div>
    </aside>
  );
}

export { ArtifactWorkbench };
