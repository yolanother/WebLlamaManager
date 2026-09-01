// Llama Manager — date-grouped conversation list.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Renders the conversation list grouped by `dateGroup` (Today / Yesterday /
// Previous 7 days / Older) with inline rename and delete controls. Owns only
// its own rename-in-progress UI state; selection, rename persistence, and
// deletion are delegated to the caller so it can be reused by both the chat
// page's `ConversationSidebar` and the chat-first shell's sidebar.

import { useMemo, useState } from 'react';

import { dateGroup } from './conversationStore.js';

/**
 * Date-grouped conversation navigation list with rename and delete.
 *
 * @param {object} props
 * @param {object[]} props.conversations - Conversations to list.
 * @param {string|null} props.activeId - Id of the currently active conversation.
 * @param {(id: string) => void} props.onSelect - Called when a row is clicked.
 * @param {(id: string, title: string) => void} props.onRename - Called with the
 *   trimmed new title when a rename is committed.
 * @param {(id: string) => void} props.onDelete - Called when a row's delete
 *   button is clicked.
 */
function ConversationList({
  conversations,
  activeId,
  onSelect,
  onRename,
  onDelete,
}) {
  const [renamingId, setRenamingId] = useState(null);
  const [draftTitle, setDraftTitle] = useState('');

  const groups = useMemo(() => {
    const result = new Map();
    conversations.forEach((conversation) => {
      const group = dateGroup(conversation.updatedAt || conversation.createdAt);
      if (!result.has(group)) result.set(group, []);
      result.get(group).push(conversation);
    });
    return result;
  }, [conversations]);

  const commitRename = (id) => {
    const title = draftTitle.trim();
    if (title) onRename(id, title);
    setRenamingId(null);
  };

  return (
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
                  onClick={() => onSelect(conversation.id)}
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
  );
}

export { ConversationList };
