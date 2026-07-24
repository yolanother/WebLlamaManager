// Llama Manager — process management page.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Displays managed system processes and their resource usage and control
// actions in responsive glass panels.

import React, { useState, useEffect, useCallback } from 'react';
import { API_BASE } from '../api.js';
import '../styles/pages.css';

// Processes Page
function ProcessesPage() {
  const [processes, setProcesses] = useState([]);
  const [llamaPort, setLlamaPort] = useState(null);
  const [loading, setLoading] = useState(true);
  const [killing, setKilling] = useState({});

  const fetchProcesses = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/processes`);
      const data = await res.json();
      setProcesses(data.processes || []);
      setLlamaPort(data.llamaPort);
    } catch (err) {
      console.error('Failed to fetch processes:', err);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchProcesses();
    const interval = setInterval(fetchProcesses, 2000);
    return () => clearInterval(interval);
  }, [fetchProcesses]);

  const killProcess = async (pid) => {
    if (!confirm(`Kill process ${pid}?`)) return;

    setKilling(k => ({ ...k, [pid]: true }));
    try {
      await fetch(`${API_BASE}/processes/${pid}/kill`, { method: 'POST' });
      await fetchProcesses();
    } catch (err) {
      console.error('Failed to kill process:', err);
    }
    setKilling(k => ({ ...k, [pid]: false }));
  };

  const formatMemory = (bytes) => {
    if (!bytes) return '-';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb.toFixed(0)} MB`;
  };

  const mainProcess = processes.find(p => p.port === llamaPort);
  const workerProcesses = processes.filter(p => p.port !== llamaPort);

  return (
    <div className="page processes-page">
      <div className="page-header">
        <h2>Server Processes</h2>
        <button className="btn-secondary glass-btn" onClick={fetchProcesses}>
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="empty-state">
          <p>Loading processes...</p>
        </div>
      ) : processes.length === 0 ? (
        <div className="empty-state">
          <p>No llama-server processes running</p>
          <p className="hint">Start the server from the Dashboard</p>
        </div>
      ) : (
        <>
          {/* Main Router Process */}
          {mainProcess && (
            <section className="page-section glass-panel">
              <h3>Router Process (Port {llamaPort})</h3>
              <div className="process-card main">
                <div className="process-header">
                  <span className="process-pid">PID {mainProcess.pid}</span>
                  <span className="process-badge router">Router</span>
                </div>
                {mainProcess.container && (
                  <div className="process-container">
                    <span className="container-icon">&#x1F4E6;</span>
                    <span className="container-name">{mainProcess.container}</span>
                    <span className="container-id">{mainProcess.containerId}</span>
                  </div>
                )}
                <div className="process-stats">
                  <div className="process-stat">
                    <span className="stat-label">CPU</span>
                    <span className="stat-value">{mainProcess.cpu.toFixed(1)}%</span>
                  </div>
                  <div className="process-stat">
                    <span className="stat-label">Memory</span>
                    <span className="stat-value">{mainProcess.mem.toFixed(1)}%</span>
                  </div>
                  <div className="process-stat">
                    <span className="stat-label">RSS</span>
                    <span className="stat-value">{formatMemory(mainProcess.rss)}</span>
                  </div>
                  <div className="process-stat">
                    <span className="stat-label">Started</span>
                    <span className="stat-value">{mainProcess.startTime}</span>
                  </div>
                </div>
                {mainProcess.model && (
                  <div className="process-model">
                    <span className="model-label">Model:</span>
                    <span className="model-name">{mainProcess.model}</span>
                  </div>
                )}
                <div className="process-command" title={mainProcess.command}>
                  {mainProcess.command}
                </div>
                <div className="process-actions">
                  <button
                    className="btn-danger btn-small glass-btn"
                    onClick={() => killProcess(mainProcess.pid)}
                    disabled={killing[mainProcess.pid]}
                  >
                    {killing[mainProcess.pid] ? 'Killing...' : 'Kill'}
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* Worker Processes */}
          {workerProcesses.length > 0 && (
            <section className="page-section glass-panel">
              <h3>Worker Processes ({workerProcesses.length})</h3>
              <p className="section-hint">Workers handle individual model instances in router mode</p>
              <div className="processes-grid">
                {workerProcesses.map(proc => (
                  <div key={proc.pid} className="process-card worker">
                    <div className="process-header">
                      <span className="process-pid">PID {proc.pid}</span>
                      {proc.port && <span className="process-port">:{proc.port}</span>}
                      <span className="process-badge worker">Worker</span>
                    </div>
                    {proc.container && (
                      <div className="process-container compact">
                        <span className="container-icon">&#x1F4E6;</span>
                        <span className="container-name">{proc.container}</span>
                      </div>
                    )}
                    <div className="process-stats">
                      <div className="process-stat">
                        <span className="stat-label">CPU</span>
                        <span className="stat-value">{proc.cpu.toFixed(1)}%</span>
                      </div>
                      <div className="process-stat">
                        <span className="stat-label">Mem</span>
                        <span className="stat-value">{proc.mem.toFixed(1)}%</span>
                      </div>
                      <div className="process-stat">
                        <span className="stat-label">RSS</span>
                        <span className="stat-value">{formatMemory(proc.rss)}</span>
                      </div>
                    </div>
                    {proc.model && (
                      <div className="process-model">
                        <span className="model-name" title={proc.model}>{proc.model}</span>
                      </div>
                    )}
                    <div className="process-actions">
                      <button
                        className="btn-danger btn-small glass-btn"
                        onClick={() => killProcess(proc.pid)}
                        disabled={killing[proc.pid]}
                      >
                        {killing[proc.pid] ? '...' : 'Kill'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Summary */}
          <section className="page-section glass-panel">
            <h3>Summary</h3>
            <div className="process-summary">
              <div className="summary-item">
                <span className="summary-label">Total Processes</span>
                <span className="summary-value">{processes.length}</span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Total CPU</span>
                <span className="summary-value">
                  {processes.reduce((sum, p) => sum + p.cpu, 0).toFixed(1)}%
                </span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Total Memory</span>
                <span className="summary-value">
                  {formatMemory(processes.reduce((sum, p) => sum + p.rss, 0))}
                </span>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default ProcessesPage;
