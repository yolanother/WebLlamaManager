// Llama Manager — primary sidebar navigation.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Renders application navigation, current service health, and the active
// site-theme logo.

import React from 'react';
import { NavLink } from 'react-router-dom';
import { useSiteThemeLogo } from '../theme/siteTheme.js';
import {
  ApiDocsIcon,
  ChatIcon,
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
import '../styles/sidebar.css';

// Sidebar Navigation
function Sidebar({ stats }) {
  // Healthy when EITHER the llama server is up OR the ds4 engine is active and
  // serving (in ds4-exclusive mode llama is intentionally stopped, so ds4 health
  // is the real signal — otherwise the chat/status would show "not running").
  const isHealthy = stats?.llama?.status === 'ok' || stats?.ds4?.status === 'ok';
  const logoSrc = useSiteThemeLogo('/favicon/favicon-32x32.png');

  return (
    <nav className="sidebar sidebar-glass" aria-label="Primary navigation">
      <div className="sidebar-header">
        <div className="sidebar-title">
          <img src={logoSrc} alt="Llama" className="sidebar-logo" />
          <h1>Llama Manager</h1>
        </div>
        <div className={`status-indicator ${isHealthy ? 'healthy' : stats?.mode ? 'starting' : 'stopped'}`}>
          <span className="status-dot" />
          <span>{isHealthy ? 'Running' : stats?.mode ? 'Starting' : 'Stopped'}</span>
        </div>
        {stats?.engine === 'ds4' && (
          <div className="engine-badge ds4 sidebar-engine" title="DeepSeek V4 active — llama models offloaded to backends">
            DS4 · exclusive
          </div>
        )}
      </div>

      <div className="sidebar-nav">
        <NavLink to="/" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <DashboardIcon className="nav-icon" />
          Dashboard
        </NavLink>
        <NavLink to="/chat" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <ChatIcon className="nav-icon" />
          Chat
        </NavLink>

        <div className="nav-divider" />

        <NavLink to="/models" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <ModelsIcon className="nav-icon" />
          Models
        </NavLink>
        <NavLink to="/presets" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <PresetsIcon className="nav-icon" />
          Presets
        </NavLink>
        <NavLink to="/download" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <DownloadIcon className="nav-icon" />
          Download
        </NavLink>

        <div className="nav-divider" />

        <NavLink to="/logs" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <LogsIcon className="nav-icon" />
          Logs
        </NavLink>
        <NavLink to="/queue" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <QueueIcon className="nav-icon" />
          Queue
        </NavLink>
        <NavLink to="/processes" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <ProcessesIcon className="nav-icon" />
          Processes
        </NavLink>

        <div className="nav-divider" />

        <NavLink to="/docs" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <DocsIcon className="nav-icon" />
          Docs
        </NavLink>
        <NavLink to="/api-docs" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <ApiDocsIcon className="nav-icon" />
          API Docs
        </NavLink>

        <div className="nav-divider" />

        <a
          href={stats?.llamaUiUrl || `http://${window.location.hostname}:${stats?.llamaPort || 5251}`}
          target="_blank"
          rel="noopener noreferrer"
          className="nav-item external"
          aria-label="Open llama.cpp UI in a new tab"
        >
          <LlamaCppIcon className="nav-icon" />
          llama.cpp UI
          <ExternalLinkIcon className="nav-external-icon" />
        </a>
      </div>

      <div className="sidebar-footer">
        <NavLink
          to="/settings"
          className={({ isActive }) => `nav-item sidebar-settings glass-btn ${isActive ? 'active' : ''}`}
        >
          <SettingsIcon className="nav-icon" />
          Settings
        </NavLink>
      </div>
    </nav>
  );
}

export { Sidebar };
