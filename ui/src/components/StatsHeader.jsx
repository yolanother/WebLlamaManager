// Llama Manager — floating glass live statistics header.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Renders a themeable floating glass bar with compact health, resource, and
// active/recent download indicators.

import React, { useState, useEffect, useRef } from 'react';
import { copyTextToClipboard } from '../api.js';
import { ProgressRing, guardSeverity, sensorSeverity, severityColor } from './util.jsx';

// Compact Stats Header
function StatsHeader({ stats }) {
  const [showDownloads, setShowDownloads] = useState(false);
  const [expandedDownload, setExpandedDownload] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const dropdownRef = useRef(null);
  // Healthy when EITHER the llama server is up OR the ds4 engine is active and
  // serving (in ds4-exclusive mode llama is intentionally stopped, so ds4 health
  // is the real signal — otherwise the chat/status would show "not running").
  const isHealthy = stats?.llama?.status === 'ok' || stats?.ds4?.status === 'ok';

  // Get downloads from stats
  const downloads = stats?.downloads ? Object.entries(stats.downloads).map(([id, info]) => ({ id, ...info })) : [];
  const activeDownloads = downloads.filter(d => d.status === 'downloading' || d.status === 'starting');
  const recentDownloads = downloads.filter(d => d.status === 'completed' || d.status === 'failed');
  const hasDownloads = downloads.length > 0;
  const hasErrors = downloads.some(d => d.status === 'failed');

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowDownloads(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const copyToClipboard = async (text, id) => {
    try {
      await copyTextToClipboard(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const clearDownload = async (downloadId) => {
    try {
      await fetch(`/api/downloads/${encodeURIComponent(downloadId)}`, { method: 'DELETE' });
    } catch (err) {
      console.error('Failed to clear download:', err);
    }
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'downloading':
      case 'starting':
        return '⬇️';
      case 'completed':
        return '✓';
      case 'failed':
        return '✗';
      default:
        return '•';
    }
  };

  const getShortName = (id) => {
    // Extract just the repo name from "author/repo:quantization" or "author/repo:filename"
    const parts = id.split(':');
    const repo = parts[0].split('/').pop();
    const quant = parts[1] || '';
    return quant ? `${repo} (${quant})` : repo;
  };

  if (!stats) return null;

  return (
    <div className="stats-header glass-panel glass-panel--floating">
      <div className="stats-header-items">
        <div className="stats-header-item" title="CPU Usage">
          <ProgressRing
            value={stats?.cpu?.usage || 0}
            size={36}
            strokeWidth={4}
            color={stats?.cpu?.usage > 80 ? 'var(--error)' : 'var(--accent)'}
          />
          <span className="stats-header-label">CPU</span>
        </div>

        <div className="stats-header-item" title="Memory Usage">
          <ProgressRing
            value={stats?.memory?.usage || 0}
            size={36}
            strokeWidth={4}
            color={stats?.memory?.usage > 80 ? 'var(--error)' : 'var(--success)'}
          />
          <span className="stats-header-label">RAM</span>
        </div>

        {stats?.gpu && (
          <>
            <div className="stats-header-item" title={stats.gpu.isAPU ? 'GTT Usage' : 'VRAM Usage'}>
              <ProgressRing
                value={stats.gpu.isAPU ? (stats.gpu.gtt?.usage || 0) : (stats.gpu.vram?.usage || 0)}
                size={36}
                strokeWidth={4}
                color="var(--warning)"
              />
              <span className="stats-header-label">{stats.gpu.isAPU ? 'GTT' : 'VRAM'}</span>
            </div>

            <div className="stats-header-item" title="GPU Usage">
              <ProgressRing
                value={stats.gpu.usage || 0}
                size={36}
                strokeWidth={4}
                color="var(--accent)"
              />
              <span className="stats-header-label">GPU</span>
            </div>

            {(stats.guard || stats.gpu.temperature > 0) && (() => {
              // Reflect the guard's whole-box thermal state (hottest sensor),
              // NOT just the GPU reading — otherwise a cool GPU makes this gauge
              // read "fine" while the guard reports Critical from the CPU.
              const guard = stats.guard;
              const sev = guard ? guardSeverity(guard) : sensorSeverity(stats.gpu.temperature, null);
              const displayC = guard?.maxTempC != null ? guard.maxTempC : stats.gpu.temperature;
              const title = guard
                ? `Thermal: ${sev} — ${Math.round(displayC)}°C (gpu ${Math.round(guard.gpuC ?? stats.gpu.temperature)} / cpu ${Math.round(guard.cpuC ?? 0)})`
                : 'GPU Temperature';
              return (
                <div className="stats-header-item temp" title={title}>
                  <span className="stats-header-temp" style={{ color: severityColor(sev) }}>{Math.round(displayC)}°</span>
                  <span className="stats-header-label">Temp</span>
                </div>
              );
            })()}
          </>
        )}

        <div className="stats-header-item" title="Context Usage">
          <ProgressRing
            value={stats?.context?.usage || 0}
            size={36}
            strokeWidth={4}
            color="var(--info)"
          />
          <span className="stats-header-label">Ctx</span>
        </div>
      </div>

      <div className="stats-header-right">
        {/* Downloads indicator */}
        {hasDownloads && (
          <div className="stats-header-downloads" ref={dropdownRef}>
            <button
              className={`downloads-btn glass-btn ${hasErrors ? 'has-errors' : ''} ${activeDownloads.length > 0 ? 'active' : ''}`}
              onClick={() => setShowDownloads(!showDownloads)}
              title={`${activeDownloads.length} active, ${recentDownloads.length} recent downloads`}
            >
              <span className="downloads-icon">⬇️</span>
              {activeDownloads.length > 0 && (
                <span className="downloads-count">{activeDownloads.length}</span>
              )}
              {hasErrors && <span className="downloads-error-dot" />}
            </button>

            {showDownloads && (
              <div className="downloads-dropdown glass-panel glass-panel--floating">
                <div className="downloads-dropdown-header">
                  <span>Downloads</span>
                </div>
                <div className="downloads-list">
                  {downloads.length === 0 ? (
                    <div className="downloads-empty">No downloads</div>
                  ) : (
                    downloads.map(download => (
                      <div key={download.id} className={`download-item ${download.status}`}>
                        <div
                          className="download-item-header"
                          onClick={() => setExpandedDownload(expandedDownload === download.id ? null : download.id)}
                        >
                          <span className={`download-status-icon ${download.status}`}>
                            {getStatusIcon(download.status)}
                          </span>
                          <span className="download-name" title={download.id}>
                            {getShortName(download.id)}
                          </span>
                          {download.status === 'downloading' && (
                            <span className="download-progress">{download.progress}%</span>
                          )}
                          {(download.status === 'completed' || download.status === 'failed') && (
                            <button
                              className="download-clear-btn glass-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                clearDownload(download.id);
                              }}
                              title="Clear"
                            >
                              ×
                            </button>
                          )}
                        </div>

                        {download.status === 'downloading' && (
                          <div className="download-progress-bar">
                            <div
                              className="download-progress-fill"
                              style={{ width: `${download.progress}%` }}
                            />
                          </div>
                        )}

                        {expandedDownload === download.id && (download.error || download.output) && (
                          <div className="download-details">
                            {download.error && (
                              <div className="download-error">
                                <strong>Error:</strong> {download.error}
                              </div>
                            )}
                            {download.output && (
                              <div className="download-output">
                                <div className="download-output-header">
                                  <span>Output</span>
                                  <button
                                    className="download-copy-btn glass-btn"
                                    onClick={() => copyToClipboard(download.output, download.id)}
                                  >
                                    {copiedId === download.id ? 'Copied!' : 'Copy'}
                                  </button>
                                </div>
                                <pre className="download-output-content">{download.output}</pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="stats-header-status">
          <span className={`status-dot-mini ${isHealthy ? 'healthy' : stats?.mode ? 'starting' : 'stopped'}`} />
          <span className="stats-header-mode">
            {isHealthy ? (stats?.mode === 'single' ? 'Single' : 'Router') : (stats?.mode ? 'Starting' : 'Stopped')}
          </span>
        </div>
      </div>
    </div>
  );
}

export { StatsHeader };
