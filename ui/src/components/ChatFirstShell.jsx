// Llama Manager — chat-first application shell.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Renders the ChatGPT-style shell used when the Layout preference is
// "chat-first": one `ChatSidebar` (conversations + Manage group) beside a
// top bar (hamburger, `StatusPill`, and, on the chat route, the active
// conversation's title and message count) and the routed page. Chat is the
// home route; every admin page — including a `/dashboard` alias for the
// Dashboard page — is reachable through the sidebar's Manage group.

import { useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';

import { ChatSidebar } from './ChatSidebar.jsx';
import { QueryPanel } from './QueryPanel.jsx';
import { StatusPill } from './StatusPill.jsx';
import { useConversations } from './chat/conversationStore.js';
import ApiDocsPage from '../pages/ApiDocs.jsx';
import ChatPage from '../pages/Chat.jsx';
import Dashboard from '../pages/Dashboard.jsx';
import DocsPage from '../pages/Docs.jsx';
import DownloadPage from '../pages/Download.jsx';
import LogsPage from '../pages/Logs.jsx';
import ModelsPage from '../pages/Models.jsx';
import PresetsPage from '../pages/Presets.jsx';
import ProcessesPage from '../pages/Processes.jsx';
import QueuePage from '../pages/Queue.jsx';
import SettingsPage from '../pages/Settings.jsx';
import '../styles/chat-sidebar.css';

/**
 * The chat-first application shell: sidebar + top bar + routed page.
 *
 * @param {object} props
 * @param {object} props.stats - The websocket `stats` payload.
 * @param {boolean} props.connected - Whether the websocket is connected.
 * @param {object[]} props.logs - Server log entries, passed through to LogsPage.
 * @param {() => void} props.clearLogs - Clears server logs.
 * @param {object[]} props.requestLogs - Request log entries.
 * @param {() => void} props.clearRequestLogs - Clears request logs.
 * @param {object[]} props.llmLogs - LLM interaction logs.
 * @param {() => void} props.clearLlmLogs - Clears LLM logs.
 * @param {object} props.activeRequest - The in-flight request, if any.
 * @param {object} props.activeRequestsMap - Map of in-flight requests by id.
 */
function ChatFirstShell({
  stats,
  connected,
  logs,
  clearLogs,
  requestLogs,
  clearRequestLogs,
  llmLogs,
  clearLlmLogs,
  activeRequest,
  activeRequestsMap,
}) {
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024);
  const location = useLocation();
  const { active: activeConversation } = useConversations();
  const onChatRoute = location.pathname === '/';

  return (
    <div className="chat-first-shell">
      <ChatSidebar stats={stats} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="chat-first-main">
        <header className="chat-first-topbar">
          <button
            type="button"
            className="chat-icon-btn chat-first-hamburger"
            aria-label="Open sidebar"
            onClick={() => setSidebarOpen(true)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h10" />
            </svg>
          </button>
          <StatusPill stats={stats} />
          {onChatRoute && activeConversation && (
            <div className="chat-first-topbar-title">
              <strong>{activeConversation.title}</strong>
              <span>{activeConversation.messages.length} messages</span>
            </div>
          )}
        </header>
        <div className="chat-first-content">
          {!connected && (
            <div className="connection-banner">
              Reconnecting to server...
            </div>
          )}
          <Routes>
            <Route path="/" element={<ChatPage stats={stats} embedded />} />
            <Route path="/dashboard" element={<Dashboard stats={stats} activeRequest={activeRequest} />} />
            <Route path="/chat" element={<ChatPage stats={stats} />} />
            <Route path="/presets" element={<PresetsPage stats={stats} />} />
            <Route path="/models" element={<ModelsPage stats={stats} />} />
            <Route path="/download" element={<DownloadPage stats={stats} />} />
            <Route path="/logs" element={<LogsPage logs={logs} clearLogs={clearLogs} requestLogs={requestLogs} clearRequestLogs={clearRequestLogs} llmLogs={llmLogs} clearLlmLogs={clearLlmLogs} />} />
            <Route path="/logs/:tab" element={<LogsPage logs={logs} clearLogs={clearLogs} requestLogs={requestLogs} clearRequestLogs={clearRequestLogs} llmLogs={llmLogs} clearLlmLogs={clearLlmLogs} />} />
            <Route path="/queue" element={<QueuePage stats={stats} activeRequestsMap={activeRequestsMap} />} />
            <Route path="/processes" element={<ProcessesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/docs" element={<DocsPage />} />
            <Route path="/api-docs" element={<ApiDocsPage />} />
          </Routes>
        </div>
      </div>
      <QueryPanel stats={stats} />
    </div>
  );
}

export { ChatFirstShell };
