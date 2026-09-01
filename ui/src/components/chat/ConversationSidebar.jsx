// Llama Manager — persisted conversation rail.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Owns the chat page's rail frame (workspace header, New conversation button,
// JSON import/export footer, off-canvas dismissal) around a shared
// `ConversationList`, which renders the date-grouped rows themselves.

import { useRef } from 'react';

import { ConversationList } from './ConversationList.jsx';

/**
 * Collapsible conversation rail: frame + shared date-grouped list.
 *
 * @param {object} props
 * @param {string|null} props.activeId - Id of the currently active conversation.
 * @param {object[]} props.conversations - Conversations to list.
 * @param {boolean} props.open - Whether the off-canvas rail is open (< 1200px).
 * @param {() => void} props.onClose - Called to close the off-canvas rail.
 * @param {() => void} props.onCreate - Called when "New conversation" is clicked.
 * @param {(id: string) => void} props.onDelete - Called to delete a conversation.
 * @param {(file: File) => void} props.onImport - Called with the selected JSON file.
 * @param {(id: string, title: string) => void} props.onRename - Called to rename.
 * @param {(id: string) => void} props.onSelect - Called to select a conversation.
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
  const importRef = useRef(null);

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
        <ConversationList
          activeId={activeId}
          conversations={conversations}
          onDelete={onDelete}
          onRename={onRename}
          onSelect={(id) => {
            onSelect(id);
            if (window.innerWidth < 1200) onClose();
          }}
        />
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
