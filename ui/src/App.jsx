// Llama Manager — browser application shell and router.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Wires the real-time application state into the routed page components and
// renders either the standard shell or kiosk dashboard layout.

import React from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import './App.css';
import { useWebSocket } from './api.js';
import { Sidebar } from './components/Sidebar.jsx';
import { StatsHeader } from './components/StatsHeader.jsx';
import { QueryPanel } from './components/QueryPanel.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ChatPage from './pages/Chat.jsx';
import PresetsPage from './pages/Presets.jsx';
import ModelsPage from './pages/Models.jsx';
import DownloadPage from './pages/Download.jsx';
import LogsPage from './pages/Logs.jsx';
import QueuePage from './pages/Queue.jsx';
import ProcessesPage from './pages/Processes.jsx';
import SettingsPage from './pages/Settings.jsx';
import DocsPage from './pages/Docs.jsx';
import ApiDocsPage from './pages/ApiDocs.jsx';

// Application layout. Renders the normal shell (sidebar + main + chat panel) for
// every route except /kiosk, which renders a bare, full-screen Dashboard for the
// kiosk appliance (no sidebar, no chat, no nav header).
function AppLayout() {
  const { stats, logs, connected, clearLogs, requestLogs, clearRequestLogs, llmLogs, clearLlmLogs, activeRequest, activeRequestsMap } = useWebSocket();
  const location = useLocation();

  // Kiosk view: glanceable, auto-paging Dashboard only.
  if (location.pathname === '/kiosk') {
    return (
      <div className="kiosk-shell">
        {!connected && (
          <div className="connection-banner">
            Reconnecting to server...
          </div>
        )}
        <Dashboard stats={stats} activeRequest={activeRequest} kiosk />
      </div>
    );
  }

  return (
    <div className="app-layout">
      <Sidebar stats={stats} />
      <main className="main-content">
        {!connected && (
          <div className="connection-banner">
            Reconnecting to server...
          </div>
        )}
        <StatsHeader stats={stats} />
        <Routes>
          <Route path="/" element={<Dashboard stats={stats} activeRequest={activeRequest} />} />
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
      </main>
      <QueryPanel stats={stats} />
    </div>
  );
}

// Main App
function App() {
  return (
    <BrowserRouter>
      <AppLayout />
    </BrowserRouter>
  );
}

export default App;
