// Llama Manager — chat-first shell sidebar.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Renders the chat-first layout's single navigation column: header (site
// logo, title, collapse button), "New chat", the shared conversation list,
// a collapsible "Manage" group linking every admin page, and a footer with
// Settings and the live health indicator. Below 1024px it behaves as an
// off-canvas drawer, mirroring `chat/ConversationSidebar.jsx`'s pattern.

import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';

import { useSiteThemeLogo } from '../theme/siteTheme.js';
import { ConversationList } from './chat/ConversationList.jsx';
import {
  createConversation,
  deleteConversation,
  renameConversation,
  selectConversation,
  useConversations,
} from './chat/conversationStore.js';
import {
  ApiDocsIcon,
  DashboardIcon,
  DocsIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LlamaCppIcon,
  LogsIcon,
  ModelsIcon,
  PresetsIcon,
  ProcessesIcon,
  QueueIcon,
  SettingsIcon,
} from './icons.jsx';
import { MANAGE_LINKS } from './manageLinks.js';
import { statusPillLabel } from './statusPillLabel.js';

/** Icon lookup for `MANAGE_LINKS`, keyed by each entry's `key`. */
const MANAGE_ICONS = {
  dashboard: DashboardIcon,
  models: ModelsIcon,
  presets: PresetsIcon,
  download: DownloadIcon,
  logs: LogsIcon,
  queue: QueueIcon,
  processes: ProcessesIcon,
  docs: DocsIcon,
  'api-docs': ApiDocsIcon,
  'llama-cpp': LlamaCppIcon,
};

/** localStorage key remembering whether the Manage group is expanded. */
const MANAGE_OPEN_KEY = 'chatFirstManageOpen';

/** @returns {boolean} The persisted Manage-group open state, defaulting to open. */
function readManageOpen() {
  try {
    return localStorage.getItem(MANAGE_OPEN_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** Persist the Manage-group open state, tolerating unavailable storage. */
function writeManageOpen(open) {
  try {
    localStorage.setItem(MANAGE_OPEN_KEY, String(open));
  } catch {
    /* storage unavailable — preference stays in memory for this session */
  }
}

/**
 * The chat-first shell's sidebar: conversations plus a Manage group for
 * every admin page.
 *
 * @param {object} props
 * @param {object} props.stats - The websocket `stats` payload (health, ports).
 * @param {boolean} props.open - Whether the off-canvas drawer is open (< 1024px).
 * @param {() => void} props.onClose - Called to close the off-canvas drawer.
 */
function ChatSidebar({ stats, open, onClose }) {
  const navigate = useNavigate();
  const { conversations, activeId } = useConversations();
  const [manageOpen, setManageOpen] = useState(readManageOpen);
  const logoSrc = useSiteThemeLogo('/favicon/favicon-32x32.png');
  const { healthy, state } = statusPillLabel(stats);

  const closeOnMobile = () => {
    if (window.innerWidth < 1024) onClose();
  };

  const handleCreate = () => {
    createConversation();
    navigate('/');
    closeOnMobile();
  };

  const handleSelect = (id) => {
    selectConversation(id);
    navigate('/');
    closeOnMobile();
  };

  const toggleManage = () => {
    setManageOpen((current) => {
      const next = !current;
      writeManageOpen(next);
      return next;
    });
  };

  const llamaCppHref = stats?.llamaUiUrl
    || `http://${window.location.hostname}:${stats?.llamaPort || 5251}`;

  return (
    <>
      {open && <button className="chat-first-scrim" onClick={onClose} aria-label="Close sidebar" />}
      <aside className={`chat-first-sidebar ${open ? 'is-open' : ''}`} aria-label="Chat navigation">
        <div className="chat-first-sidebar-header">
          <div className="chat-first-sidebar-title">
            <img src={logoSrc} alt="Llama" className="chat-first-sidebar-logo" />
            <h1>Llama Manager</h1>
          </div>
          <button
            type="button"
            className="chat-icon-btn"
            aria-label="Collapse sidebar"
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m7 7 10 10M17 7 7 17" />
            </svg>
          </button>
        </div>

        <button type="button" className="glass-btn chat-new-button chat-first-new-button" onClick={handleCreate}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New chat
        </button>

        <ConversationList
          activeId={activeId}
          conversations={conversations}
          onDelete={deleteConversation}
          onRename={renameConversation}
          onSelect={handleSelect}
        />

        <div className="chat-first-manage">
          <button
            type="button"
            className="chat-first-manage-toggle"
            aria-expanded={manageOpen}
            onClick={toggleManage}
          >
            <span>Manage</span>
            <svg
              className={`chat-first-manage-chevron ${manageOpen ? 'is-open' : ''}`}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {manageOpen && (
            <div className="chat-first-manage-links">
              {MANAGE_LINKS.map((link) => {
                const Icon = MANAGE_ICONS[link.key];
                if (link.external) {
                  return (
                    <a
                      key={link.key}
                      href={llamaCppHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="nav-item external"
                      aria-label="Open llama.cpp UI in a new tab"
                    >
                      <Icon className="nav-icon" />
                      {link.label}
                      <ExternalLinkIcon className="nav-external-icon" />
                    </a>
                  );
                }
                return (
                  <NavLink
                    key={link.key}
                    to={link.to}
                    className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                    onClick={closeOnMobile}
                  >
                    <Icon className="nav-icon" />
                    {link.label}
                  </NavLink>
                );
              })}
            </div>
          )}
        </div>

        <div className="chat-first-sidebar-footer">
          <NavLink
            to="/settings"
            className={({ isActive }) => `nav-item sidebar-settings glass-btn ${isActive ? 'active' : ''}`}
            onClick={closeOnMobile}
          >
            <SettingsIcon className="nav-icon" />
            Settings
          </NavLink>
          <div className={`status-indicator ${healthy ? 'healthy' : state === 'Starting' ? 'starting' : 'stopped'}`}>
            <span className="status-dot" />
            <span>{state}</span>
          </div>
        </div>
      </aside>
    </>
  );
}

export { ChatSidebar };
