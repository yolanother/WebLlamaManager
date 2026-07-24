// Llama Manager — persisted conversation rail.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Groups conversations by date and provides creation, selection, rename,
// deletion, JSON import, JSON export, and responsive rail dismissal.

import { useMemo, useRef, useState } from 'react';

function dateGroup(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((startToday - startDate) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  return 'Older';
}

/**
 * Collapsible, date-grouped conversation navigation rail.
 */
function ConversationSidebar({
  activeId,
  conversations,
  open,
  onClose,
  onCreate,
  onDelete,
  onImport,
  onRename,
  onSelect,
}) {
  const [renamingId, setRenamingId] = useState(null);
  const [draftTitle, setDraftTitle] = useState('');
  const importRef = useRef(null);
  const groups = useMemo(() => {
    const result = new Map();
    conversations.forEach((conversation) => {
      const group = dateGroup(conversation.updatedAt || conversation.createdAt);
      if (!result.has(group)) result.set(group, []);
      result.get(group).push(conversation);
    });
    return result;
  }, [conversations]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(conversations, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `llama-manager-chats-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const commitRename = (id) => {
    const title = draftTitle.trim();
    if (title) onRename(id, title);
    setRenamingId(null);
  };

  return (
    <>
      {open && <button className="chat-rail-scrim" onClick={onClose} aria-label="Close conversations" />}
      <aside className={`chat-rail glass-panel ${open ? 'is-open' : ''}`} aria-label="Conversations">
        <div className="chat-rail-header">
          <div>
            <span className="chat-eyebrow">Workspace</span>
            <h2>Conversations</h2>
          </div>
          <button className="chat-icon-btn chat-rail-close" onClick={onClose} aria-label="Close conversations">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m7 7 10 10M17 7 7 17" />
            </svg>
          </button>
        </div>
        <button type="button" className="glass-btn chat-new-button" onClick={onCreate}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New conversation
        </button>
        <div className="chat-conversation-list">
          {groups.size === 0 && <p className="chat-rail-empty">No conversations yet.</p>}
          {[...groups.entries()].map(([group, items]) => (
            <section key={group} className="chat-conversation-group">
              <h3>{group}</h3>
              {items.map((conversation) => (
                <div
                  key={conversation.id}
                  className={`chat-conversation-row ${conversation.id === activeId ? 'is-active' : ''}`}
                >
                  {renamingId === conversation.id ? (
                    <input
                      className="glass-input chat-rename-input"
                      value={draftTitle}
                      autoFocus
                      aria-label="Conversation title"
                      onChange={(event) => setDraftTitle(event.target.value)}
                      onBlur={() => commitRename(conversation.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitRename(conversation.id);
                        if (event.key === 'Escape') setRenamingId(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="chat-conversation-select"
                      onClick={() => {
                        onSelect(conversation.id);
                        if (window.innerWidth < 1200) onClose();
                      }}
                      title={conversation.title}
                    >
                      <span>{conversation.title || 'New conversation'}</span>
                    </button>
                  )}
                  {renamingId !== conversation.id && (
                    <div className="chat-conversation-actions">
                      <button
                        type="button"
                        className="chat-mini-btn"
                        aria-label={`Rename ${conversation.title}`}
                        onClick={() => {
                          setDraftTitle(conversation.title);
                          setRenamingId(conversation.id);
                        }}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="m4 16-1 5 5-1L19 9l-4-4L4 16ZM13 7l4 4" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="chat-mini-btn"
                        aria-label={`Delete ${conversation.title}`}
                        onClick={() => onDelete(conversation.id)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="chat-rail-footer">
          <input
            type="file"
            accept="application/json,.json"
            hidden
            ref={importRef}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onImport(file);
              event.target.value = '';
            }}
          />
          <button type="button" className="chat-rail-tool" onClick={() => importRef.current?.click()}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 16V4m0 0L7 9m5-5 5 5M5 14v6h14v-6" />
            </svg>
            Import
          </button>
          <button type="button" className="chat-rail-tool" onClick={exportJson}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4v12m0 0 5-5m-5 5-5-5M5 20h14" />
            </svg>
            Export
          </button>
        </div>
      </aside>
    </>
  );
}

export { ConversationSidebar };
