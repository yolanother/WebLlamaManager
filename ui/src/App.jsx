import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import './App.css';

const API_BASE = '/api';

function formatBytes(bytes) {
  if (!bytes) return 'Unknown';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function formatUptime(ms) {
  if (!ms) return '0s';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// WebSocket hook for real-time stats and logs
function useWebSocket() {
  const [stats, setStats] = useState(null);
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const MAX_LOGS = 500;

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.onopen = () => {
        setConnected(true);
        console.log('[ws] Connected');
      };

      wsRef.current.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'stats') {
            setStats(message.data);
          } else if (message.type === 'log') {
            setLogs(prev => {
              const logData = message.data;
              // Check if this is an update to an existing log entry
              if (logData.type === 'update' && logData.id) {
                return prev.map(log =>
                  log.id === logData.id ? { ...log, count: logData.count, timestamp: logData.timestamp } : log
                );
              }
              // New log entry
              const newLogs = [...prev, logData];
              return newLogs.slice(-MAX_LOGS);
            });
          }
        } catch (e) {
          console.error('[ws] Parse error:', e);
        }
      };

      wsRef.current.onclose = () => {
        setConnected(false);
        console.log('[ws] Disconnected, reconnecting...');
        reconnectTimeoutRef.current = setTimeout(connect, 2000);
      };

      wsRef.current.onerror = (error) => {
        console.error('[ws] Error:', error);
      };
    } catch (e) {
      console.error('[ws] Connection failed:', e);
      reconnectTimeoutRef.current = setTimeout(connect, 2000);
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, [connect]);

  const clearLogs = useCallback(() => setLogs([]), []);

  return { stats, logs, connected, clearLogs };
}

