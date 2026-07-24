// Llama Manager — primary sidebar navigation.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Renders application navigation, current service health, and the active
// site-theme logo.

import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useSiteThemeLogo } from '../theme/siteTheme.js';

// Sidebar Navigation
function Sidebar({ stats }) {
  const location = useLocation();
  // Healthy when EITHER the llama server is up OR the ds4 engine is active and
  // serving (in ds4-exclusive mode llama is intentionally stopped, so ds4 health
  // is the real signal — otherwise the chat/status would show "not running").
  const isHealthy = stats?.llama?.status === 'ok' || stats?.ds4?.status === 'ok';
  const logoSrc = useSiteThemeLogo('/favicon/favicon-32x32.png');

  return (
    <nav className="sidebar">
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
          <span className="nav-icon">&#x1F4CA;</span>
          Dashboard
        </NavLink>
        <NavLink to="/chat" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">&#x1F4AC;</span>
          Chat
        </NavLink>

        <div className="nav-divider" />

        <NavLink to="/models" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">&#x1F4E6;</span>
          Models
        </NavLink>
        <NavLink to="/presets" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">&#x2728;</span>
          Presets
        </NavLink>
        <NavLink to="/download" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">&#x2B07;</span>
          Download
        </NavLink>

        <div className="nav-divider" />

        <NavLink to="/logs" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">&#x1F4DC;</span>
          Logs
        </NavLink>
        <NavLink to="/queue" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">&#x1F4CB;</span>
          Queue
        </NavLink>
        <NavLink to="/processes" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">&#x1F5A5;</span>
          Processes
        </NavLink>

        <div className="nav-divider" />

        <NavLink to="/docs" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">&#x1F4DA;</span>
          Docs
        </NavLink>
        <NavLink to="/api-docs" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">&#x1F4D6;</span>
          API Docs
        </NavLink>

        <div className="nav-divider" />

        <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">&#x2699;</span>
          Settings
        </NavLink>
      </div>

      <div className="sidebar-footer">
        <a
          href={stats?.llamaUiUrl || `http://${window.location.hostname}:${stats?.llamaPort || 5251}`}
          target="_blank"
          rel="noopener noreferrer"
          className="nav-item external"
        >
          <span className="nav-icon">&#x1F310;</span>
          llama.cpp UI
          <span className="external-icon">↗</span>
        </a>
      </div>
    </nav>
  );
}

export { Sidebar };