// Sidebar Navigation
function Sidebar({ stats }) {
  const location = useLocation();
  const isHealthy = stats?.llama?.status === 'ok';

  return (
    <nav className="sidebar">
      <div className="sidebar-header">
        <h1>Llama Manager</h1>
        <div className={`status-indicator ${isHealthy ? 'healthy' : stats?.mode ? 'starting' : 'stopped'}`}>
          <span className="status-dot" />
          <span>{isHealthy ? 'Running' : stats?.mode ? 'Starting' : 'Stopped'}</span>
        </div>
      </div>

      <div className="sidebar-nav">
        <NavLink to="/" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">&#x1F4CA;</span>
          Dashboard
        </NavLink>
        <NavLink to="/presets" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">&#x2699;</span>
          Presets
        </NavLink>
        <NavLink to="/models" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">&#x1F4E6;</span>
          Models
        </NavLink>
        <NavLink to="/download" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">&#x2B07;</span>
          Download
        </NavLink>
        <NavLink to="/logs" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">&#x1F4DC;</span>
          Logs
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

// Stats Card Component
function StatCard({ label, value, subValue, status, icon }) {
  return (
    <div className={`stat-card ${status || ''}`}>
      {icon && <span className="stat-icon">{icon}</span>}
      <div className="stat-content">
        <span className="stat-value">{value}</span>
        <span className="stat-label">{label}</span>
        {subValue && <span className="stat-sub">{subValue}</span>}
      </div>
    </div>
  );
}

// Progress Ring Component
function ProgressRing({ value, size = 80, strokeWidth = 8, color = 'var(--accent)' }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (value / 100) * circumference;

  return (
    <svg width={size} height={size} className="progress-ring">
      <circle
        className="progress-ring-bg"
        strokeWidth={strokeWidth}
        fill="transparent"
        r={radius}
        cx={size / 2}
        cy={size / 2}
      />
      <circle
        className="progress-ring-fill"
        strokeWidth={strokeWidth}
        fill="transparent"
        r={radius}
        cx={size / 2}
        cy={size / 2}
        style={{
          strokeDasharray: circumference,
          strokeDashoffset: offset,
          stroke: color
        }}
      />
      <text x="50%" y="50%" textAnchor="middle" dy=".3em" className="progress-ring-text">
        {Math.round(value)}%
      </text>
    </svg>
  );
}

// Dashboard Page
function Dashboard({ stats }) {
  const [serverModels, setServerModels] = useState([]);
  const [loading, setLoading] = useState({});

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/models`);
      const data = await res.json();
      setServerModels(data.serverModels || []);
    } catch (err) {
      console.error('Failed to fetch models:', err);
    }
  }, []);

  useEffect(() => {
    fetchModels();
    const interval = setInterval(fetchModels, 10000);
    return () => clearInterval(interval);
  }, [fetchModels]);

  const startServer = async () => {
    setLoading(l => ({ ...l, server: true }));
    try {
      await fetch(`${API_BASE}/server/start`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to start server:', err);
    }
    setLoading(l => ({ ...l, server: false }));
  };

  const stopServer = async () => {
    setLoading(l => ({ ...l, server: true }));
    try {
      await fetch(`${API_BASE}/server/stop`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to stop server:', err);
    }
    setLoading(l => ({ ...l, server: false }));
  };

  const isHealthy = stats?.llama?.status === 'ok';
  const isSingleMode = stats?.mode === 'single';
  const llamaPort = stats?.llamaPort || 5251;
  const llamaUiUrl = stats?.llamaUiUrl || `http://${window.location.hostname}:${llamaPort}`;

  return (
    <div className="page dashboard">
      <div className="page-header">
        <h2>Dashboard</h2>
        <div className="header-actions">
          {isHealthy ? (
            <button className="btn-danger" onClick={stopServer} disabled={loading.server}>
              {loading.server ? 'Stopping...' : 'Stop Server'}
            </button>
          ) : (
            <button className="btn-primary" onClick={startServer} disabled={loading.server}>
              {loading.server ? 'Starting...' : 'Start Server'}
            </button>
          )}
        </div>
      </div>

      {/* Server Status */}
      <section className="dashboard-section">
        <h3>Server Status</h3>
        <div className="status-grid">
          <StatCard
            label="Status"
            value={isHealthy ? 'Running' : stats?.mode ? 'Starting' : 'Stopped'}
            status={isHealthy ? 'success' : stats?.mode ? 'warning' : 'error'}
            icon="&#x1F7E2;"
          />
          <StatCard
            label="Mode"
            value={isSingleMode ? 'Single Model' : 'Router (Multi)'}
            subValue={stats?.preset?.name || null}
            icon="&#x1F3AF;"
          />
          <StatCard
            label="Loaded Models"
            value={serverModels.length}
            icon="&#x1F4E6;"
          />
          <div className="stat-card link-card">
            <a
              href={llamaUiUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="stat-icon">&#x1F310;</span>
              <div className="stat-content">
                <span className="stat-value">Open llama.cpp</span>
                <span className="stat-label">{stats?.llamaUiUrl ? 'External' : `Port ${llamaPort}`}</span>
              </div>
              <span className="link-arrow">↗</span>
            </a>
          </div>
        </div>
      </section>

      {/* System Resources */}
      <section className="dashboard-section">
        <h3>System Resources</h3>
        <div className="resources-grid">
          <div className="resource-card">
            <ProgressRing
              value={stats?.cpu?.usage || 0}
              color={stats?.cpu?.usage > 80 ? 'var(--error)' : 'var(--accent)'}
            />
            <div className="resource-info">
              <span className="resource-label">CPU Usage</span>
              <span className="resource-detail">{stats?.cpu?.cores || 0} cores</span>
              <span className="resource-detail">Load: {stats?.cpu?.loadAvg?.[0]?.toFixed(2) || '0.00'}</span>
            </div>
          </div>

          <div className="resource-card">
            <ProgressRing
              value={stats?.memory?.usage || 0}
              color={stats?.memory?.usage > 80 ? 'var(--error)' : 'var(--success)'}
            />
            <div className="resource-info">
              <span className="resource-label">Memory</span>
              <span className="resource-detail">
                {formatBytes(stats?.memory?.used)} / {formatBytes(stats?.memory?.total)}
              </span>
            </div>
          </div>

          <div className="resource-card">
            <ProgressRing
              value={stats?.gpu?.vram?.usage || (stats?.gpu?.vram?.used / stats?.gpu?.vram?.total * 100) || 0}
              color="var(--warning)"
            />
            <div className="resource-info">
              <span className="resource-label">VRAM</span>
              {stats?.gpu ? (
                <>
                  <span className="resource-detail">
                    {formatBytes(stats.gpu.vram?.used)} / {formatBytes(stats.gpu.vram?.total)}
                  </span>
                  <span className="resource-detail">Temp: {stats.gpu.temperature}°C</span>
                </>
              ) : (
                <span className="resource-detail">Not available</span>
              )}
            </div>
          </div>

          {stats?.gpu && (
            <div className="resource-card">
              <ProgressRing
                value={stats.gpu.usage || 0}
                color="var(--accent)"
              />
              <div className="resource-info">
                <span className="resource-label">GPU Usage</span>
                <span className="resource-detail">{stats.gpu.usage?.toFixed(1) || 0}%</span>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Active Models */}
      {serverModels.length > 0 && (
        <section className="dashboard-section">
          <h3>Active Models</h3>
          <div className="models-list">
            {serverModels.map((model) => (
              <div key={model.id} className="model-list-item">
                <span className="model-name">{model.id}</span>
                <span className="model-status loaded">Loaded</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Downloads */}
      {stats?.downloads && Object.keys(stats.downloads).length > 0 && (
        <section className="dashboard-section">
          <h3>Active Downloads</h3>
          <div className="downloads-list">
            {Object.entries(stats.downloads).map(([id, info]) => (
              <div key={id} className={`download-item ${info.status}`}>
                <div className="download-info">
                  <span className="download-name">{id}</span>
                  <span className="download-status-text">
                    {info.status === 'completed' ? 'Complete' :
                     info.status === 'failed' ? `Failed: ${info.error}` :
                     info.status === 'starting' ? 'Starting...' : 'Downloading...'}
                  </span>
                </div>
                <div className="download-progress">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${info.progress}%` }} />
                  </div>
                  <span className="download-percent">{info.progress}%</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// Presets Page
function PresetsPage({ stats }) {
  const [presets, setPresets] = useState([]);
  const [loading, setLoading] = useState({});

  const fetchPresets = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/presets`);
      const data = await res.json();
      setPresets(data.presets || []);
    } catch (err) {
      console.error('Failed to fetch presets:', err);
    }
  }, []);

  useEffect(() => {
    fetchPresets();
  }, [fetchPresets]);

  const activatePreset = async (presetId) => {
    setLoading(l => ({ ...l, [presetId]: true }));
    try {
      await fetch(`${API_BASE}/presets/${presetId}/activate`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to activate preset:', err);
    }
    setLoading(l => ({ ...l, [presetId]: false }));
  };

  const switchToRouterMode = async () => {
    setLoading(l => ({ ...l, router: true }));
    try {
      await fetch(`${API_BASE}/server/start`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to switch to router mode:', err);
    }
    setLoading(l => ({ ...l, router: false }));
  };

  const isSingleMode = stats?.mode === 'single';
  const activePreset = stats?.preset;
  const isHealthy = stats?.llama?.status === 'ok';

  return (
    <div className="page">
      <div className="page-header">
        <h2>Optimized Presets</h2>
        {isSingleMode && (
          <span className="mode-badge single">Single Model Mode</span>
        )}
      </div>

      <p className="page-description">
        Pre-configured models with optimized settings. Activating a preset runs the server in single-model mode with specific parameters.
      </p>

      <div className="presets-grid">
        {presets.map((preset) => {
          const isActive = activePreset?.id === preset.id;
          const isLoading = loading[preset.id];
          const isStarting = isActive && !isHealthy;

          return (
            <div key={preset.id} className={`preset-card ${isActive ? 'active' : ''} ${isLoading ? 'loading' : ''}`}>
              <div className="preset-header">
                <h3>{preset.name}</h3>
                {isActive && isHealthy && <span className="badge success">Active</span>}
                {isStarting && <span className="badge warning">Starting...</span>}
              </div>

              <p className="preset-description">{preset.description}</p>

              <div className="preset-details">
                <div className="detail-row">
                  <span className="detail-label">Repository</span>
                  <span className="detail-value">{preset.repo}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Quantization</span>
                  <span className="detail-value quant">{preset.quantization}</span>
                </div>
                {preset.context > 0 && (
                  <div className="detail-row">
                    <span className="detail-label">Context</span>
                    <span className="detail-value">{preset.context.toLocaleString()}</span>
                  </div>
                )}
              </div>

              {(isLoading || isStarting) && (
                <div className="preset-loading">
                  <div className="loading-spinner" />
                  <span>{isLoading ? 'Activating...' : 'Starting server...'}</span>
                </div>
              )}

              <div className="preset-actions">
                {isActive ? (
                  <button
                    className="btn-secondary full-width"
                    onClick={switchToRouterMode}
                    disabled={loading.router || isStarting}
                  >
                    {loading.router ? 'Switching...' : 'Switch to Router Mode'}
                  </button>
                ) : (
                  <button
                    className="btn-primary full-width"
                    onClick={() => activatePreset(preset.id)}
                    disabled={isLoading}
                  >
                    {isLoading ? 'Activating...' : 'Activate'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Models Page
function ModelsPage({ stats }) {
  const [serverModels, setServerModels] = useState([]);
  const [localModels, setLocalModels] = useState([]);
  const [modelsDir, setModelsDir] = useState('');
  const [loading, setLoading] = useState({});

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/models`);
      const data = await res.json();
      setServerModels(data.serverModels || []);
      setLocalModels(data.localModels || []);
      setModelsDir(data.modelsDir || '');
    } catch (err) {
      console.error('Failed to fetch models:', err);
    }
  }, []);

  useEffect(() => {
    fetchModels();
    const interval = setInterval(fetchModels, 10000);
    return () => clearInterval(interval);
  }, [fetchModels]);

  const loadModel = async (modelName) => {
    setLoading(l => ({ ...l, [modelName]: true }));
    try {
      await fetch(`${API_BASE}/models/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName })
      });
      await fetchModels();
    } catch (err) {
      console.error('Failed to load model:', err);
    }
    setLoading(l => ({ ...l, [modelName]: false }));
  };

  const unloadModel = async (modelName) => {
    setLoading(l => ({ ...l, [modelName]: true }));
    try {
      await fetch(`${API_BASE}/models/unload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName })
      });
      await fetchModels();
    } catch (err) {
      console.error('Failed to unload model:', err);
    }
    setLoading(l => ({ ...l, [modelName]: false }));
  };

  const getModelStatus = (modelName) => {
    return serverModels.some(m =>
      m.id === modelName || m.model === modelName || (m.id && m.id.includes(modelName))
    ) ? 'loaded' : 'unloaded';
  };

  const isHealthy = stats?.llama?.status === 'ok';
  const isSingleMode = stats?.mode === 'single';

  if (isSingleMode) {
    return (
      <div className="page">
        <div className="page-header">
          <h2>Models</h2>
        </div>
        <div className="empty-state">
          <p>Model management is disabled in single-model mode.</p>
          <p className="hint">Switch to router mode from the Presets page to manage multiple models.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>Models</h2>
        <span className="models-dir">{modelsDir}</span>
      </div>

      {/* Loaded Models */}
      {serverModels.length > 0 && (
        <section className="page-section">
          <h3>Loaded Models</h3>
          <div className="models-grid">
            {serverModels.map((model) => (
              <div key={model.id} className="model-card active">
                <div className="model-header">
                  <h4>{model.id}</h4>
                  <span className="badge success">Loaded</span>
                </div>
                <div className="model-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => unloadModel(model.id)}
                    disabled={loading[model.id]}
                  >
                    {loading[model.id] ? 'Unloading...' : 'Unload'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Local Models */}
      <section className="page-section">
        <h3>Local Models</h3>
        {localModels.length === 0 ? (
          <div className="empty-state">
            <p>No models found in {modelsDir}</p>
            <p className="hint">Download models from the Download page</p>
          </div>
        ) : (
          <div className="models-grid">
            {localModels.map((model) => {
              const status = getModelStatus(model.name);
              const isLoaded = status === 'loaded';
              return (
                <div key={model.path} className={`model-card ${isLoaded ? 'active' : ''}`}>
                  <div className="model-header">
                    <h4 title={model.path}>{model.name}</h4>
                    {isLoaded && <span className="badge success">Loaded</span>}
                  </div>
                  <div className="model-info">
                    <span>{formatBytes(model.size)}</span>
                  </div>
                  <div className="model-actions">
                    {isLoaded ? (
                      <button
                        className="btn-secondary"
                        onClick={() => unloadModel(model.name)}
                        disabled={loading[model.name] || !isHealthy}
                      >
                        {loading[model.name] ? 'Unloading...' : 'Unload'}
                      </button>
                    ) : (
                      <button
                        className="btn-primary"
                        onClick={() => loadModel(model.name)}
                        disabled={loading[model.name] || !isHealthy}
                      >
                        {loading[model.name] ? 'Loading...' : 'Load'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// Download Page
function DownloadPage({ stats }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [repoQuantizations, setRepoQuantizations] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(false);

  const searchModels = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSelectedRepo(null);
    setRepoQuantizations([]);
    try {
      const res = await fetch(`${API_BASE}/search?query=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch (err) {
      console.error('Failed to search:', err);
    }
    setSearching(false);
  };

  const selectRepo = async (repo) => {
    setSelectedRepo(repo);
    setLoadingFiles(true);
    try {
      const [author, model] = repo.id.split('/');
      const res = await fetch(`${API_BASE}/repo/${author}/${model}/files`);
      const data = await res.json();
      setRepoQuantizations(data.quantizations || []);
    } catch (err) {
      console.error('Failed to fetch repo files:', err);
      setRepoQuantizations([]);
    }
    setLoadingFiles(false);
  };

  const downloadModel = async (repo, quantization) => {
    try {
      await fetch(`${API_BASE}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, quantization })
      });
    } catch (err) {
      console.error('Failed to start download:', err);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>Download Models</h2>
      </div>

      <div className="search-section">
        <div className="search-bar">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search HuggingFace for GGUF models..."
            onKeyDown={(e) => e.key === 'Enter' && searchModels()}
          />
          <button className="btn-primary" onClick={searchModels} disabled={searching}>
            {searching ? 'Searching...' : 'Search'}
          </button>
        </div>
      </div>

      {/* Active Downloads */}
      {stats?.downloads && Object.keys(stats.downloads).length > 0 && (
        <section className="page-section">
          <h3>Active Downloads</h3>
          <div className="downloads-list">
            {Object.entries(stats.downloads).map(([id, info]) => (
              <div key={id} className={`download-item ${info.status}`}>
                <div className="download-info">
                  <span className="download-name">{id}</span>
                  <span className="download-status-text">
                    {info.status === 'completed' ? 'Complete' :
                     info.status === 'failed' ? `Failed: ${info.error}` :
                     info.status === 'starting' ? 'Starting...' : 'Downloading...'}
                  </span>
                </div>
                <div className="download-progress">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${info.progress}%` }} />
                  </div>
                  <span className="download-percent">{info.progress}%</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Search Results */}
      {searchResults.length > 0 && !selectedRepo && (
        <section className="page-section">
          <h3>Search Results</h3>
          <div className="search-results">
            {searchResults.map((result) => (
              <div key={result.id} className="search-result" onClick={() => selectRepo(result)}>
                <div className="result-info">
                  <h4>{result.id}</h4>
                  <p>{result.downloads?.toLocaleString()} downloads</p>
                </div>
                <span className="arrow">→</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Selected Repo */}
      {selectedRepo && (
        <section className="page-section">
          <div className="repo-header">
            <button className="btn-ghost" onClick={() => setSelectedRepo(null)}>
              ← Back
            </button>
            <h3>{selectedRepo.id}</h3>
          </div>

          {loadingFiles ? (
            <p>Loading available quantizations...</p>
          ) : repoQuantizations.length === 0 ? (
            <p>No GGUF files found in this repository</p>
          ) : (
            <div className="quant-list">
              {repoQuantizations.map((quant) => (
                <div key={quant.quantization} className="quant-item">
                  <div className="quant-info">
                    <span className="quant-badge">{quant.quantization}</span>
                    <span className="quant-size">
                      {formatBytes(quant.totalSize)}
                      {quant.isSplit && ` (${quant.files.length} parts)`}
                    </span>
                  </div>
                  <button
                    className="btn-primary"
                    onClick={() => downloadModel(selectedRepo.id, quant.quantization)}
                  >
                    Download
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// Logs Page
function LogsPage({ logs, clearLogs }) {
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const logsEndRef = useRef(null);
  const logsContainerRef = useRef(null);

  // Fetch initial logs on mount
  useEffect(() => {
    const fetchInitialLogs = async () => {
      try {
        const res = await fetch(`${API_BASE}/logs?limit=500`);
        const data = await res.json();
        // Logs from API are added via the parent's setLogs if needed
        // For now, we rely on WebSocket for real-time logs
      } catch (err) {
        console.error('Failed to fetch logs:', err);
      }
    };
    fetchInitialLogs();
  }, []);

  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    if (!logsContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logsContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(isAtBottom);
  };

  const filteredLogs = filter
    ? logs.filter(log =>
        log.message.toLowerCase().includes(filter.toLowerCase()) ||
        log.source.toLowerCase().includes(filter.toLowerCase())
      )
    : logs;

  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour12: false });
  };

  return (
    <div className="page logs-page">
      <div className="page-header">
        <h2>Server Logs</h2>
        <div className="logs-actions">
          <input
            type="text"
            placeholder="Filter logs..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="logs-filter"
          />
          <button className="btn-secondary" onClick={clearLogs}>
            Clear
          </button>
          <label className="auto-scroll-toggle">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
        </div>
      </div>

      <div
        className="logs-container"
        ref={logsContainerRef}
        onScroll={handleScroll}
      >
        {filteredLogs.length === 0 ? (
          <div className="logs-empty">
            <p>No logs yet</p>
            <p className="hint">Logs will appear here when the server outputs messages</p>
          </div>
        ) : (
          <div className="logs-list">
            {filteredLogs.map((log, i) => (
              <div key={log.id || i} className={`log-entry ${log.source}`}>
                <span className="log-time">{formatTime(log.timestamp)}</span>
                <span className={`log-source ${log.source}`}>{log.source}</span>
                <span className="log-message">{log.message}</span>
                {log.count > 1 && <span className="log-count">×{log.count}</span>}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>
    </div>
  );
}

// Query Panel Component
function QueryPanel({ stats }) {
  const [isOpen, setIsOpen] = useState(false);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState(() => {
    return localStorage.getItem('lastSelectedModel') || '';
  });
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState('');
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  // Compute base URL for llama.cpp API
  const llamaBaseUrl = stats?.llamaUiUrl || `http://${window.location.hostname}:${stats?.llamaPort || 5251}`;

  // Fetch available models
  const fetchModels = useCallback(async () => {
    try {
      const response = await fetch(`${llamaBaseUrl}/models`);
      if (response.ok) {
        const data = await response.json();
        const modelList = data.data || data || [];
        setModels(modelList);

        // Auto-select first model if none selected
        if (!selectedModel && modelList.length > 0) {
          const firstModel = modelList[0].id || modelList[0].model;
          setSelectedModel(firstModel);
          localStorage.setItem('lastSelectedModel', firstModel);
        }
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
    }
  }, [llamaBaseUrl, selectedModel]);

  useEffect(() => {
    if (isOpen) {
      fetchModels();
    }
  }, [isOpen, fetchModels]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingMessage]);

  const handleModelChange = (e) => {
    const model = e.target.value;
    setSelectedModel(model);
    localStorage.setItem('lastSelectedModel', model);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!prompt.trim() || isLoading) return;

    const userMessage = { role: 'user', content: prompt.trim() };
    setMessages(prev => [...prev, userMessage]);
    setPrompt('');
    setIsLoading(true);
    setStreamingMessage('');

    try {
      const response = await fetch(`${llamaBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: [...messages, userMessage],
          stream: true
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content || '';
              fullContent += content;
              setStreamingMessage(fullContent);
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }

      setMessages(prev => [...prev, { role: 'assistant', content: fullContent }]);
      setStreamingMessage('');
    } catch (err) {
      console.error('Query failed:', err);
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }]);
    }

    setIsLoading(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const clearChat = () => {
    setMessages([]);
    setStreamingMessage('');
  };

  const isHealthy = stats?.llama?.status === 'ok';

  return (
    <div className={`query-panel ${isOpen ? 'open' : ''}`}>
      <button
        className={`query-fab ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title={isOpen ? 'Close chat' : 'Test query'}
      >
        <span className="fab-icon">{isOpen ? '✕' : '💬'}</span>
      </button>

      <div className="query-container">
        <div className="query-header">
          <h3>Query Panel</h3>
          <div className="query-controls">
            <select
              value={selectedModel}
              onChange={handleModelChange}
              disabled={!isHealthy || models.length === 0}
            >
              {models.length === 0 ? (
                <option value="">No models available</option>
              ) : (
                models.map((model) => (
                  <option key={model.id || model.model} value={model.id || model.model}>
                    {model.id || model.model}
                  </option>
                ))
              )}
            </select>
            <button className="btn-ghost btn-small" onClick={clearChat} title="Clear chat">
              🗑️
            </button>
          </div>
        </div>

        <div className="query-messages">
          {messages.length === 0 && !streamingMessage && (
            <div className="query-empty">
              <p>Send a message to test the model</p>
              {!isHealthy && <p className="hint">Server is not running</p>}
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`query-message ${msg.role}`}>
              <span className="message-role">{msg.role === 'user' ? 'You' : 'AI'}</span>
              <div className="message-content">{msg.content}</div>
            </div>
          ))}
          {streamingMessage && (
            <div className="query-message assistant streaming">
              <span className="message-role">AI</span>
              <div className="message-content">{streamingMessage}</div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <form className="query-input" onSubmit={handleSubmit}>
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isHealthy ? "Type a message... (Enter to send)" : "Server not running"}
            disabled={!isHealthy || isLoading}
            rows={1}
          />
          <button
            type="submit"
            className="btn-primary"
            disabled={!isHealthy || isLoading || !prompt.trim()}
          >
            {isLoading ? '...' : '→'}
          </button>
        </form>
      </div>
    </div>
  );
}

// Main App
function App() {
  const { stats, logs, connected, clearLogs } = useWebSocket();

  return (
    <BrowserRouter>
      <div className="app-layout">
        <Sidebar stats={stats} />
        <main className="main-content">
          {!connected && (
            <div className="connection-banner">
              Reconnecting to server...
            </div>
          )}
          <Routes>
            <Route path="/" element={<Dashboard stats={stats} />} />
            <Route path="/presets" element={<PresetsPage stats={stats} />} />
            <Route path="/models" element={<ModelsPage stats={stats} />} />
            <Route path="/download" element={<DownloadPage stats={stats} />} />
            <Route path="/logs" element={<LogsPage logs={logs} clearLogs={clearLogs} />} />
          </Routes>
        </main>
        <QueryPanel stats={stats} />
      </div>
    </BrowserRouter>
  );
}

export default App;
