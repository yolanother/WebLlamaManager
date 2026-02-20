import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, AreaChart,
  BarChart, Bar
} from 'recharts';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
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

// Format model name for display: remove .gguf extension and split part numbers
function formatModelName(model) {
  const name = model.alias || model.displayName || model.id || model.model || '';
  return name
    .replace(/-\d{5}-of-\d{5}\.gguf$/i, '')  // Remove part suffix like -00001-of-00002.gguf
    .replace(/\.gguf$/i, '');                 // Remove .gguf extension
}

// Clipboard utility with fallback for non-secure contexts (HTTP)
async function copyTextToClipboard(text) {
  // Try modern Clipboard API first (requires HTTPS or localhost)
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (e) {
      // If Clipboard API fails (e.g., permissions, missing user gesture), fall back below
    }
  }
  
  // Fallback for HTTP or older browsers using execCommand
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    const success = document.execCommand('copy');
    if (!success) {
      throw new Error('Copy command failed');
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

// Code block component with syntax highlighting and copy button
function CodeBlock({ code, language }) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef(null);

  useEffect(() => {
    if (codeRef.current && language) {
      // Reset any previous highlighting
      codeRef.current.removeAttribute('data-highlighted');
      try {
        hljs.highlightElement(codeRef.current);
      } catch (e) {
        // Language not supported, fall back to plain text
      }
    }
  }, [code, language]);

  const handleCopy = async () => {
    try {
      await copyTextToClipboard(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleOpenHtml = () => {
    const blob = new Blob([code], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    // Clean up the blob URL after a delay
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const isHtml = language?.toLowerCase() === 'html';

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-language">{language || 'text'}</span>
        <div className="code-block-actions">
          {isHtml && (
            <button className="code-block-open" onClick={handleOpenHtml} title="Open HTML in new tab">
              Open
            </button>
          )}
          <button className="code-block-copy" onClick={handleCopy} title="Copy code">
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <pre>
        <code ref={codeRef} className={language ? `language-${language}` : ''}>
          {code}
        </code>
      </pre>
    </div>
  );
}

// Parse message content and render code blocks with syntax highlighting
function parseMessageWithCodeBlocks(content) {
  if (typeof content !== 'string') return content;

  // Regex to match complete code blocks: ```language\ncode\n```
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Add text before the code block
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index);
      parts.push(<span key={key++}>{textBefore}</span>);
    }

    // Add the code block
    const language = match[1] || '';
    const code = match[2].trim();
    parts.push(<CodeBlock key={key++} code={code} language={language} />);

    lastIndex = match.index + match[0].length;
  }

  // Check for unclosed code block at the end (streaming)
  const remaining = content.slice(lastIndex);
  const unclosedMatch = remaining.match(/```(\w*)\n?([\s\S]*)$/);

  if (unclosedMatch) {
    // Add text before the unclosed code block
    const textBefore = remaining.slice(0, unclosedMatch.index);
    if (textBefore) {
      parts.push(<span key={key++}>{textBefore}</span>);
    }
    // Add the unclosed code block (still being streamed)
    const language = unclosedMatch[1] || '';
    const code = unclosedMatch[2] || '';
    parts.push(<CodeBlock key={key++} code={code} language={language} />);
  } else if (remaining) {
    // Add any remaining text after the last code block
    parts.push(<span key={key++}>{remaining}</span>);
  }

  return parts.length > 0 ? parts : content;
}

// Searchable select component for model dropdowns
function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  disabled = false,
  storageKey = null,
  formatOption = (opt) => opt.label || opt.id || opt.value || opt
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  // Load from localStorage on mount if storageKey provided
  useEffect(() => {
    if (storageKey && !value) {
      const saved = localStorage.getItem(storageKey);
      if (saved && options.some(opt => (opt.value || opt.id || opt) === saved)) {
        onChange(saved);
      }
    }
  }, [storageKey, options]);

  // Save to localStorage when value changes
  useEffect(() => {
    if (storageKey && value) {
      localStorage.setItem(storageKey, value);
    }
  }, [storageKey, value]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Filter options based on search
  const filteredOptions = options.filter(opt => {
    const label = formatOption(opt).toLowerCase();
    const val = (opt.value || opt.id || opt).toString().toLowerCase();
    const searchLower = search.toLowerCase();
    return label.includes(searchLower) || val.includes(searchLower);
  });

  // Get display value
  const selectedOption = options.find(opt => (opt.value || opt.id || opt) === value);
  const displayValue = selectedOption ? formatOption(selectedOption) : placeholder;

  const handleSelect = (opt) => {
    const val = opt.value || opt.id || opt;
    onChange(val);
    setIsOpen(false);
    setSearch('');
  };

  return (
    <div className={`searchable-select ${disabled ? 'disabled' : ''}`} ref={containerRef}>
      <div
        className={`searchable-select-trigger ${isOpen ? 'open' : ''}`}
        onClick={() => {
          if (!disabled) {
            setIsOpen(!isOpen);
            if (!isOpen) setTimeout(() => inputRef.current?.focus(), 0);
          }
        }}
        title={value ? displayValue : ''}
      >
        <span className={value ? '' : 'placeholder'}>{displayValue}</span>
        <span className="searchable-select-arrow">▼</span>
      </div>
      {isOpen && (
        <div className="searchable-select-dropdown">
          <input
            ref={inputRef}
            type="text"
            className="searchable-select-search"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClick={(e) => e.stopPropagation()}
          />
          <div className="searchable-select-options">
            {filteredOptions.length === 0 ? (
              <div className="searchable-select-no-results">No matches found</div>
            ) : (
              filteredOptions.map((opt, idx) => {
                const val = opt.value || opt.id || opt;
                const label = formatOption(opt);
                return (
                  <div
                    key={val || idx}
                    className={`searchable-select-option ${val === value ? 'selected' : ''}`}
                    onClick={() => handleSelect(opt)}
                    title={label}
                  >
                    {label}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// WebSocket hook for real-time stats and logs
function useWebSocket() {
  const [stats, setStats] = useState(null);
  const [logs, setLogs] = useState([]);
  const [requestLogs, setRequestLogs] = useState([]);
  const [llmLogs, setLlmLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const MAX_LOGS = 500;
  const MAX_REQUEST_LOGS = 200;
  const MAX_LLM_LOGS = 50;

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
          } else if (message.type === 'requestLog') {
            setRequestLogs(prev => {
              const newLogs = [...prev, message.data];
              return newLogs.slice(-MAX_REQUEST_LOGS);
            });
          } else if (message.type === 'llmLog') {
            setLlmLogs(prev => {
              const newLogs = [...prev, message.data];
              return newLogs.slice(-MAX_LLM_LOGS);
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
  const clearRequestLogs = useCallback(() => setRequestLogs([]), []);
  const clearLlmLogs = useCallback(() => setLlmLogs([]), []);

  return { stats, logs, connected, clearLogs, requestLogs, clearRequestLogs, llmLogs, clearLlmLogs };
}

// Sidebar Navigation
function Sidebar({ stats }) {
  const location = useLocation();
  const isHealthy = stats?.llama?.status === 'ok';

  return (
    <nav className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-title">
          <img src="/favicon/favicon-32x32.png" alt="Llama" className="sidebar-logo" />
          <h1>Llama Manager</h1>
        </div>
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

// Color definitions for charts
const CHART_COLORS = {
  temperature: '#ef4444',
  temperatureCpu: '#f59e0b',
  power: '#f59e0b',
  memory: '#22c55e',
  memorySecondary: '#8b5cf6',
  tokens: '#3b82f6',
  requestOk: '#22c55e',
  requestErr: '#ef4444'
};

// Custom tooltip for charts
function ChartTooltip({ active, payload, label, unit = '' }) {
  if (!active || !payload || !payload.length) return null;

  const formatTime = (ts) => {
    const date = new Date(ts);
    return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-time">{formatTime(label)}</div>
      {payload.map((entry, i) => (
        <div key={i} className="chart-tooltip-row">
          <span className="chart-tooltip-dot" style={{ background: entry.color }} />
          <span className="chart-tooltip-label">{entry.name}:</span>
          <span className="chart-tooltip-value">{entry.value?.toFixed(1)}{unit}</span>
        </div>
      ))}
    </div>
  );
}

// Temperature Chart Component
function TemperatureChart({ data, height = 140 }) {
  if (!data || data.length < 2) {
    return (
      <div className="chart-container" style={{ height }}>
        <div className="chart-empty">Collecting data...</div>
      </div>
    );
  }

  return (
    <div className="chart-container" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
          <defs>
            <linearGradient id="gradGpu" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLORS.temperature} stopOpacity={0.3} />
              <stop offset="95%" stopColor={CHART_COLORS.temperature} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradCpu" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLORS.temperatureCpu} stopOpacity={0.2} />
              <stop offset="95%" stopColor={CHART_COLORS.temperatureCpu} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
          <XAxis dataKey="timestamp" hide />
          <YAxis domain={[0, 100]} tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTooltip unit="°C" />} />
          <Area type="monotone" dataKey="gpu" name="GPU" stroke={CHART_COLORS.temperature} fill="url(#gradGpu)" strokeWidth={2} dot={false} />
          <Area type="monotone" dataKey="cpu" name="CPU" stroke={CHART_COLORS.temperatureCpu} fill="url(#gradCpu)" strokeWidth={2} dot={false} strokeDasharray="4 2" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// Power Chart Component
function PowerChart({ data, height = 140 }) {
  if (!data || data.length < 2) {
    return (
      <div className="chart-container" style={{ height }}>
        <div className="chart-empty">Collecting data...</div>
      </div>
    );
  }

  const maxPower = Math.max(...data.map(d => d.watts || 0), 50);

  return (
    <div className="chart-container" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
          <defs>
            <linearGradient id="gradPower" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLORS.power} stopOpacity={0.3} />
              <stop offset="95%" stopColor={CHART_COLORS.power} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
          <XAxis dataKey="timestamp" hide />
          <YAxis domain={[0, Math.ceil(maxPower / 10) * 10]} tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTooltip unit="W" />} />
          <Area type="monotone" dataKey="watts" name="Power" stroke={CHART_COLORS.power} fill="url(#gradPower)" strokeWidth={2} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// Memory Chart Component
function MemoryChart({ data, primaryKey = 'vram', height = 140 }) {
  if (!data || data.length < 2) {
    return (
      <div className="chart-container" style={{ height }}>
        <div className="chart-empty">Collecting data...</div>
      </div>
    );
  }

  return (
    <div className="chart-container" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
          <defs>
            <linearGradient id="gradMem" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLORS.memory} stopOpacity={0.3} />
              <stop offset="95%" stopColor={CHART_COLORS.memory} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradSys" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLORS.memorySecondary} stopOpacity={0.2} />
              <stop offset="95%" stopColor={CHART_COLORS.memorySecondary} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
          <XAxis dataKey="timestamp" hide />
          <YAxis domain={[0, 100]} tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTooltip unit="%" />} />
          <Area type="monotone" dataKey={primaryKey} name={primaryKey.toUpperCase()} stroke={CHART_COLORS.memory} fill="url(#gradMem)" strokeWidth={2} dot={false} />
          <Area type="monotone" dataKey="system" name="System" stroke={CHART_COLORS.memorySecondary} fill="url(#gradSys)" strokeWidth={2} dot={false} strokeDasharray="4 2" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// Tokens/sec Chart Component
function TokensChart({ data, height = 140 }) {
  if (!data || data.length < 1) {
    return (
      <div className="chart-container" style={{ height }}>
        <div className="chart-empty">Collecting data...</div>
      </div>
    );
  }

  const maxTokens = Math.max(...data.map(d => d.tokensPerSecond || 0), 10);

  return (
    <div className="chart-container" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
          <defs>
            <linearGradient id="gradTokens" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLORS.tokens} stopOpacity={0.3} />
              <stop offset="95%" stopColor={CHART_COLORS.tokens} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
          <XAxis dataKey="timestamp" hide />
          <YAxis domain={[0, Math.ceil(maxTokens / 5) * 5]} tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTooltip unit=" tok/s" />} />
          <Area type="monotone" dataKey="tokensPerSecond" name="Speed" stroke={CHART_COLORS.tokens} fill="url(#gradTokens)" strokeWidth={2} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// Format timestamp for historical charts based on range
function formatHistoryTime(ts, range) {
  const date = new Date(ts);
  switch (range) {
    case '1h':
    case '1d':
      return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    case '1w':
      return date.toLocaleDateString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    case '1m':
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    case '1y':
      return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    default:
      return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  }
}

// History chart tooltip
function HistoryTooltip({ active, payload, label, unit = '', range = '1h' }) {
  if (!active || !payload || !payload.length) return null;
  const date = new Date(label);
  const timeStr = date.toLocaleString('en-US', { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-time">{timeStr}</div>
      {payload.map((entry, i) => (
        <div key={i} className="chart-tooltip-row">
          <span className="chart-tooltip-dot" style={{ background: entry.color }} />
          <span className="chart-tooltip-label">{entry.name}:</span>
          <span className="chart-tooltip-value">{typeof entry.value === 'number' ? entry.value.toFixed(1) : entry.value}{unit}</span>
        </div>
      ))}
    </div>
  );
}

// Time range selector component
function TimeRangeSelector({ value, onChange }) {
  const ranges = ['1H', '1D', '1W', '1M', '1Y'];
  return (
    <div className="time-range-selector">
      {ranges.map(r => (
        <button
          key={r}
          className={`time-range-btn ${value === r.toLowerCase() ? 'active' : ''}`}
          onClick={() => onChange(r.toLowerCase())}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

// Dashboard Page
function Dashboard({ stats }) {
  const [serverModels, setServerModels] = useState([]);
  const [loading, setLoading] = useState({});
  const [analytics, setAnalytics] = useState(null);
  const [historyRange, setHistoryRange] = useState('1h');
  const [historyData, setHistoryData] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenPage, setFullscreenPage] = useState(0);
  const fullscreenTimerRef = useRef(null);
  const FULLSCREEN_PAGES = 2;

  // Filter to only show models that are actually loaded in llama.cpp
  const loadedModels = useMemo(() =>
    serverModels.filter(m => m.status?.value === 'loaded'),
    [serverModels]
  );

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/models`);
      const data = await res.json();
      setServerModels(data.serverModels || []);
    } catch (err) {
      console.error('Failed to fetch models:', err);
    }
  }, []);

  const fetchAnalytics = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/analytics?minutes=5`);
      const data = await res.json();
      setAnalytics(data);
    } catch (err) {
      console.error('Failed to fetch analytics:', err);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/analytics/history?range=${historyRange}`);
      const data = await res.json();
      setHistoryData(data);
    } catch (err) {
      console.error('Failed to fetch history:', err);
    }
  }, [historyRange]);

  useEffect(() => {
    fetchModels();
    fetchAnalytics();
    fetchHistory();
    const modelsInterval = setInterval(fetchModels, 10000);
    const analyticsInterval = setInterval(fetchAnalytics, 2000);
    const historyInterval = setInterval(fetchHistory, 60000);
    return () => {
      clearInterval(modelsInterval);
      clearInterval(analyticsInterval);
      clearInterval(historyInterval);
    };
  }, [fetchModels, fetchAnalytics, fetchHistory]);

  // Refetch history when range changes
  useEffect(() => {
    fetchHistory();
  }, [historyRange, fetchHistory]);

  // Fullscreen mode
  const enterFullscreen = useCallback(() => {
    document.documentElement.requestFullscreen().then(() => {
      setIsFullscreen(true);
      setFullscreenPage(0);
    }).catch(() => {});
  }, []);

  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false);
    setFullscreenPage(0);
    if (fullscreenTimerRef.current) {
      clearInterval(fullscreenTimerRef.current);
      fullscreenTimerRef.current = null;
    }
  }, []);

  // Listen for fullscreen change (ESC key exits)
  useEffect(() => {
    const handler = () => {
      if (!document.fullscreenElement) {
        exitFullscreen();
      }
    };
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, [exitFullscreen]);

  // Auto-page in fullscreen (fetch interval from settings)
  useEffect(() => {
    if (isFullscreen) {
      let cancelled = false;
      (async () => {
        let interval = 30000;
        try {
          const res = await fetch(`${API_BASE}/settings`);
          const data = await res.json();
          interval = data.settings?.fullscreenInterval || 30000;
        } catch { /* use default */ }
        if (!cancelled) {
          fullscreenTimerRef.current = setInterval(() => {
            setFullscreenPage(p => (p + 1) % FULLSCREEN_PAGES);
          }, interval);
        }
      })();
      return () => {
        cancelled = true;
        if (fullscreenTimerRef.current) {
          clearInterval(fullscreenTimerRef.current);
          fullscreenTimerRef.current = null;
        }
      };
    }
  }, [isFullscreen]);

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

  // Prepare history chart data
  const historyPoints = (historyData?.points || []).map(p => ({
    ...p,
    time: formatHistoryTime(p.ts, historyRange)
  }));

  // Build error code breakdown data from summary
  const errorCodeData = historyData?.summary?.statusCodes
    ? Object.entries(historyData.summary.statusCodes)
        .filter(([code]) => parseInt(code) >= 400)
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count)
    : [];

  // Fullscreen rendering — 2 dense pages
  if (isFullscreen) {
    return (
      <div className="fullscreen-dashboard">
        {/* Page 1: Live status + 5-min charts */}
        <div className={`fullscreen-page ${fullscreenPage === 0 ? 'active' : ''}`}>
          <div className="fullscreen-top-bar">
            <div className="fullscreen-status-row">
              <StatCard label="Status" value={isHealthy ? 'Running' : 'Stopped'} status={isHealthy ? 'success' : 'error'} icon="&#x1F7E2;" />
              <StatCard label="Mode" value={isSingleMode ? 'Single Model' : 'Router (Multi)'} subValue={stats?.preset?.name || null} icon="&#x1F3AF;" />
              <StatCard label="Uptime" value={formatUptime(stats?.llama?.uptime)} icon="&#x23F1;&#xFE0F;" />
              <div className="stat-card loaded-models-card">
                <span className="stat-icon">&#x1F4E6;</span>
                <div className="stat-content">
                  <span className="stat-value">{loadedModels.length} Loaded</span>
                  <span className="stat-label">Models</span>
                  {loadedModels.length > 0 && (
                    <div className="loaded-models-list">
                      {loadedModels.map((m) => (
                        <span key={m.id || m.model || formatModelName(m)} className="loaded-model-name">{formatModelName(m)}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="fullscreen-resources-row">
              <div className="resource-card">
                <ProgressRing value={stats?.cpu?.usage || 0} size={64} strokeWidth={6} color={stats?.cpu?.usage > 80 ? 'var(--error)' : 'var(--accent)'} />
                <div className="resource-info">
                  <span className="resource-label">CPU</span>
                  <span className="resource-detail">{stats?.cpu?.cores || 0} cores @ {stats?.cpu?.loadAvg?.[0]?.toFixed(1) || '0.0'} load</span>
                </div>
              </div>
              <div className="resource-card">
                <ProgressRing value={stats?.memory?.usage || 0} size={64} strokeWidth={6} color={stats?.memory?.usage > 80 ? 'var(--error)' : 'var(--success)'} />
                <div className="resource-info">
                  <span className="resource-label">Memory</span>
                  <span className="resource-detail">{formatBytes(stats?.memory?.used)} / {formatBytes(stats?.memory?.total)}</span>
                </div>
              </div>
              {stats?.gpu && (
                <div className="resource-card">
                  <ProgressRing value={stats.gpu.isAPU ? (stats.gpu.gtt?.usage || 0) : (stats.gpu.vram?.usage || 0)} size={64} strokeWidth={6} color="var(--warning)" />
                  <div className="resource-info">
                    <span className="resource-label">{stats.gpu.isAPU ? 'GTT' : 'VRAM'}</span>
                    <span className="resource-detail">{stats.gpu.isAPU ? `${formatBytes(stats.gpu.gtt?.used)} / ${formatBytes(stats.gpu.gtt?.total)}` : `${formatBytes(stats.gpu.vram?.used)} / ${formatBytes(stats.gpu.vram?.total)}`}</span>
                  </div>
                </div>
              )}
              {stats?.gpu?.power > 0 && (
                <div className="resource-card">
                  <div className="power-display" style={{ width: 64, height: 64 }}><div className="power-inner"><span className="power-value" style={{ fontSize: 18 }}>{stats.gpu.power.toFixed(0)}</span><span className="power-unit">W</span></div></div>
                  <div className="resource-info"><span className="resource-label">Power</span><span className="resource-detail">{stats.gpu.temperature > 0 ? `${stats.gpu.temperature}°C` : ''}</span></div>
                </div>
              )}
              <div className="resource-card">
                <ProgressRing value={stats?.context?.usage || 0} size={64} strokeWidth={6} color="var(--info)" />
                <div className="resource-info">
                  <span className="resource-label">Context</span>
                  <span className="resource-detail">{stats?.context?.totalContext > 0 ? `${(stats.context.usedContext || 0).toLocaleString()} / ${(stats.context.totalContext || 0).toLocaleString()}` : 'No models'}</span>
                </div>
              </div>
            </div>
          </div>
          <div className="fullscreen-charts-grid">
            <div className="chart-card">
              <h4>Temperature <span className="chart-value">GPU: {stats?.gpu?.temperature?.toFixed(0) || 0}°C{stats?.cpu?.temperature ? ` / CPU: ${stats.cpu.temperature}°C` : ''}</span></h4>
              <TemperatureChart data={analytics?.temperature || []} height={200} />
            </div>
            <div className="chart-card">
              <h4>Power <span className="chart-value">{stats?.gpu?.power?.toFixed(0) || 0} W</span></h4>
              <PowerChart data={analytics?.power || []} height={200} />
            </div>
            <div className="chart-card">
              <h4>Memory <span className="chart-value">{stats?.gpu?.isAPU ? `GTT: ${stats?.gpu?.gtt?.usage?.toFixed(0) || 0}%` : `VRAM: ${stats?.gpu?.vram?.usage?.toFixed(0) || 0}%`}</span></h4>
              <MemoryChart data={analytics?.memory || []} primaryKey={stats?.gpu?.isAPU ? 'gtt' : 'vram'} height={200} />
            </div>
            <div className="chart-card">
              <h4>Generation Speed <span className="chart-value">{analytics?.tokenStats?.averageTokensPerSecond?.toFixed(1) || 0} tok/s</span></h4>
              <TokensChart data={analytics?.tokens || []} height={200} />
            </div>
          </div>
        </div>

        {/* Page 2: All historical charts */}
        <div className={`fullscreen-page ${fullscreenPage === 1 ? 'active' : ''}`}>
          <div className="fullscreen-top-bar">
            <div className="fullscreen-history-header">
              <h3>Historical Analytics</h3>
              <TimeRangeSelector value={historyRange} onChange={setHistoryRange} />
            </div>
            {historyData?.summary && (
              <div className="fullscreen-resources-row">
                <div className="resource-card">
                  <div className="resource-info" style={{ textAlign: 'center' }}>
                    <span className="resource-label" style={{ fontSize: 24, fontFamily: 'monospace', color: 'var(--accent)' }}>{historyData.summary.totalRequests.toLocaleString()}</span>
                    <span className="resource-detail">Total Requests</span>
                  </div>
                </div>
                <div className="resource-card">
                  <div className="resource-info" style={{ textAlign: 'center' }}>
                    <span className="resource-label" style={{ fontSize: 24, fontFamily: 'monospace', color: 'var(--error)' }}>{historyData.summary.totalErrors.toLocaleString()}</span>
                    <span className="resource-detail">Errors</span>
                  </div>
                </div>
                <div className="resource-card">
                  <div className="resource-info" style={{ textAlign: 'center' }}>
                    <span className="resource-label" style={{ fontSize: 24, fontFamily: 'monospace', color: 'var(--accent)' }}>{historyData.summary.avgTps}</span>
                    <span className="resource-detail">Avg tok/s</span>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="fullscreen-charts-grid">
            <div className="chart-card">
              <h4>Power Consumption</h4>
              <div className="chart-container" style={{ height: 200 }}>
                {historyPoints.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={historyPoints} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                      <defs><linearGradient id="gradFsPwr" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={CHART_COLORS.power} stopOpacity={0.3} /><stop offset="95%" stopColor={CHART_COLORS.power} stopOpacity={0} /></linearGradient></defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                      <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                      <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
                      <Tooltip content={<HistoryTooltip unit="W" range={historyRange} />} />
                      <Area type="monotone" dataKey="pwr" name="Power" stroke={CHART_COLORS.power} fill="url(#gradFsPwr)" strokeWidth={2} dot={false} animationDuration={500} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : <div className="chart-empty">No historical data yet</div>}
              </div>
            </div>
            <div className="chart-card">
              <h4>Memory Usage</h4>
              <div className="chart-container" style={{ height: 200 }}>
                {historyPoints.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={historyPoints} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                      <defs><linearGradient id="gradFsMem" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={CHART_COLORS.memory} stopOpacity={0.3} /><stop offset="95%" stopColor={CHART_COLORS.memory} stopOpacity={0} /></linearGradient><linearGradient id="gradFsSys" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={CHART_COLORS.memorySecondary} stopOpacity={0.2} /><stop offset="95%" stopColor={CHART_COLORS.memorySecondary} stopOpacity={0} /></linearGradient></defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                      <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                      <YAxis domain={[0, 100]} tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
                      <Tooltip content={<HistoryTooltip unit="%" range={historyRange} />} />
                      <Area type="monotone" dataKey="mg" name="GTT/VRAM" stroke={CHART_COLORS.memory} fill="url(#gradFsMem)" strokeWidth={2} dot={false} animationDuration={500} />
                      <Area type="monotone" dataKey="ms" name="System" stroke={CHART_COLORS.memorySecondary} fill="url(#gradFsSys)" strokeWidth={2} dot={false} strokeDasharray="4 2" animationDuration={500} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : <div className="chart-empty">No historical data yet</div>}
              </div>
            </div>
            <div className="chart-card">
              <h4>Generation Speed</h4>
              <div className="chart-container" style={{ height: 200 }}>
                {historyPoints.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={historyPoints} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                      <defs><linearGradient id="gradFsTps" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={CHART_COLORS.tokens} stopOpacity={0.3} /><stop offset="95%" stopColor={CHART_COLORS.tokens} stopOpacity={0} /></linearGradient></defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                      <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                      <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
                      <Tooltip content={<HistoryTooltip unit=" tok/s" range={historyRange} />} />
                      <Area type="monotone" dataKey="tps" name="Avg tok/s" stroke={CHART_COLORS.tokens} fill="url(#gradFsTps)" strokeWidth={2} dot={false} animationDuration={500} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : <div className="chart-empty">No historical data yet</div>}
              </div>
            </div>
            <div className="chart-card">
              <h4>Request Volume</h4>
              <div className="chart-container" style={{ height: 200 }}>
                {historyPoints.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={historyPoints} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                      <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                      <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
                      <Tooltip content={<HistoryTooltip range={historyRange} />} />
                      <Area type="monotone" dataKey="rOk" name="Success" stroke={CHART_COLORS.requestOk} fill={CHART_COLORS.requestOk} fillOpacity={0.3} strokeWidth={2} dot={false} stackId="req" animationDuration={500} />
                      <Area type="monotone" dataKey="rErr" name="Errors" stroke={CHART_COLORS.requestErr} fill={CHART_COLORS.requestErr} fillOpacity={0.3} strokeWidth={2} dot={false} stackId="req" animationDuration={500} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : <div className="chart-empty">No historical data yet</div>}
              </div>
            </div>
          </div>
        </div>

        <div className="fullscreen-indicator">
          {fullscreenPage + 1} / {FULLSCREEN_PAGES}
        </div>
      </div>
    );
  }

  return (
    <div className="page dashboard">
      <div className="page-header">
        <h2>Dashboard</h2>
        <div className="header-actions">
          <button className="btn-secondary" onClick={enterFullscreen} title="Fullscreen Dashboard">
            &#x26F6;
          </button>
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
          <div className="stat-card loaded-models-card">
            <span className="stat-icon">&#x1F4E6;</span>
            <div className="stat-content">
              <span className="stat-value">{loadedModels.length} Loaded</span>
              <span className="stat-label">Models</span>
              {loadedModels.length > 0 ? (
                <div className="loaded-models-list">
                  {loadedModels.map((m) => (
                    <span key={m.id || m.model || formatModelName(m)} className="loaded-model-name">{formatModelName(m)}</span>
                  ))}
                </div>
              ) : (
                <span className="loaded-model-none">No models loaded</span>
              )}
            </div>
          </div>
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
              <span className="resource-label">CPU</span>
              <span className="resource-detail">{stats?.cpu?.cores || 0} cores @ {stats?.cpu?.loadAvg?.[0]?.toFixed(1) || '0.0'} load</span>
              {stats?.cpu?.temperature && (
                <span className="resource-detail">Temp: {stats.cpu.temperature}°C</span>
              )}
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
              value={stats?.gpu?.isAPU
                ? (stats?.gpu?.gtt?.usage || 0)
                : (stats?.gpu?.vram?.usage || 0)}
              color="var(--warning)"
            />
            <div className="resource-info">
              <span className="resource-label">
                {stats?.gpu?.isAPU ? 'GTT' : 'VRAM'}
              </span>
              {stats?.gpu ? (
                <>
                  <span className="resource-detail">
                    {stats.gpu.isAPU
                      ? `${formatBytes(stats.gpu.gtt?.used)} / ${formatBytes(stats.gpu.gtt?.total)}`
                      : `${formatBytes(stats.gpu.vram?.used)} / ${formatBytes(stats.gpu.vram?.total)}`
                    }
                  </span>
                  {stats.gpu.isAPU && (
                    <span className="resource-detail" style={{fontSize: '0.7em', opacity: 0.7}}>Unified Memory</span>
                  )}
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
                <span className="resource-label">GPU</span>
                <span className="resource-detail">
                  {stats.gpu.usage?.toFixed(0) || 0}% @ {stats.gpu.coreClock || 0} MHz
                </span>
                {stats.gpu.temperature > 0 && (
                  <span className="resource-detail">Temp: {stats.gpu.temperature}°C</span>
                )}
              </div>
            </div>
          )}

          {stats?.gpu?.power > 0 && (
            <div className="resource-card">
              <div className="power-display">
                <div className="power-inner">
                  <span className="power-value">{stats.gpu.power.toFixed(0)}</span>
                  <span className="power-unit">W</span>
                </div>
              </div>
              <div className="resource-info">
                <span className="resource-label">Power</span>
                <span className="resource-detail">
                  Mem: {stats.gpu.memClock || 0} MHz
                </span>
              </div>
            </div>
          )}

          <div className="resource-card">
            <ProgressRing
              value={stats?.context?.usage || 0}
              color="var(--info)"
            />
            <div className="resource-info">
              <span className="resource-label">Context</span>
              {stats?.context?.totalContext > 0 ? (
                <>
                  <span className="resource-detail">
                    {(stats.context.usedContext || 0).toLocaleString()} / {(stats.context.totalContext || 0).toLocaleString()} tokens
                  </span>
                  <span className="resource-detail" style={{fontSize: '0.7em', opacity: 0.7}}>
                    {stats.context.models?.length || 0} model{stats.context.models?.length !== 1 ? 's' : ''} loaded
                  </span>
                </>
              ) : (
                <span className="resource-detail">No models loaded</span>
              )}
            </div>
          </div>
        </div>
      </section>

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

      {/* Analytics Charts */}
      <section className="dashboard-section analytics-section">
        <h3>Performance Analytics (5 min)</h3>
        <div className="charts-grid">
          {/* Temperature Chart */}
          <div className="chart-card">
            <h4>
              Temperature
              <span className="chart-value">
                GPU: {stats?.gpu?.temperature?.toFixed(0) || 0}°C
                {stats?.cpu?.temperature && ` / CPU: ${stats.cpu.temperature}°C`}
              </span>
            </h4>
            <TemperatureChart data={analytics?.temperature || []} />
            <div className="chart-legend">
              <div className="chart-legend-item">
                <span className="chart-legend-dot gpu"></span>
                GPU
              </div>
              <div className="chart-legend-item">
                <span className="chart-legend-dot cpu"></span>
                CPU
              </div>
            </div>
          </div>

          {/* Power Chart */}
          <div className="chart-card">
            <h4>
              Power Consumption
              <span className="chart-value">{stats?.gpu?.power?.toFixed(0) || 0} W</span>
            </h4>
            <PowerChart data={analytics?.power || []} />
          </div>

          {/* Memory Chart */}
          <div className="chart-card">
            <h4>
              Memory Usage
              <span className="chart-value">
                {stats?.gpu?.isAPU
                  ? `GTT: ${stats?.gpu?.gtt?.usage?.toFixed(0) || 0}%`
                  : `VRAM: ${stats?.gpu?.vram?.usage?.toFixed(0) || 0}%`
                }
              </span>
            </h4>
            <MemoryChart
              data={analytics?.memory || []}
              primaryKey={stats?.gpu?.isAPU ? 'gtt' : 'vram'}
            />
            <div className="chart-legend">
              <div className="chart-legend-item">
                <span className="chart-legend-dot vram"></span>
                {stats?.gpu?.isAPU ? 'GTT' : 'VRAM'}
              </div>
              <div className="chart-legend-item">
                <span className="chart-legend-dot system"></span>
                System
              </div>
            </div>
          </div>

          {/* Tokens/sec Chart */}
          <div className="chart-card">
            <h4>
              Generation Speed
              <span className="chart-value">
                {analytics?.tokenStats?.averageTokensPerSecond?.toFixed(1) || 0} tok/s avg
              </span>
            </h4>
            <TokensChart data={analytics?.tokens || []} />
            <div className="token-stats-grid">
              <div className="token-stat-card">
                <div className="token-stat-value">{analytics?.tokenStats?.totalRequests || 0}</div>
                <div className="token-stat-label">Requests</div>
              </div>
              <div className="token-stat-card">
                <div className="token-stat-value">{((analytics?.tokenStats?.totalPromptTokens || 0) / 1000).toFixed(1)}k</div>
                <div className="token-stat-label">Prompt Tokens</div>
              </div>
              <div className="token-stat-card">
                <div className="token-stat-value">{((analytics?.tokenStats?.totalCompletionTokens || 0) / 1000).toFixed(1)}k</div>
                <div className="token-stat-label">Completion Tokens</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Historical Analytics */}
      <section className="dashboard-section analytics-section">
        <div className="section-header-row">
          <h3>Historical Analytics</h3>
          <TimeRangeSelector value={historyRange} onChange={setHistoryRange} />
        </div>

        {historyData?.summary && (
          <div className="history-summary">
            <div className="token-stat-card">
              <div className="token-stat-value">{historyData.summary.totalRequests.toLocaleString()}</div>
              <div className="token-stat-label">Total Requests</div>
            </div>
            <div className="token-stat-card">
              <div className="token-stat-value" style={{ color: 'var(--error)' }}>{historyData.summary.totalErrors.toLocaleString()}</div>
              <div className="token-stat-label">Total Errors</div>
            </div>
            <div className="token-stat-card">
              <div className="token-stat-value">{historyData.summary.avgTps}</div>
              <div className="token-stat-label">Avg tok/s</div>
            </div>
          </div>
        )}

        <div className="charts-grid-wide">
          {/* Power History */}
          <div className="chart-card-wide">
            <h4>Power Consumption <span className="chart-value">over time</span></h4>
            <div className="chart-container-wide">
              {historyPoints.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={historyPoints} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <defs>
                      <linearGradient id="gradHistPower" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.power} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={CHART_COLORS.power} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
                    <Tooltip content={<HistoryTooltip unit="W" range={historyRange} />} />
                    <Area type="monotone" dataKey="pwr" name="Power" stroke={CHART_COLORS.power} fill="url(#gradHistPower)" strokeWidth={2} dot={false} animationDuration={500} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <div className="chart-empty">No historical data yet. Data is aggregated every minute.</div>}
            </div>
          </div>

          {/* Memory History */}
          <div className="chart-card-wide">
            <h4>Memory Usage <span className="chart-value">GTT/VRAM + System</span></h4>
            <div className="chart-container-wide">
              {historyPoints.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={historyPoints} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <defs>
                      <linearGradient id="gradHistMem" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.memory} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={CHART_COLORS.memory} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gradHistSys" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.memorySecondary} stopOpacity={0.2} />
                        <stop offset="95%" stopColor={CHART_COLORS.memorySecondary} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                    <YAxis domain={[0, 100]} tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
                    <Tooltip content={<HistoryTooltip unit="%" range={historyRange} />} />
                    <Area type="monotone" dataKey="mg" name="GTT/VRAM" stroke={CHART_COLORS.memory} fill="url(#gradHistMem)" strokeWidth={2} dot={false} animationDuration={500} />
                    <Area type="monotone" dataKey="ms" name="System" stroke={CHART_COLORS.memorySecondary} fill="url(#gradHistSys)" strokeWidth={2} dot={false} strokeDasharray="4 2" animationDuration={500} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <div className="chart-empty">No historical data yet</div>}
            </div>
            <div className="chart-legend">
              <div className="chart-legend-item"><span className="chart-legend-dot vram"></span>GTT/VRAM</div>
              <div className="chart-legend-item"><span className="chart-legend-dot system"></span>System</div>
            </div>
          </div>

          {/* Generation Speed History */}
          <div className="chart-card-wide">
            <h4>Generation Speed <span className="chart-value">avg tok/s</span></h4>
            <div className="chart-container-wide">
              {historyPoints.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={historyPoints} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <defs>
                      <linearGradient id="gradHistTokens" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.tokens} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={CHART_COLORS.tokens} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
                    <Tooltip content={<HistoryTooltip unit=" tok/s" range={historyRange} />} />
                    <Area type="monotone" dataKey="tps" name="Avg tok/s" stroke={CHART_COLORS.tokens} fill="url(#gradHistTokens)" strokeWidth={2} dot={false} animationDuration={500} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <div className="chart-empty">No historical data yet</div>}
            </div>
          </div>

          {/* Request Volume History */}
          <div className="chart-card-wide">
            <h4>Request Volume <span className="chart-value">success vs errors</span></h4>
            <div className="chart-container-wide">
              {historyPoints.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={historyPoints} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
                    <Tooltip content={<HistoryTooltip range={historyRange} />} />
                    <Area type="monotone" dataKey="rOk" name="Success" stroke={CHART_COLORS.requestOk} fill={CHART_COLORS.requestOk} fillOpacity={0.3} strokeWidth={2} dot={false} stackId="req" animationDuration={500} />
                    <Area type="monotone" dataKey="rErr" name="Errors" stroke={CHART_COLORS.requestErr} fill={CHART_COLORS.requestErr} fillOpacity={0.3} strokeWidth={2} dot={false} stackId="req" animationDuration={500} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <div className="chart-empty">No historical data yet</div>}
            </div>
            <div className="chart-legend">
              <div className="chart-legend-item"><span className="chart-legend-dot" style={{ background: CHART_COLORS.requestOk }}></span>Success</div>
              <div className="chart-legend-item"><span className="chart-legend-dot" style={{ background: CHART_COLORS.requestErr }}></span>Errors</div>
            </div>
          </div>

          {/* Error Code Breakdown */}
          <div className="chart-card-wide">
            <h4>Error Code Breakdown <span className="chart-value">status codes &ge; 400</span></h4>
            <div className="chart-container-wide">
              {errorCodeData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={errorCodeData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis dataKey="code" tick={{ fill: '#888', fontSize: 11 }} tickLine={false} />
                    <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
                    <Tooltip content={<HistoryTooltip range={historyRange} />} />
                    <Bar dataKey="count" name="Count" fill={CHART_COLORS.requestErr} radius={[4, 4, 0, 0]} animationDuration={500} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <div className="chart-empty">No errors in this time range</div>}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// Presets Page
function PresetsPage({ stats }) {
  const [presets, setPresets] = useState([]);
  const [localModels, setLocalModels] = useState([]);
  const [loading, setLoading] = useState({});
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingPreset, setEditingPreset] = useState(null);
  const [newPreset, setNewPreset] = useState({
    id: '',
    name: '',
    description: '',
    modelPath: '',
    context: 0,
    config: {
      temp: 0.7,
      topP: 1.0,
      topK: 20,
      minP: 0,
      chatTemplateKwargs: '',
      extraSwitches: '--jinja'
    }
  });

  const fetchPresets = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/presets`);
      const data = await res.json();
      setPresets(data.presets || []);
    } catch (err) {
      console.error('Failed to fetch presets:', err);
    }
  }, []);

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/models`);
      const data = await res.json();
      setLocalModels(data.localModels || []);
    } catch (err) {
      console.error('Failed to fetch models:', err);
    }
  }, []);

  useEffect(() => {
    fetchPresets();
    fetchModels();
  }, [fetchPresets, fetchModels]);

  const createPreset = async () => {
    if (!newPreset.id || !newPreset.name || !newPreset.modelPath) {
      alert('Please fill in ID, Name, and select a model');
      return;
    }
    setLoading(l => ({ ...l, create: true }));
    try {
      const res = await fetch(`${API_BASE}/presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newPreset)
      });
      if (res.ok) {
        await fetchPresets();
        setShowCreateForm(false);
        setNewPreset({
          id: '', name: '', description: '', modelPath: '', context: 0,
          config: { temp: 0.7, topP: 1.0, topK: 20, minP: 0, chatTemplateKwargs: '', extraSwitches: '--jinja' }
        });
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to create preset');
      }
    } catch (err) {
      console.error('Failed to create preset:', err);
    }
    setLoading(l => ({ ...l, create: false }));
  };

  const deletePreset = async (presetId) => {
    if (!confirm(`Delete preset "${presetId}"?`)) return;
    try {
      await fetch(`${API_BASE}/presets/${presetId}`, { method: 'DELETE' });
      await fetchPresets();
    } catch (err) {
      console.error('Failed to delete preset:', err);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>Presets</h2>
        <div className="page-header-actions">
          <button className="btn-primary" onClick={() => setShowCreateForm(!showCreateForm)}>
            {showCreateForm ? 'Cancel' : '+ Create Preset'}
          </button>
        </div>
      </div>

      <p className="page-description">
        Pre-configured models with specific settings for different use cases.
      </p>

      {/* Create Preset Form */}
      {showCreateForm && (
        <div className="create-preset-form">
          <h3>Create Preset</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>Preset ID</label>
              <input
                type="text"
                placeholder="my-preset"
                value={newPreset.id}
                onChange={(e) => setNewPreset(p => ({ ...p, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') }))}
              />
            </div>
            <div className="form-group">
              <label>Name</label>
              <input
                type="text"
                placeholder="My Custom Preset"
                value={newPreset.name}
                onChange={(e) => setNewPreset(p => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div className="form-group full-width">
              <label>Description</label>
              <input
                type="text"
                placeholder="Optional description"
                value={newPreset.description}
                onChange={(e) => setNewPreset(p => ({ ...p, description: e.target.value }))}
              />
            </div>
            <div className="form-group full-width">
              <label>Model</label>
              <SearchableSelect
                value={newPreset.modelPath}
                onChange={(val) => setNewPreset(p => ({ ...p, modelPath: val }))}
                options={localModels.map(m => ({ value: m.name, label: formatModelName(m) }))}
                placeholder="Select a local model..."
                storageKey="lastPresetModel"
              />
            </div>
            <div className="form-group">
              <label>Context Size (0 = default)</label>
              <input
                type="number"
                value={newPreset.context}
                onChange={(e) => setNewPreset(p => ({ ...p, context: parseInt(e.target.value) || 0 }))}
              />
            </div>
            <div className="form-group">
              <label>Temperature</label>
              <input
                type="number"
                step="0.1"
                value={newPreset.config.temp}
                onChange={(e) => setNewPreset(p => ({ ...p, config: { ...p.config, temp: parseFloat(e.target.value) || 0.7 } }))}
              />
            </div>
            <div className="form-group">
              <label>Top P</label>
              <input
                type="number"
                step="0.1"
                value={newPreset.config.topP}
                onChange={(e) => setNewPreset(p => ({ ...p, config: { ...p.config, topP: parseFloat(e.target.value) || 1.0 } }))}
              />
            </div>
            <div className="form-group">
              <label>Top K</label>
              <input
                type="number"
                value={newPreset.config.topK}
                onChange={(e) => setNewPreset(p => ({ ...p, config: { ...p.config, topK: parseInt(e.target.value) || 0 } }))}
              />
            </div>
            <div className="form-group full-width">
              <label>Extra Switches</label>
              <input
                type="text"
                placeholder="--jinja"
                value={newPreset.config.extraSwitches}
                onChange={(e) => setNewPreset(p => ({ ...p, config: { ...p.config, extraSwitches: e.target.value } }))}
              />
            </div>
            <div className="form-group full-width">
              <label>Chat Template Kwargs (JSON)</label>
              <input
                type="text"
                placeholder='{"reasoning_effort": "high"}'
                value={newPreset.config.chatTemplateKwargs}
                onChange={(e) => setNewPreset(p => ({ ...p, config: { ...p.config, chatTemplateKwargs: e.target.value } }))}
              />
            </div>
          </div>
          <div className="form-actions">
            <button className="btn-secondary" onClick={() => setShowCreateForm(false)}>Cancel</button>
            <button className="btn-primary" onClick={createPreset} disabled={loading.create}>
              {loading.create ? 'Creating...' : 'Create Preset'}
            </button>
          </div>
        </div>
      )}

      {/* Presets Section */}
      <section className="page-section">
        <h3>Presets</h3>
        <div className="presets-grid">
          {presets.map((preset) => {
            // Determine display values - support both hfRepo format and legacy repo/quantization
            const modelDisplay = preset.hfRepo || 
              (preset.repo ? `${preset.repo}:${preset.quantization || 'Q5_K_M'}` : null) ||
              preset.modelPath?.split('/').pop() ||
              'Unknown';
            
            return (
              <div key={preset.id} className="preset-card">
                <div className="preset-header">
                  <h3>{preset.name}</h3>
                </div>

                <p className="preset-description">{preset.description}</p>

                <div className="preset-details">
                  <div className="detail-row">
                    <span className="detail-label">Model</span>
                    <span className="detail-value">{modelDisplay}</span>
                  </div>
                  {preset.context > 0 && (
                    <div className="detail-row">
                      <span className="detail-label">Context</span>
                      <span className="detail-value">{preset.context.toLocaleString()}</span>
                    </div>
                  )}
                </div>

                <div className="preset-actions">
                  <button
                    className="btn-danger"
                    onClick={() => deletePreset(preset.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

// Models Page
function ModelsPage({ stats }) {
  const [serverModels, setServerModels] = useState([]);
  const [localModels, setLocalModels] = useState([]);
  const [modelsDir, setModelsDir] = useState('');
  const [loading, setLoading] = useState({});
  const [editingAlias, setEditingAlias] = useState(null);
  const [aliasInput, setAliasInput] = useState('');

  // Filter to only show models that are actually loaded in llama.cpp
  const loadedModels = useMemo(() =>
    serverModels.filter(m => m.status?.value === 'loaded'),
    [serverModels]
  );

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

  const saveAlias = async (modelName) => {
    try {
      await fetch(`${API_BASE}/models/aliases/${encodeURIComponent(modelName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: aliasInput.trim() || null })
      });
      await fetchModels();
    } catch (err) {
      console.error('Failed to save alias:', err);
    }
    setEditingAlias(null);
    setAliasInput('');
  };

  const startEditAlias = (model) => {
    setEditingAlias(model.name);
    setAliasInput(model.alias || '');
  };

  const getModelStatus = (modelName) => {
    return loadedModels.some(m =>
      m.id === modelName || m.model === modelName || (m.id && m.id.includes(modelName))
    ) ? 'loaded' : 'unloaded';
  };

  // Get display name (alias or short name)
  const getDisplayName = (model) => {
    if (model.alias) return model.alias;
    // Extract just the filename from the path
    const parts = model.name.split('/');
    return parts[parts.length - 1];
  };

  // Find alias for a loaded model
  const getAliasForLoadedModel = (modelId) => {
    const localModel = localModels.find(m => m.name === modelId);
    return localModel?.alias || null;
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
      {loadedModels.length > 0 && (
        <section className="page-section">
          <h3>Loaded Models</h3>
          <div className="models-grid">
            {loadedModels.map((model) => {
              const alias = getAliasForLoadedModel(model.id);
              return (
                <div key={model.id} className="model-card active">
                  <div className="model-header">
                    <h4 title={model.id}>{alias || model.id.split('/').pop()}</h4>
                    <span className="badge success">Loaded</span>
                  </div>
                  {alias && <div className="model-path">{model.id}</div>}
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
              );
            })}
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
              const isEditing = editingAlias === model.name;

              return (
                <div key={model.path} className={`model-card ${isLoaded ? 'active' : ''} ${model.incomplete ? 'incomplete' : ''}`}>
                  <div className="model-header">
                    {isEditing ? (
                      <div className="alias-edit">
                        <input
                          type="text"
                          value={aliasInput}
                          onChange={(e) => setAliasInput(e.target.value)}
                          placeholder="Enter alias..."
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveAlias(model.name);
                            if (e.key === 'Escape') { setEditingAlias(null); setAliasInput(''); }
                          }}
                        />
                        <button className="btn-small" onClick={() => saveAlias(model.name)}>Save</button>
                        <button className="btn-small btn-secondary" onClick={() => { setEditingAlias(null); setAliasInput(''); }}>Cancel</button>
                      </div>
                    ) : (
                      <>
                        <h4 title={model.name}>
                          {getDisplayName(model)}
                          <button
                            className="alias-edit-btn"
                            onClick={() => startEditAlias(model)}
                            title={model.alias ? 'Edit alias' : 'Set alias'}
                          >
                            ✎
                          </button>
                        </h4>
                        {isLoaded && <span className="badge success">Loaded</span>}
                        {model.incomplete && <span className="badge warning">Incomplete</span>}
                        {model.isSplit && !model.incomplete && <span className="badge info">{model.partCount} parts</span>}
                      </>
                    )}
                  </div>
                  {model.alias && !isEditing && (
                    <div className="model-path">{model.name}</div>
                  )}
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
                        disabled={loading[model.name] || !isHealthy || model.incomplete}
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
  const [repoError, setRepoError] = useState(null);
  const [customPattern, setCustomPattern] = useState('');

  const searchModels = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSelectedRepo(null);
    setRepoQuantizations([]);
    setRepoError(null);
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
    setRepoError(null);
    setRepoQuantizations([]);
    try {
      const [author, model] = repo.id.split('/');
      const res = await fetch(`${API_BASE}/repo/${author}/${model}/files`);
      const data = await res.json();
      if (data.error) {
        setRepoError(data.error);
      } else {
        setRepoQuantizations(data.quantizations || []);
      }
    } catch (err) {
      console.error('Failed to fetch repo files:', err);
      setRepoError(err.message);
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

  const downloadAllGguf = async (repo) => {
    try {
      await fetch(`${API_BASE}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo })
      });
    } catch (err) {
      console.error('Failed to start download:', err);
    }
  };

  const downloadWithPattern = async (repo, pattern) => {
    if (!pattern.trim()) return;
    try {
      await fetch(`${API_BASE}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, pattern: pattern.trim() })
      });
      setCustomPattern('');
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
            <a
              href={`https://huggingface.co/${selectedRepo.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="repo-link"
            >
              View on HuggingFace ↗
            </a>
          </div>

          {loadingFiles ? (
            <div className="loading-state">
              <div className="loading-spinner"></div>
              <p>Scanning repository for GGUF files...</p>
            </div>
          ) : repoError ? (
            <div className="error-state">
              <p>Error loading repository: {repoError}</p>
              <div className="fallback-options">
                <p>You can still try to download using a custom pattern:</p>
                <div className="custom-download-row">
                  <input
                    type="text"
                    value={customPattern}
                    onChange={(e) => setCustomPattern(e.target.value)}
                    placeholder="e.g., *.gguf or *Q4_K_M*.gguf"
                  />
                  <button
                    className="btn-primary"
                    onClick={() => downloadWithPattern(selectedRepo.id, customPattern)}
                    disabled={!customPattern.trim()}
                  >
                    Download
                  </button>
                </div>
              </div>
            </div>
          ) : repoQuantizations.length === 0 ? (
            <div className="no-quants-state">
              <p>No recognized quantizations found in this repository.</p>
              <p className="hint">The repository may use different naming conventions or store files in subdirectories.</p>

              <div className="fallback-options">
                <h4>Download Options</h4>

                <div className="option-card">
                  <div className="option-info">
                    <span className="option-title">Download all GGUF files</span>
                    <span className="option-desc">Downloads any file ending in .gguf</span>
                  </div>
                  <button
                    className="btn-primary"
                    onClick={() => downloadAllGguf(selectedRepo.id)}
                  >
                    Download All
                  </button>
                </div>

                <div className="option-card">
                  <div className="option-info">
                    <span className="option-title">Custom pattern</span>
                    <span className="option-desc">Specify a glob pattern (e.g., *Q5_K_M*.gguf)</span>
                  </div>
                  <div className="custom-download-row">
                    <input
                      type="text"
                      value={customPattern}
                      onChange={(e) => setCustomPattern(e.target.value)}
                      placeholder="*Q4_K_M*.gguf"
                    />
                    <button
                      className="btn-primary"
                      onClick={() => downloadWithPattern(selectedRepo.id, customPattern)}
                      disabled={!customPattern.trim()}
                    >
                      Download
                    </button>
                  </div>
                </div>
              </div>
            </div>
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

              {/* Also offer custom pattern option */}
              <div className="quant-item custom-pattern">
                <div className="quant-info">
                  <span className="quant-badge secondary">Custom</span>
                  <input
                    type="text"
                    value={customPattern}
                    onChange={(e) => setCustomPattern(e.target.value)}
                    placeholder="Custom pattern (e.g., *IQ4*.gguf)"
                    className="inline-input"
                  />
                </div>
                <button
                  className="btn-secondary"
                  onClick={() => downloadWithPattern(selectedRepo.id, customPattern)}
                  disabled={!customPattern.trim()}
                >
                  Download
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// Logs Page
function LogsPage({ logs, clearLogs, requestLogs, clearRequestLogs, llmLogs, clearLlmLogs }) {
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [showFiltersPanel, setShowFiltersPanel] = useState(false);
  const [logFilters, setLogFilters] = useState({ defaultFilters: [], customFilters: [] });
  const [newFilterPattern, setNewFilterPattern] = useState('');
  const [activeTab, setActiveTab] = useState('server');
  const logsEndRef = useRef(null);
  const logsContainerRef = useRef(null);

  // Fetch initial logs and filters on mount
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
    fetchFilters();
  }, []);

  // Fetch historical request logs on first tab switch
  const [fetchedRequestLogs, setFetchedRequestLogs] = useState([]);
  const [requestLogsLoaded, setRequestLogsLoaded] = useState(false);
  useEffect(() => {
    if (activeTab !== 'requests' || requestLogsLoaded) return;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/request-logs?limit=200`);
        const data = await res.json();
        if (data.logs?.length) setFetchedRequestLogs(data.logs);
        setRequestLogsLoaded(true);
      } catch (err) {
        console.error('Failed to fetch request logs:', err);
      }
    })();
  }, [activeTab, requestLogsLoaded]);

  // Merge fetched + WS request logs, deduplicated by id
  const allRequestLogs = React.useMemo(() => {
    const wsIds = new Set(requestLogs.map(l => l.id));
    const historical = fetchedRequestLogs.filter(l => !wsIds.has(l.id));
    return [...historical, ...requestLogs].slice(-200);
  }, [fetchedRequestLogs, requestLogs]);

  const handleClearRequestLogs = async () => {
    clearRequestLogs();
    setFetchedRequestLogs([]);
    try {
      await fetch(`${API_BASE}/request-logs`, { method: 'DELETE' });
    } catch (err) {
      console.error('Failed to clear request logs:', err);
    }
  };

  // Fetch historical LLM logs on first tab switch
  const [fetchedLlmLogs, setFetchedLlmLogs] = useState([]);
  const [llmLogsLoaded, setLlmLogsLoaded] = useState(false);
  const [expandedRequestLogs, setExpandedRequestLogs] = useState(new Set());
  const [expandedLlmLogs, setExpandedLlmLogs] = useState(new Set());
  const [expandedSystemMsgs, setExpandedSystemMsgs] = useState(new Set());
  useEffect(() => {
    if (activeTab !== 'llm' || llmLogsLoaded) return;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/llm-logs?limit=50`);
        const data = await res.json();
        if (data.logs?.length) setFetchedLlmLogs(data.logs);
        setLlmLogsLoaded(true);
      } catch (err) {
        console.error('Failed to fetch LLM logs:', err);
      }
    })();
  }, [activeTab, llmLogsLoaded]);

  const allLlmLogs = React.useMemo(() => {
    const wsIds = new Set(llmLogs.map(l => l.id));
    const historical = fetchedLlmLogs.filter(l => !wsIds.has(l.id));
    return [...historical, ...llmLogs].slice(-50);
  }, [fetchedLlmLogs, llmLogs]);

  const handleClearLlmLogs = async () => {
    clearLlmLogs();
    setFetchedLlmLogs([]);
    setExpandedLlmLogs(new Set());
    try {
      await fetch(`${API_BASE}/llm-logs`, { method: 'DELETE' });
    } catch (err) {
      console.error('Failed to clear LLM logs:', err);
    }
  };

  const toggleLlmLogExpand = (id) => {
    setExpandedLlmLogs(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSystemMsg = (key) => {
    setExpandedSystemMsgs(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const [resubmitting, setResubmitting] = useState({});
  const [copiedField, setCopiedField] = useState(null);

  const handleCopyField = async (text, fieldId) => {
    try {
      await copyTextToClipboard(text);
      setCopiedField(fieldId);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleResubmit = async (log) => {
    if (!log.requestBody) return;
    setResubmitting(prev => ({ ...prev, [log.id]: 'loading' }));
    try {
      // Force non-streaming for resubmit so we get a clean response
      const body = { ...log.requestBody, stream: false };
      const res = await fetch(`${API_BASE}/v1/${log.endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        setResubmitting(prev => ({ ...prev, [log.id]: 'success' }));
      } else {
        const errText = await res.text();
        setResubmitting(prev => ({ ...prev, [log.id]: `error: ${res.status} - ${errText.slice(0, 200)}` }));
      }
    } catch (err) {
      setResubmitting(prev => ({ ...prev, [log.id]: `error: ${err.message}` }));
    }
    // Clear status after 10 seconds
    setTimeout(() => {
      setResubmitting(prev => {
        const next = { ...prev };
        delete next[log.id];
        return next;
      });
    }, 10000);
  };

  const filteredLlmLogs = filter
    ? allLlmLogs.filter(log =>
        (log.model || '').toLowerCase().includes(filter.toLowerCase()) ||
        (log.response || '').toLowerCase().includes(filter.toLowerCase()) ||
        (log.messages || []).some(m =>
          (typeof m.content === 'string' ? m.content : '').toLowerCase().includes(filter.toLowerCase())
        ) ||
        (log.prompt || '').toLowerCase().includes(filter.toLowerCase())
      )
    : allLlmLogs;

  const fetchFilters = async () => {
    try {
      const res = await fetch(`${API_BASE}/logs/filters`);
      const data = await res.json();
      setLogFilters(data);
    } catch (err) {
      console.error('Failed to fetch log filters:', err);
    }
  };

  const addFilter = async (pattern) => {
    try {
      const res = await fetch(`${API_BASE}/logs/filters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern })
      });
      if (res.ok) {
        const data = await res.json();
        setLogFilters(prev => ({ ...prev, customFilters: data.filters }));
        setNewFilterPattern('');
      }
    } catch (err) {
      console.error('Failed to add filter:', err);
    }
  };

  const removeFilter = async (pattern) => {
    try {
      const res = await fetch(`${API_BASE}/logs/filters`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern })
      });
      if (res.ok) {
        const data = await res.json();
        setLogFilters(prev => ({ ...prev, customFilters: data.filters }));
      }
    } catch (err) {
      console.error('Failed to remove filter:', err);
    }
  };

  const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const addFilterFromLog = (message) => {
    // Escape special regex chars and create a pattern
    const pattern = escapeRegex(message);
    addFilter(pattern);
  };

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

  const filteredRequestLogs = filter
    ? allRequestLogs.filter(log =>
        (log.path || '').toLowerCase().includes(filter.toLowerCase()) ||
        (log.method || '').toLowerCase().includes(filter.toLowerCase()) ||
        (log.model || '').toLowerCase().includes(filter.toLowerCase())
      )
    : allRequestLogs;

  const getStatusClass = (status) => {
    if (status >= 500) return 'status-5xx';
    if (status >= 400) return 'status-4xx';
    if (status >= 200 && status < 300) return 'status-2xx';
    return '';
  };

  return (
    <div className="page logs-page">
      <div className="page-header">
        <h2>Logs</h2>
        <div className="logs-tabs">
          <button
            className={`tab-btn ${activeTab === 'server' ? 'active' : ''}`}
            onClick={() => setActiveTab('server')}
          >
            Server Logs
          </button>
          <button
            className={`tab-btn ${activeTab === 'requests' ? 'active' : ''}`}
            onClick={() => setActiveTab('requests')}
          >
            Request Logs
          </button>
          <button
            className={`tab-btn ${activeTab === 'llm' ? 'active' : ''}`}
            onClick={() => setActiveTab('llm')}
          >
            LLM Log
          </button>
        </div>
        <div className="logs-actions">
          <input
            type="text"
            placeholder="Filter logs..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="logs-filter"
          />
          {activeTab === 'server' ? (
            <>
              <button className="btn-secondary" onClick={clearLogs}>
                Clear
              </button>
              <button
                className={`btn-secondary ${showFiltersPanel ? 'active' : ''}`}
                onClick={() => setShowFiltersPanel(!showFiltersPanel)}
                title="Manage server-side log filters"
              >
                Filters ({logFilters.customFilters.length})
              </button>
            </>
          ) : activeTab === 'requests' ? (
            <button className="btn-secondary" onClick={handleClearRequestLogs}>
              Clear
            </button>
          ) : (
            <button className="btn-secondary" onClick={handleClearLlmLogs}>
              Clear
            </button>
          )}
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

      {activeTab === 'server' && showFiltersPanel && (
        <div className="filters-panel">
          <div className="filters-section">
            <h4>Server-side Log Filters</h4>
            <p className="hint">Matching log lines are ignored at the server and won't appear in logs.</p>

            <div className="filter-input-row">
              <input
                type="text"
                placeholder="Add regex pattern (e.g., GET /api.*200)"
                value={newFilterPattern}
                onChange={(e) => setNewFilterPattern(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && newFilterPattern && addFilter(newFilterPattern)}
              />
              <button
                className="btn-primary"
                onClick={() => addFilter(newFilterPattern)}
                disabled={!newFilterPattern}
              >
                Add
              </button>
            </div>

            {logFilters.defaultFilters.length > 0 && (
              <div className="filter-group">
                <h5>Default Filters (built-in)</h5>
                {logFilters.defaultFilters.map((f, i) => (
                  <div key={i} className="filter-item default">
                    <code>{f}</code>
                  </div>
                ))}
              </div>
            )}

            {logFilters.customFilters.length > 0 && (
              <div className="filter-group">
                <h5>Custom Filters</h5>
                {logFilters.customFilters.map((f, i) => (
                  <div key={i} className="filter-item custom">
                    <code>{f}</code>
                    <button className="btn-remove" onClick={() => removeFilter(f)} title="Remove filter">×</button>
                  </div>
                ))}
              </div>
            )}

            {logFilters.customFilters.length === 0 && (
              <p className="no-filters">No custom filters. Click the mute icon on a log entry to filter similar messages.</p>
            )}
          </div>
        </div>
      )}

      {activeTab === 'server' ? (
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
                  <button
                    className="btn-mute"
                    onClick={() => addFilterFromLog(log.message)}
                    title="Filter this log pattern"
                  >
                    🔇
                  </button>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      ) : activeTab === 'requests' ? (
        <div
          className="logs-container"
          ref={logsContainerRef}
          onScroll={handleScroll}
        >
          {filteredRequestLogs.length === 0 ? (
            <div className="logs-empty">
              <p>No request logs yet</p>
              <p className="hint">Enable request logging in Settings, then API requests will appear here</p>
            </div>
          ) : (
            <div className="request-logs-table">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Method</th>
                    <th>Path</th>
                    <th>Status</th>
                    <th>Duration</th>
                    <th>Model</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRequestLogs.map((log, i) => {
                    const hasError = log.error && log.status >= 400;
                    const isExpanded = expandedRequestLogs.has(log.id);
                    return (
                      <React.Fragment key={log.id || i}>
                        <tr
                          className={`${getStatusClass(log.status)} ${hasError ? 'clickable' : ''}`}
                          onClick={() => hasError && setExpandedRequestLogs(prev => {
                            const next = new Set(prev);
                            if (next.has(log.id)) next.delete(log.id); else next.add(log.id);
                            return next;
                          })}
                        >
                          <td className="log-time">
                            {hasError && <span className="request-expand">{isExpanded ? '\u25BC' : '\u25B6'}</span>}
                            {formatTime(log.timestamp)}
                          </td>
                          <td className="request-method">{log.method}</td>
                          <td className="request-path" title={log.path}>{log.path}</td>
                          <td className={`request-status ${getStatusClass(log.status)}`}>{log.status}</td>
                          <td className="request-duration">{log.duration}ms</td>
                          <td className="request-model">{log.model || '-'}</td>
                        </tr>
                        {isExpanded && (
                          <tr className="request-error-row">
                            <td colSpan="6">
                              <div className="request-error-content">{log.error}</div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      ) : (
        <div className="logs-container llm-logs-container">
          {filteredLlmLogs.length === 0 ? (
            <div className="logs-empty">
              <p>No LLM conversation logs yet</p>
              <p className="hint">Send a request via Chat or any API endpoint to see conversations here</p>
            </div>
          ) : (
            <div className="llm-logs-list">
              {filteredLlmLogs.map((log) => {
                const isExpanded = expandedLlmLogs.has(log.id);
                const isError = log.status >= 400;
                return (
                  <div key={log.id} className={`llm-log-card ${isError ? 'error' : ''}`}>
                    <div className="llm-log-summary" onClick={() => toggleLlmLogExpand(log.id)}>
                      <span className="llm-log-expand">{isExpanded ? '\u25BC' : '\u25B6'}</span>
                      <span className="log-time">{formatTime(log.timestamp)}</span>
                      <span className="llm-log-model">{log.model}</span>
                      <span className="llm-log-tokens">
                        {log.promptTokens} &rarr; {log.completionTokens}
                      </span>
                      <span className="llm-log-duration">{log.duration}ms</span>
                      {log.tokensPerSecond > 0 && (
                        <span className="llm-log-tps">{log.tokensPerSecond} t/s</span>
                      )}
                      <span className={`llm-log-endpoint ${log.endpoint}`}>{log.endpoint}</span>
                      {log.stream && <span className="llm-log-badge stream">stream</span>}
                      {isError && <span className="llm-log-badge error">{log.status}</span>}
                    </div>
                    {isExpanded && (
                      <div className="llm-log-detail">
                        {log.messages && log.messages.length > 0 && (
                          <div className="llm-log-messages">
                            <div className="llm-log-section-title">Messages</div>
                            {log.messages.map((msg, mi) => {
                              const role = msg.role || 'unknown';
                              const content = typeof msg.content === 'string'
                                ? msg.content
                                : Array.isArray(msg.content)
                                  ? msg.content.map(c => c.text || c.content || '').join('')
                                  : JSON.stringify(msg.content);
                              const isSystem = role === 'system';
                              const msgKey = `${log.id}-${mi}`;
                              const isSystemExpanded = expandedSystemMsgs.has(msgKey);
                              return (
                                <div key={mi} className={`llm-msg llm-msg-${role}`}>
                                  <span className={`llm-msg-role ${role}`}>{role}</span>
                                  {isSystem ? (
                                    <div className="llm-msg-content system">
                                      <div
                                        className="llm-msg-system-toggle"
                                        onClick={(e) => { e.stopPropagation(); toggleSystemMsg(msgKey); }}
                                      >
                                        {isSystemExpanded ? '\u25BC' : '\u25B6'} System message ({content.length} chars)
                                      </div>
                                      {isSystemExpanded && (
                                        <div className="llm-msg-text">{content}</div>
                                      )}
                                    </div>
                                  ) : (
                                    <div className="llm-msg-content">
                                      <div className="llm-msg-text">{parseMessageWithCodeBlocks(content)}</div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {log.prompt && (
                          <div className="llm-log-prompt-section">
                            <div className="llm-log-section-title">Prompt</div>
                            <div className="llm-log-prompt-content">
                              <CodeBlock code={log.prompt} language="" />
                            </div>
                          </div>
                        )}
                        {log.response && (
                          <div className="llm-log-response-section">
                            <div className="llm-log-section-title">Response</div>
                            <div className="llm-log-response-content">
                              {parseMessageWithCodeBlocks(log.response)}
                            </div>
                          </div>
                        )}
                        {log.error && (
                          <div className="llm-log-error-section">
                            <div className="llm-log-section-title">
                              Error
                              <button
                                className="copy-field-btn"
                                onClick={(e) => { e.stopPropagation(); handleCopyField(log.error, `error-${log.id}`); }}
                              >{copiedField === `error-${log.id}` ? 'Copied' : 'Copy'}</button>
                            </div>
                            <div className="llm-log-error-content">{log.error}</div>
                          </div>
                        )}
                        {log.requestBody && (
                          <div className="llm-log-request-body-section">
                            <div className="llm-log-section-title">
                              Full Request Body
                              <button
                                className="copy-field-btn"
                                onClick={(e) => { e.stopPropagation(); handleCopyField(JSON.stringify(log.requestBody, null, 2), `body-${log.id}`); }}
                              >{copiedField === `body-${log.id}` ? 'Copied' : 'Copy'}</button>
                            </div>
                            <pre className="llm-log-request-body">{JSON.stringify(log.requestBody, null, 2)}</pre>
                            <div className="llm-log-resubmit-row">
                              <button
                                className="btn-secondary resubmit-btn"
                                onClick={(e) => { e.stopPropagation(); handleResubmit(log); }}
                                disabled={resubmitting[log.id] === 'loading'}
                              >
                                {resubmitting[log.id] === 'loading' ? 'Resubmitting...' : 'Resubmit Request'}
                              </button>
                              {resubmitting[log.id] && resubmitting[log.id] !== 'loading' && (
                                <span className={`resubmit-status ${resubmitting[log.id] === 'success' ? 'success' : 'error'}`}>
                                  {resubmitting[log.id] === 'success' ? 'Success - check LLM Log for new entry' : resubmitting[log.id]}
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
        <button className="btn-secondary" onClick={fetchProcesses}>
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
            <section className="page-section">
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
                    className="btn-danger btn-small"
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
            <section className="page-section">
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
                        className="btn-danger btn-small"
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
          <section className="page-section">
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

// Settings Page
function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/settings`);
      const data = await res.json();
      setSettings(data.settings);
      setDefaults(data.defaults);
    } catch (err) {
      console.error('Failed to fetch settings:', err);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const saveSettings = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      const data = await res.json();
      if (data.success) {
        setMessage({ type: 'success', text: data.message });
      } else {
        setMessage({ type: 'error', text: data.error });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to save settings' });
    }
    setSaving(false);
  };

  const restartServer = async () => {
    setMessage({ type: 'info', text: 'Restarting server...' });
    try {
      await fetch(`${API_BASE}/server/stop`, { method: 'POST' });
      await new Promise(r => setTimeout(r, 2000));
      await fetch(`${API_BASE}/server/start`, { method: 'POST' });
      setMessage({ type: 'success', text: 'Server restarted with new settings' });
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to restart server' });
    }
  };

  const updateSetting = (key, value) => {
    setSettings(s => ({ ...s, [key]: value }));
  };

  if (loading) {
    return (
      <div className="page">
        <div className="page-header">
          <h2>Settings</h2>
        </div>
        <div className="empty-state">
          <p>Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page settings-page">
      <div className="page-header">
        <h2>Settings</h2>
        <div className="header-actions">
          <button className="btn-secondary" onClick={restartServer}>
            Restart Server
          </button>
          <button className="btn-primary" onClick={saveSettings} disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>

      {message && (
        <div className={`settings-message ${message.type}`}>
          {message.text}
        </div>
      )}

      <section className="page-section">
        <h3>Model Loading</h3>
        <div className="settings-grid">
          <div className="setting-item">
            <label htmlFor="contextSize">Context Size</label>
            <p className="setting-hint">
              Maximum context window size. Larger values use more VRAM and take longer to warm up.
              Default: {defaults?.contextSize?.toLocaleString() || '8192'}
            </p>
            <select
              id="contextSize"
              value={settings?.contextSize || 8192}
              onChange={(e) => updateSetting('contextSize', parseInt(e.target.value))}
            >
              <option value={2048}>2,048 (Fast)</option>
              <option value={4096}>4,096</option>
              <option value={8192}>8,192</option>
              <option value={16384}>16,384</option>
              <option value={32768}>32,768</option>
              <option value={65536}>65,536</option>
              <option value={131072}>131,072 (Slow warmup)</option>
              <option value={262144}>262,144 (Very slow)</option>
            </select>
          </div>

          <div className="setting-item">
            <label htmlFor="modelsMax">Max Loaded Models</label>
            <p className="setting-hint">
              Maximum number of models to keep loaded simultaneously in router mode.
            </p>
            <select
              id="modelsMax"
              value={settings?.modelsMax || 2}
              onChange={(e) => updateSetting('modelsMax', parseInt(e.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>

          <div className="setting-item">
            <label htmlFor="gpuLayers">GPU Layers</label>
            <p className="setting-hint">
              Number of layers to offload to GPU. Use 99 for full GPU offload.
            </p>
            <input
              type="number"
              id="gpuLayers"
              value={settings?.gpuLayers || 99}
              onChange={(e) => updateSetting('gpuLayers', parseInt(e.target.value))}
              min={0}
              max={999}
            />
          </div>
        </div>
      </section>

      <section className="page-section">
        <h3>Performance Options</h3>
        <div className="settings-grid">
          <div className="setting-item checkbox">
            <label>
              <input
                type="checkbox"
                checked={settings?.noWarmup || false}
                onChange={(e) => updateSetting('noWarmup', e.target.checked)}
              />
              <span>Skip Warmup</span>
            </label>
            <p className="setting-hint">
              Skip model warmup on load. Faster startup but first inference may be slower.
            </p>
          </div>

          <div className="setting-item checkbox">
            <label>
              <input
                type="checkbox"
                checked={settings?.flashAttn || false}
                onChange={(e) => updateSetting('flashAttn', e.target.checked)}
              />
              <span>Flash Attention</span>
            </label>
            <p className="setting-hint">
              Enable flash attention for faster inference (requires compatible GPU).
            </p>
          </div>

          <div className="setting-item checkbox">
            <label>
              <input
                type="checkbox"
                checked={settings?.autoStart || false}
                onChange={(e) => updateSetting('autoStart', e.target.checked)}
              />
              <span>Auto-Start Server</span>
            </label>
            <p className="setting-hint">
              Automatically start the llama server when the manager starts.
            </p>
          </div>
        </div>
      </section>

      <section className="page-section">
        <h3>Inference Defaults</h3>
        <div className="settings-grid">
          <div className="setting-item">
            <label htmlFor="defaultReasoningEffort">Default Reasoning Effort</label>
            <p className="setting-hint">
              Inject reasoning_effort into chat_template_kwargs for models that support it. Client-set values always take priority.
            </p>
            <select
              id="defaultReasoningEffort"
              value={settings?.defaultReasoningEffort || ''}
              onChange={(e) => updateSetting('defaultReasoningEffort', e.target.value || null)}
            >
              <option value="">Disabled</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
        </div>

        <div className="model-overrides-section">
          <label>Per-Model Overrides</label>
          <p className="setting-hint">
            Override reasoning effort for specific models. Use * as wildcard (e.g. gpt-oss*).
          </p>
          <div className="model-overrides-list">
            {Object.entries(settings?.modelReasoningEffort || {}).map(([pattern, effort]) => (
              <div key={pattern} className="model-override-row">
                <span className="model-override-pattern">{pattern}</span>
                <select
                  value={effort}
                  onChange={(e) => {
                    const updated = { ...settings.modelReasoningEffort };
                    updated[pattern] = e.target.value;
                    updateSetting('modelReasoningEffort', updated);
                  }}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    const updated = { ...settings.modelReasoningEffort };
                    delete updated[pattern];
                    updateSetting('modelReasoningEffort', updated);
                  }}
                  title="Remove override"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div className="model-override-add">
            <input
              type="text"
              placeholder="Model pattern (e.g. gpt-oss*)"
              id="newOverridePattern"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const pattern = e.target.value.trim();
                  if (pattern && !(settings?.modelReasoningEffort || {})[pattern]) {
                    updateSetting('modelReasoningEffort', { ...settings.modelReasoningEffort, [pattern]: 'high' });
                    e.target.value = '';
                  }
                }
              }}
            />
            <button
              className="btn btn-sm"
              onClick={() => {
                const input = document.getElementById('newOverridePattern');
                const pattern = input.value.trim();
                if (pattern && !(settings?.modelReasoningEffort || {})[pattern]) {
                  updateSetting('modelReasoningEffort', { ...settings.modelReasoningEffort, [pattern]: 'high' });
                  input.value = '';
                }
              }}
            >
              Add
            </button>
          </div>
        </div>
      </section>

      <section className="page-section">
        <h3>Logging</h3>
        <div className="settings-grid">
          <div className="setting-item checkbox">
            <label>
              <input
                type="checkbox"
                checked={settings?.requestLogging || false}
                onChange={(e) => updateSetting('requestLogging', e.target.checked)}
              />
              <span>Request Logging</span>
            </label>
            <p className="setting-hint">
              Log HTTP requests with method, path, status, and timing. View in the Logs page under Request Logs tab.
            </p>
          </div>
        </div>
      </section>

      <section className="page-section">
        <h3>Dashboard</h3>
        <div className="settings-grid">
          <div className="setting-item">
            <label htmlFor="fullscreenInterval">Fullscreen Cycle Interval</label>
            <p className="setting-hint">
              How long each page is displayed in fullscreen dashboard mode (in seconds).
            </p>
            <input
              type="number"
              id="fullscreenInterval"
              value={Math.round((settings?.fullscreenInterval || 30000) / 1000)}
              onChange={(e) => updateSetting('fullscreenInterval', parseInt(e.target.value) * 1000)}
              min={5}
              max={300}
            />
          </div>
        </div>
      </section>

      <LlamaCppUpdateSection />

      <section className="page-section">
        <h3>Current Configuration</h3>
        <pre className="settings-preview">
          {JSON.stringify(settings, null, 2)}
        </pre>
      </section>
    </div>
  );
}

// llama.cpp Update Section Component
function LlamaCppUpdateSection() {
  const [updating, setUpdating] = useState(false);
  const [status, setStatus] = useState(null);
  const [output, setOutput] = useState('');
  const outputRef = useRef(null);

  // Check initial status
  useEffect(() => {
    fetch(`${API_BASE}/llama/update/status`)
      .then(res => res.json())
      .then(data => {
        setStatus(data.status);
        setOutput(data.output || '');
        if (data.status === 'updating') {
          setUpdating(true);
        }
      })
      .catch(err => console.error('Failed to fetch update status:', err));
  }, []);

  // Subscribe to WebSocket updates
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'llama_update') {
          if (msg.data.output) {
            setOutput(prev => prev + msg.data.output);
          }
          if (msg.data.status && msg.data.status !== 'updating') {
            setStatus(msg.data.status);
            setUpdating(false);
          }
        }
      } catch (e) {
        // Ignore non-JSON messages
      }
    };

    return () => ws.close();
  }, []);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const startUpdate = async () => {
    setUpdating(true);
    setStatus('updating');
    setOutput('');
    try {
      const res = await fetch(`${API_BASE}/llama/update`, { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        setStatus('failed');
        setOutput(data.error || 'Failed to start update');
        setUpdating(false);
      }
    } catch (err) {
      setStatus('failed');
      setOutput('Failed to start update: ' + err.message);
      setUpdating(false);
    }
  };

  return (
    <section className="page-section">
      <h3>llama.cpp Updates</h3>
      <div className="setting-item">
        <p className="setting-hint">
          Pull the latest llama.cpp changes from GitHub and rebuild. This will stop any running llama server during the update.
        </p>
        <button
          className={`btn-secondary ${updating ? 'disabled' : ''}`}
          onClick={startUpdate}
          disabled={updating}
        >
          {updating ? 'Updating...' : 'Update llama.cpp'}
        </button>
        {status && status !== 'idle' && (
          <span className={`update-status ${status}`}>
            {status === 'updating' && ' Building...'}
            {status === 'success' && ' Update complete'}
            {status === 'failed' && ' Update failed'}
          </span>
        )}
      </div>
      {output && (
        <pre className="update-output" ref={outputRef}>
          {output}
        </pre>
      )}
    </section>
  );
}

// API Documentation Page
function ApiDocsPage() {
  const [activeEndpoint, setActiveEndpoint] = useState(null);
  const [params, setParams] = useState({});
  const [response, setResponse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('manager');
  const [openaiModels, setOpenaiModels] = useState([]);
  const [copiedCurl, setCopiedCurl] = useState(false);

  // Fetch models for OpenAI tab
  const fetchOpenaiModels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/v1/models`);
      if (res.ok) {
        const data = await res.json();
        setOpenaiModels(data.data || []);
      }
    } catch (err) {
      console.error('Failed to fetch OpenAI models:', err);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'openai') {
      fetchOpenaiModels();
    }
  }, [activeTab, fetchOpenaiModels]);

  // Generate curl example
  const generateCurlExample = useCallback((endpoint, currentParams) => {
    if (!endpoint) return '';

    const baseUrl = window.location.origin;
    let url = baseUrl + endpoint.path;

    // Handle path params
    for (const param of endpoint.params) {
      if (param.type === 'path' && currentParams[param.name]) {
        url = url.replace(`:${param.name}`, encodeURIComponent(currentParams[param.name]));
      }
    }

    // Handle query params
    const queryParams = endpoint.params
      .filter(p => p.type === 'query' && currentParams[p.name] !== undefined && currentParams[p.name] !== '')
      .map(p => `${p.name}=${encodeURIComponent(currentParams[p.name])}`);
    if (queryParams.length) url += '?' + queryParams.join('&');

    // Build curl command
    let curl = `curl -X ${endpoint.method} "${url}"`;

    if (endpoint.method !== 'GET') {
      curl += ` \\\n  -H "Content-Type: application/json"`;

      const bodyParams = {};
      for (const param of endpoint.params) {
        if (!['path', 'query'].includes(param.type) && currentParams[param.name] !== undefined && currentParams[param.name] !== '') {
          bodyParams[param.name] = currentParams[param.name];
        }
      }

      if (Object.keys(bodyParams).length) {
        curl += ` \\\n  -d '${JSON.stringify(bodyParams, null, 2).replace(/\n/g, '\n  ')}'`;
      }
    }

    return curl;
  }, []);

  const copyCurl = async () => {
    const curl = generateCurlExample(activeEndpoint, params);
    try {
      await copyTextToClipboard(curl);
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const managerEndpoints = [
    {
      id: 'get-status',
      method: 'GET',
      path: '/api/status',
      description: 'Get server status including llama health, mode, and downloads',
      params: [],
      example: null
    },
    {
      id: 'get-models',
      method: 'GET',
      path: '/api/models',
      description: 'List all local and server-loaded models',
      params: [],
      example: null
    },
    {
      id: 'load-model',
      method: 'POST',
      path: '/api/models/load',
      description: 'Load a model into the llama server',
      params: [
        { name: 'model', type: 'string', required: true, description: 'Model name or path to load' }
      ],
      example: { model: 'Qwen_Qwen2.5-Coder-32B-Instruct-GGUF/qwen2.5-coder-32b-instruct-q5_k_m.gguf' }
    },
    {
      id: 'unload-model',
      method: 'POST',
      path: '/api/models/unload',
      description: 'Unload a model from the llama server',
      params: [
        { name: 'model', type: 'string', required: true, description: 'Model ID to unload' }
      ],
      example: { model: 'model-id' }
    },
    {
      id: 'get-settings',
      method: 'GET',
      path: '/api/settings',
      description: 'Get current server settings',
      params: [],
      example: null
    },
    {
      id: 'update-settings',
      method: 'POST',
      path: '/api/settings',
      description: 'Update server settings',
      params: [
        { name: 'contextSize', type: 'number', required: false, description: 'Context window size (512-262144)' },
        { name: 'modelsMax', type: 'number', required: false, description: 'Max loaded models (1-10)' },
        { name: 'gpuLayers', type: 'number', required: false, description: 'GPU layers (0-999)' },
        { name: 'autoStart', type: 'boolean', required: false, description: 'Auto-start server on manager start' },
        { name: 'noWarmup', type: 'boolean', required: false, description: 'Skip model warmup' },
        { name: 'flashAttn', type: 'boolean', required: false, description: 'Enable flash attention' }
      ],
      example: { contextSize: 8192, modelsMax: 2 }
    },
    {
      id: 'start-server',
      method: 'POST',
      path: '/api/server/start',
      description: 'Start the llama server in router mode',
      params: [],
      example: null
    },
    {
      id: 'stop-server',
      method: 'POST',
      path: '/api/server/stop',
      description: 'Stop the llama server',
      params: [],
      example: null
    },
    {
      id: 'get-presets',
      method: 'GET',
      path: '/api/presets',
      description: 'List available optimized presets',
      params: [],
      example: null
    },
    {
      id: 'activate-preset',
      method: 'POST',
      path: '/api/presets/:presetId/activate',
      description: 'Activate an optimized preset (single-model mode)',
      params: [
        { name: 'presetId', type: 'path', required: true, description: 'Preset ID (e.g., gpt120, qwen3, qwen2.5)' }
      ],
      example: null
    },
    {
      id: 'get-analytics',
      method: 'GET',
      path: '/api/analytics',
      description: 'Get time-series analytics data',
      params: [
        { name: 'minutes', type: 'query', required: false, description: 'Minutes of data to retrieve (default: 5)' }
      ],
      example: null
    },
    {
      id: 'get-processes',
      method: 'GET',
      path: '/api/processes',
      description: 'List running llama-server processes',
      params: [],
      example: null
    },
    {
      id: 'kill-process',
      method: 'POST',
      path: '/api/processes/:pid/kill',
      description: 'Kill a specific process by PID',
      params: [
        { name: 'pid', type: 'path', required: true, description: 'Process ID to kill' }
      ],
      example: null
    },
    {
      id: 'search-models',
      method: 'GET',
      path: '/api/search',
      description: 'Search HuggingFace for GGUF models',
      params: [
        { name: 'query', type: 'query', required: true, description: 'Search query' }
      ],
      example: null
    },
    {
      id: 'pull-model',
      method: 'POST',
      path: '/api/pull',
      description: 'Download a model from HuggingFace',
      params: [
        { name: 'repo', type: 'string', required: true, description: 'HuggingFace repo (e.g., Qwen/Qwen2.5-Coder-32B-Instruct-GGUF)' },
        { name: 'quantization', type: 'string', required: true, description: 'Quantization to download (e.g., Q5_K_M)' }
      ],
      example: { repo: 'Qwen/Qwen2.5-Coder-32B-Instruct-GGUF', quantization: 'Q5_K_M' }
    },
    {
      id: 'get-logs',
      method: 'GET',
      path: '/api/logs',
      description: 'Get server logs',
      params: [
        { name: 'limit', type: 'query', required: false, description: 'Max logs to return (default: 100)' }
      ],
      example: null
    }
  ];

  const openaiEndpoints = [
    {
      id: 'openai-models',
      method: 'GET',
      path: '/api/v1/models',
      description: 'List available models (OpenAI-compatible)',
      params: [],
      example: null
    },
    {
      id: 'openai-chat',
      method: 'POST',
      path: '/api/v1/chat/completions',
      description: 'Create a chat completion (OpenAI-compatible). Supports streaming.',
      params: [
        { name: 'model', type: 'string', required: true, description: 'Model ID to use' },
        { name: 'messages', type: 'json', required: true, description: 'Array of message objects with role and content' },
        { name: 'temperature', type: 'number', required: false, description: 'Sampling temperature (0-2)' },
        { name: 'max_tokens', type: 'number', required: false, description: 'Maximum tokens to generate' },
        { name: 'stream', type: 'boolean', required: false, description: 'Stream the response' },
        { name: 'top_p', type: 'number', required: false, description: 'Nucleus sampling parameter' },
        { name: 'frequency_penalty', type: 'number', required: false, description: 'Frequency penalty (-2 to 2)' },
        { name: 'presence_penalty', type: 'number', required: false, description: 'Presence penalty (-2 to 2)' }
      ],
      example: {
        model: 'model-id',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello!' }
        ],
        temperature: 0.7,
        max_tokens: 500
      }
    },
    {
      id: 'openai-completions',
      method: 'POST',
      path: '/api/v1/completions',
      description: 'Create a text completion (legacy OpenAI-compatible endpoint)',
      params: [
        { name: 'model', type: 'string', required: true, description: 'Model ID to use' },
        { name: 'prompt', type: 'string', required: true, description: 'The prompt to complete' },
        { name: 'max_tokens', type: 'number', required: false, description: 'Maximum tokens to generate' },
        { name: 'temperature', type: 'number', required: false, description: 'Sampling temperature' },
        { name: 'stream', type: 'boolean', required: false, description: 'Stream the response' }
      ],
      example: {
        model: 'model-id',
        prompt: 'Once upon a time',
        max_tokens: 100,
        temperature: 0.7
      }
    },
    {
      id: 'openai-embeddings',
      method: 'POST',
      path: '/api/v1/embeddings',
      description: 'Create embeddings for text (OpenAI-compatible)',
      params: [
        { name: 'model', type: 'string', required: true, description: 'Model ID to use' },
        { name: 'input', type: 'string', required: true, description: 'Text to embed (string or array of strings)' }
      ],
      example: {
        model: 'model-id',
        input: 'Hello world'
      }
    }
  ];

  const endpoints = activeTab === 'manager' ? managerEndpoints : openaiEndpoints;

  const handleParamChange = (name, value, type) => {
    let parsedValue = value;
    if (type === 'number' && value !== '') {
      parsedValue = parseFloat(value);
    } else if (type === 'boolean') {
      parsedValue = value === 'true';
    } else if (type === 'json') {
      try {
        parsedValue = JSON.parse(value);
      } catch {
        parsedValue = value;
      }
    }
    setParams(p => ({ ...p, [name]: parsedValue }));
  };

  const testEndpoint = async (endpoint) => {
    setLoading(true);
    setResponse(null);

    try {
      let url = endpoint.path;
      const queryParams = [];
      const bodyParams = {};

      // Process parameters
      for (const param of endpoint.params) {
        const value = params[param.name];
        if (value === undefined || value === '') continue;

        if (param.type === 'path') {
          url = url.replace(`:${param.name}`, encodeURIComponent(value));
        } else if (param.type === 'query') {
          queryParams.push(`${param.name}=${encodeURIComponent(value)}`);
        } else {
          bodyParams[param.name] = value;
        }
      }

      if (queryParams.length > 0) {
        url += '?' + queryParams.join('&');
      }

      const options = {
        method: endpoint.method,
        headers: { 'Content-Type': 'application/json' }
      };

      if (endpoint.method !== 'GET' && Object.keys(bodyParams).length > 0) {
        options.body = JSON.stringify(bodyParams);
      }

      const startTime = Date.now();
      const res = await fetch(url, options);
      const duration = Date.now() - startTime;

      let data;
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        data = await res.json();
      } else {
        data = await res.text();
      }

      setResponse({
        status: res.status,
        statusText: res.statusText,
        duration,
        data
      });
    } catch (err) {
      setResponse({
        status: 'Error',
        statusText: err.message,
        duration: 0,
        data: null
      });
    }

    setLoading(false);
  };

  const selectEndpoint = (endpoint) => {
    setActiveEndpoint(endpoint);
    setResponse(null);
    // Pre-fill with example if available
    if (endpoint.example) {
      const newParams = {};
      for (const [key, value] of Object.entries(endpoint.example)) {
        newParams[key] = typeof value === 'object' ? JSON.stringify(value, null, 2) : value;
      }
      setParams(newParams);
    } else {
      setParams({});
    }
  };

  return (
    <div className="page api-docs-page">
      <div className="page-header">
        <h2>API Documentation</h2>
      </div>

      <p className="page-description">
        Interactive API documentation for Llama Manager. Test endpoints directly from this page.
      </p>

      <div className="api-tabs">
        <button
          className={`api-tab ${activeTab === 'manager' ? 'active' : ''}`}
          onClick={() => { setActiveTab('manager'); setActiveEndpoint(null); setResponse(null); }}
        >
          Manager API
        </button>
        <button
          className={`api-tab ${activeTab === 'openai' ? 'active' : ''}`}
          onClick={() => { setActiveTab('openai'); setActiveEndpoint(null); setResponse(null); }}
        >
          OpenAI API (v1)
        </button>
      </div>

      <div className="api-docs-layout">
        {/* Endpoints List */}
        <div className="api-endpoints-list">
          <h3>{activeTab === 'manager' ? 'Manager Endpoints' : 'OpenAI-Compatible Endpoints'}</h3>
          {activeTab === 'openai' && (
            <p className="api-base-url">Base URL: <code>/api/v1</code></p>
          )}
          <div className="endpoints-list">
            {endpoints.map(endpoint => (
              <div
                key={endpoint.id}
                className={`endpoint-item ${activeEndpoint?.id === endpoint.id ? 'active' : ''}`}
                onClick={() => selectEndpoint(endpoint)}
              >
                <span className={`method-badge ${endpoint.method.toLowerCase()}`}>
                  {endpoint.method}
                </span>
                <span className="endpoint-path">{endpoint.path}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Endpoint Details & Testing */}
        <div className="api-endpoint-detail">
          {activeEndpoint ? (
            <>
              <div className="endpoint-header">
                <span className={`method-badge large ${activeEndpoint.method.toLowerCase()}`}>
                  {activeEndpoint.method}
                </span>
                <code className="endpoint-path-large">{activeEndpoint.path}</code>
              </div>

              <p className="endpoint-description">{activeEndpoint.description}</p>

              {/* Parameters Form */}
              {activeEndpoint.params.length > 0 && (
                <div className="params-section">
                  <h4>Parameters</h4>
                  <div className="params-form">
                    {activeEndpoint.params.map(param => (
                      <div key={param.name} className="param-field">
                        <label>
                          <span className="param-name">{param.name}</span>
                          {param.required && <span className="param-required">*</span>}
                          <span className="param-type">{param.type}</span>
                        </label>
                        <p className="param-description">{param.description}</p>
                        {param.type === 'boolean' ? (
                          <select
                            value={params[param.name] ?? ''}
                            onChange={(e) => handleParamChange(param.name, e.target.value, 'boolean')}
                          >
                            <option value="">-- Select --</option>
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        ) : param.type === 'json' ? (
                          <textarea
                            value={params[param.name] ?? ''}
                            onChange={(e) => handleParamChange(param.name, e.target.value, 'json')}
                            placeholder={`Enter JSON...`}
                            rows={4}
                          />
                        ) : param.name === 'model' && activeTab === 'openai' && openaiModels.length > 0 ? (
                          <SearchableSelect
                            value={params[param.name] ?? ''}
                            onChange={(val) => handleParamChange(param.name, val, 'string')}
                            options={openaiModels.map(m => ({ value: m.id, label: m.id }))}
                            placeholder="-- Select model --"
                            storageKey="lastApiDocsModel"
                          />
                        ) : (
                          <input
                            type={param.type === 'number' ? 'number' : 'text'}
                            value={params[param.name] ?? ''}
                            onChange={(e) => handleParamChange(param.name, e.target.value, param.type)}
                            placeholder={param.type === 'path' ? `Enter ${param.name}...` : `Enter value...`}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* curl Example */}
              {activeEndpoint && (
                <div className="curl-section">
                  <h4>
                    curl Example
                    <button
                      className={`curl-copy-btn ${copiedCurl ? 'copied' : ''}`}
                      onClick={copyCurl}
                    >
                      {copiedCurl ? 'Copied!' : 'Copy'}
                    </button>
                  </h4>
                  <div className="curl-code-container">
                    <pre className="curl-code">{generateCurlExample(activeEndpoint, params)}</pre>
                  </div>
                </div>
              )}

              {/* Test Button */}
              <div className="test-section">
                <button
                  className="btn-primary"
                  onClick={() => testEndpoint(activeEndpoint)}
                  disabled={loading}
                >
                  {loading ? 'Sending...' : 'Send Request'}
                </button>
              </div>

              {/* Response */}
              {response && (
                <div className="response-section">
                  <h4>Response</h4>
                  <div className={`response-status ${response.status >= 200 && response.status < 300 ? 'success' : 'error'}`}>
                    <span className="status-code">{response.status}</span>
                    <span className="status-text">{response.statusText}</span>
                    <span className="response-time">{response.duration}ms</span>
                  </div>
                  <pre className="response-body">
                    {typeof response.data === 'object'
                      ? JSON.stringify(response.data, null, 2)
                      : response.data || 'No response body'}
                  </pre>
                </div>
              )}

              {/* Example */}
              {activeEndpoint.example && (
                <div className="example-section">
                  <h4>Example Request Body</h4>
                  <pre className="example-code">
                    {JSON.stringify(activeEndpoint.example, null, 2)}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <div className="no-endpoint-selected">
              <p>Select an endpoint from the list to view details and test it.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Compact Stats Header
function StatsHeader({ stats }) {
  const [showDownloads, setShowDownloads] = useState(false);
  const [expandedDownload, setExpandedDownload] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const dropdownRef = useRef(null);
  const isHealthy = stats?.llama?.status === 'ok';

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
    <div className="stats-header">
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

            {stats.gpu.temperature > 0 && (
              <div className="stats-header-item temp" title="GPU Temperature">
                <span className="stats-header-temp">{stats.gpu.temperature}°</span>
                <span className="stats-header-label">Temp</span>
              </div>
            )}
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
              className={`downloads-btn ${hasErrors ? 'has-errors' : ''} ${activeDownloads.length > 0 ? 'active' : ''}`}
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
              <div className="downloads-dropdown">
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
                              className="download-clear-btn"
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
                                    className="download-copy-btn"
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
        <NavLink to="/settings" className="stats-header-settings" title="Settings">
          <span>&#x2699;</span>
        </NavLink>
      </div>
    </div>
  );
}

// Query Panel Component
function QueryPanel({ stats }) {
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState(() => {
    return localStorage.getItem('lastSelectedModel') || '';
  });
  const [prompt, setPrompt] = useState('');
  const [conversationId, setConversationId] = useState(null); // Track current conversation
  const [messages, setMessages] = useState([]); // Each message: { role, content, stats? }
  const [isLoading, setIsLoading] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState('');
  const [hoveredMessage, setHoveredMessage] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [copiedId, setCopiedId] = useState(null);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  const copyToClipboard = async (text, messageId) => {
    try {
      await copyTextToClipboard(text);
      setCopiedId(messageId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // Save conversation to shared localStorage (same as ChatPage)
  const saveToSharedHistory = (convId, title, model, msgs) => {
    try {
      const saved = localStorage.getItem('chat_conversations');
      const conversations = saved ? JSON.parse(saved) : [];
      const existingIndex = conversations.findIndex(c => c.id === convId);
      const conversation = {
        id: convId,
        title: title,
        model: model,
        messages: msgs.map(m => ({
          id: m.id?.toString() || Date.now().toString(),
          role: m.role,
          content: m.content,
          timestamp: m.stats?.timestamp || new Date().toISOString(),
          stats: m.stats || null
        })),
        createdAt: existingIndex >= 0 ? conversations[existingIndex].createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (existingIndex >= 0) {
        conversations[existingIndex] = conversation;
      } else {
        conversations.unshift(conversation);
      }
      localStorage.setItem('chat_conversations', JSON.stringify(conversations));
    } catch (err) {
      console.error('Failed to save conversation:', err);
    }
  };

  // Fetch available models from our API (all local models)
  const fetchModels = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/v1/models`);
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
  }, [selectedModel]);

  useEffect(() => {
    if (isOpen) {
      fetchModels();
    }
  }, [isOpen, fetchModels]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingMessage]);

  // Hide on chat page - use the full-featured chat there
  if (location.pathname === '/chat') {
    return null;
  }

  const handleModelChange = (e) => {
    const model = e.target.value;
    setSelectedModel(model);
    localStorage.setItem('lastSelectedModel', model);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!prompt.trim() || isLoading) return;

    // Create a new conversation if this is the first message
    let currentConvId = conversationId;
    const isFirstMessage = messages.length === 0;
    if (isFirstMessage) {
      currentConvId = `fab-${Date.now()}`;
      setConversationId(currentConvId);
    }

    const messageId = Date.now();
    const userMessage = { id: messageId, role: 'user', content: prompt.trim() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setPrompt('');
    setIsLoading(true);
    setStreamingMessage('');

    // Generate title from first message
    const title = isFirstMessage
      ? prompt.trim().slice(0, 50) + (prompt.trim().length > 50 ? '...' : '')
      : null;

    const startTime = Date.now();
    let tokenCount = 0;

    try {
      // Use our API wrapper to get stats tracking
      const response = await fetch(`${API_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: newMessages.map(m => ({ role: m.role, content: m.content })),
          stream: true
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let usage = null;
      let modelUsed = selectedModel;

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
              if (content) {
                fullContent += content;
                tokenCount++;
                setStreamingMessage(fullContent);
              }
              // Capture usage stats if provided
              if (parsed.usage) {
                usage = parsed.usage;
              }
              if (parsed.model) {
                modelUsed = parsed.model;
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }

      const duration = Date.now() - startTime;
      const tokensPerSecond = duration > 0 ? (tokenCount / (duration / 1000)) : 0;

      const messageStats = {
        model: modelUsed,
        promptTokens: usage?.prompt_tokens || 0,
        completionTokens: usage?.completion_tokens || tokenCount,
        totalTokens: (usage?.prompt_tokens || 0) + (usage?.completion_tokens || tokenCount),
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
        duration: Math.round(duration),
        timestamp: new Date().toISOString()
      };

      const assistantMessage = {
        id: Date.now(),
        role: 'assistant',
        content: fullContent,
        stats: messageStats
      };

      const finalMessages = [...newMessages, assistantMessage];
      setMessages(finalMessages);
      setStreamingMessage('');

      // Save to shared history so ChatPage can see it
      const convTitle = title || (messages.length === 0 ? prompt.trim().slice(0, 50) : 'Quick Chat');
      saveToSharedHistory(currentConvId, convTitle, selectedModel, finalMessages);
    } catch (err) {
      console.error('Query failed:', err);
      setMessages(prev => [...prev, {
        id: Date.now(),
        role: 'assistant',
        content: `Error: ${err.message}`,
        stats: null
      }]);
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
    setHoveredMessage(null);
    setConversationId(null); // Start fresh conversation next time
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
            <SearchableSelect
              value={selectedModel}
              onChange={(val) => {
                setSelectedModel(val);
                localStorage.setItem('queryPanelModel', val);
              }}
              options={models.length === 0 ? [] : models.map(m => ({
                value: m.id || m.model,
                label: formatModelName(m)
              }))}
              placeholder={models.length === 0 ? "No models available" : "Select model..."}
              disabled={!isHealthy || models.length === 0}
              storageKey="queryPanelModel"
            />
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
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`query-message ${msg.role}`}
            >
              <div className="message-header">
                <span className="message-role">
                  {msg.role === 'user' ? 'You' : `AI${msg.stats?.model ? ` - ${formatModelName({ id: msg.stats.model })}` : ''}`}
                </span>
                <div className="message-actions">
                  <button
                    className={`btn-icon ${copiedId === msg.id ? 'copied' : ''}`}
                    onClick={() => copyToClipboard(msg.content, msg.id)}
                    title="Copy to clipboard"
                  >
                    {copiedId === msg.id ? '✓' : '📋'}
                  </button>
                </div>
              </div>
              <div className="message-content">{parseMessageWithCodeBlocks(msg.content)}</div>
              {msg.role === 'assistant' && msg.stats && (
                <div className="message-stats-inline">
                  {msg.stats.tokensPerSecond} tok/s · {msg.stats.completionTokens} tokens · {(msg.stats.duration / 1000).toFixed(2)}s
                </div>
              )}
            </div>
          ))}
          {streamingMessage && (
            <div className="query-message assistant streaming">
              <div className="message-header">
                <span className="message-role">AI{selectedModel ? ` - ${formatModelName({ id: selectedModel })}` : ''}</span>
              </div>
              <div className="message-content">{parseMessageWithCodeBlocks(streamingMessage)}</div>
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

// Documentation Page
function DocsPage() {
  const [activeSection, setActiveSection] = useState('overview');
  const [copiedCode, setCopiedCode] = useState(null);
  const [models, setModels] = useState([]);

  // Fetch models for OpenCode config generation
  useEffect(() => {
    const fetchModels = async () => {
      try {
        const res = await fetch(`${API_BASE}/v1/models`);
        if (res.ok) {
          const data = await res.json();
          setModels(data.data || []);
        }
      } catch (err) {
        console.error('Failed to fetch models:', err);
      }
    };
    fetchModels();
  }, []);

  // Generate OpenCode config with all models
  const generateOpenCodeConfig = () => {
    const modelsConfig = {};
    models.forEach(model => {
      // Determine context limit based on model name
      let contextLimit = 32768;
      const modelLower = model.id.toLowerCase();
      if (modelLower.includes('128k') || modelLower.includes('131072')) {
        contextLimit = 131072;
      } else if (modelLower.includes('64k') || modelLower.includes('65536')) {
        contextLimit = 65536;
      } else if (modelLower.includes('32k') || modelLower.includes('32768')) {
        contextLimit = 32768;
      } else if (modelLower.includes('16k') || modelLower.includes('16384')) {
        contextLimit = 16384;
      } else if (modelLower.includes('8k') || modelLower.includes('8192')) {
        contextLimit = 8192;
      }

      modelsConfig[model.id] = {
        name: model.id.split('/').pop().replace(/-/g, ' ').replace(/\.gguf$/i, ''),
        limit: {
          context: contextLimit,
          output: 4096
        }
      };
    });

    return JSON.stringify({
      "$schema": "https://opencode.ai/config.json",
      provider: {
        "llama-manager": {
          npm: "@ai-sdk/openai-compatible",
          name: "Llama Manager",
          options: {
            baseURL: `${window.location.origin}/api/v1`
          },
          models: modelsConfig
        }
      }
    }, null, 2);
  };

  const copyCode = async (code, id) => {
    try {
      await copyTextToClipboard(code);
      setCopiedCode(id);
      setTimeout(() => setCopiedCode(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const CodeBlock = ({ code, language, id }) => (
    <div className="docs-code-block">
      <div className="docs-code-header">
        <span>{language}</span>
        <button
          className={`docs-copy-btn ${copiedCode === id ? 'copied' : ''}`}
          onClick={() => copyCode(code, id)}
        >
          {copiedCode === id ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );

  const sections = [
    { id: 'overview', title: 'Overview' },
    { id: 'opencode', title: 'OpenCode Setup' },
    { id: 'mcp-setup', title: 'MCP Setup' },
    { id: 'api-usage', title: 'API Usage' },
    { id: 'features', title: 'Features' },
  ];

  return (
    <div className="page docs-page">
      <div className="docs-layout">
        <nav className="docs-sidebar">
          <div className="docs-nav">
            {sections.map(section => (
              <button
                key={section.id}
                className={`docs-nav-item ${activeSection === section.id ? 'active' : ''}`}
                onClick={() => setActiveSection(section.id)}
              >
                {section.title}
              </button>
            ))}
          </div>
        </nav>

        <div className="docs-content">
          {activeSection === 'overview' && (
            <section className="docs-section">
              <h2>Overview</h2>
              <p>
                Llama Manager is a service for managing llama.cpp in multi-model router mode.
                It provides a web UI, REST API, and MCP server for AI agent integration.
              </p>

              <h3>Key Features</h3>
              <ul>
                <li><strong>Multi-model support</strong>: Load and unload models dynamically without restarting</li>
                <li><strong>Web UI</strong>: Modern React interface for model management and chat</li>
                <li><strong>OpenAI-compatible API</strong>: Drop-in replacement for OpenAI API clients</li>
                <li><strong>MCP Server</strong>: Integration with Claude Desktop and other AI agents</li>
                <li><strong>Real-time monitoring</strong>: GPU stats, logs, and performance analytics</li>
              </ul>

              <h3>Quick Start</h3>
              <CodeBlock
                id="quickstart"
                language="bash"
                code={`# Install and start
./install.sh
systemctl --user enable --now llama-manager

# Access the web UI
open http://localhost:5250`}
              />
            </section>
          )}

          {activeSection === 'opencode' && (
            <section className="docs-section">
              <h2>OpenCode Setup</h2>
              <p>
                Llama Manager works with <a href="https://opencode.ai" target="_blank" rel="noopener noreferrer">OpenCode</a> as
                an OpenAI-compatible provider.
              </p>

              <h3>Quick Setup Prompt</h3>
              <p>Paste this prompt into OpenCode to have it configure itself:</p>
              <CodeBlock
                id="opencode-prompt"
                language="text"
                code={`Configure yourself to use my local Llama Manager as a provider. Create or update opencode.json with:
- Provider ID: "llama-manager"
- Use @ai-sdk/openai-compatible
- Base URL: ${window.location.origin}/api/v1
- No API key needed (local server)

Then fetch the available models from ${window.location.origin}/api/v1/models and add them to the config.
Set reasonable context limits based on the model names (32k for most, 128k for models with "128k" in name).`}
              />

              <h3>Manual Configuration</h3>
              <p>Add to your <code>opencode.json</code>:</p>
              <CodeBlock
                id="opencode-config"
                language="json"
                code={`{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "llama-manager": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Llama Manager",
      "options": {
        "baseURL": "${window.location.origin}/api/v1"
      },
      "models": {
        "your-model-id": {
          "name": "Your Model Name",
          "limit": {
            "context": 32768,
            "output": 4096
          }
        }
      }
    }
  }
}`}
              />

              <h3>Your Configuration (Auto-Generated)</h3>
              {models.length > 0 ? (
                <>
                  <p>Copy this complete configuration with your {models.length} loaded model{models.length !== 1 ? 's' : ''}:</p>
                  <CodeBlock
                    id="opencode-auto-config"
                    language="json"
                    code={generateOpenCodeConfig()}
                  />
                </>
              ) : (
                <div className="docs-info-box">
                  <p>No models currently loaded. Load models in the <a href="/models">Models</a> page to generate a complete configuration.</p>
                </div>
              )}

              <h3>Get Model IDs Manually</h3>
              <p>You can also list models via API:</p>
              <CodeBlock
                id="opencode-models"
                language="bash"
                code={`curl ${window.location.origin}/api/v1/models`}
              />

              <h3>Configuration Options</h3>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Option</th>
                    <th>Value</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>npm</code></td>
                    <td><code>@ai-sdk/openai-compatible</code></td>
                    <td>AI SDK package for OpenAI-compatible APIs</td>
                  </tr>
                  <tr>
                    <td><code>baseURL</code></td>
                    <td><code>{window.location.origin}/api/v1</code></td>
                    <td>Llama Manager OpenAI-compatible endpoint</td>
                  </tr>
                  <tr>
                    <td><code>limit.context</code></td>
                    <td>Model-dependent</td>
                    <td>Max context window (check model specs)</td>
                  </tr>
                  <tr>
                    <td><code>limit.output</code></td>
                    <td><code>4096</code> typical</td>
                    <td>Max output tokens per request</td>
                  </tr>
                </tbody>
              </table>
            </section>
          )}

          {activeSection === 'mcp-setup' && (
            <section className="docs-section">
              <h2>MCP Setup</h2>
              <p>
                The MCP (Model Context Protocol) server allows AI agents like Claude Desktop
                to interact with Llama Manager programmatically.
              </p>

              <h3>Your Configuration (Copy & Paste)</h3>
              <p>Add to <code>~/.config/Claude/claude_desktop_config.json</code>:</p>
              <CodeBlock
                id="mcp-config"
                language="json"
                code={`{
  "mcpServers": {
    "llama-manager": {
      "command": "node",
      "args": ["${window.location.pathname.includes('/ui') ? window.location.origin.replace(/:\d+$/, '') : window.location.origin}/mcp/server.js"],
      "env": {
        "LLAMA_MANAGER_URL": "${window.location.origin}"
      }
    }
  }
}`}
              />
              <p className="docs-hint">
                Note: Replace the <code>args</code> path with the actual path to your llama-server installation if different.
              </p>

              <h3>Environment Variables</h3>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Variable</th>
                    <th>Your Value</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>LLAMA_MANAGER_URL</code></td>
                    <td><code>{window.location.origin}</code></td>
                    <td>Llama Manager API URL</td>
                  </tr>
                </tbody>
              </table>

              <h3>Available MCP Tools</h3>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td><code>llama_get_status</code></td><td>Get server status and health</td></tr>
                  <tr><td><code>llama_get_stats</code></td><td>Get CPU, memory, GPU statistics</td></tr>
                  <tr><td><code>llama_list_models</code></td><td>List available and loaded models</td></tr>
                  <tr><td><code>llama_load_model</code></td><td>Load a model into the server</td></tr>
                  <tr><td><code>llama_unload_model</code></td><td>Unload a model</td></tr>
                  <tr><td><code>llama_chat</code></td><td>Send chat completion requests</td></tr>
                  <tr><td><code>llama_search_models</code></td><td>Search HuggingFace for models</td></tr>
                  <tr><td><code>llama_download_model</code></td><td>Download models from HuggingFace</td></tr>
                  <tr><td><code>llama_start_server</code></td><td>Start the llama server</td></tr>
                  <tr><td><code>llama_stop_server</code></td><td>Stop the llama server</td></tr>
                  <tr><td><code>llama_get_settings</code></td><td>Get current server settings</td></tr>
                  <tr><td><code>llama_update_settings</code></td><td>Update server settings</td></tr>
                  <tr><td><code>llama_list_presets</code></td><td>List available presets</td></tr>
                  <tr><td><code>llama_activate_preset</code></td><td>Activate a preset</td></tr>
                  <tr><td><code>llama_get_processes</code></td><td>List running processes</td></tr>
                  <tr><td><code>llama_get_logs</code></td><td>Get recent server logs</td></tr>
                  <tr><td><code>llama_get_analytics</code></td><td>Get performance analytics</td></tr>
                </tbody>
              </table>
            </section>
          )}

          {activeSection === 'api-usage' && (
            <section className="docs-section">
              <h2>API Usage</h2>

              <h3>Base URLs</h3>
              <ul>
                <li><strong>Manager API</strong>: <code>{window.location.origin}/api</code></li>
                <li><strong>OpenAI API</strong>: <code>{window.location.origin}/api/v1</code></li>
              </ul>

              <h3>Authentication</h3>
              <p>No authentication is required. The API is designed for local use.</p>

              <h3>Chat Completion Example</h3>
              <CodeBlock
                id="chat-example"
                language="bash"
                code={`curl -X POST ${window.location.origin}/api/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "your-model-id",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "stream": true
  }'`}
              />

              <h3>List Models</h3>
              <CodeBlock
                id="list-models"
                language="bash"
                code={`curl ${window.location.origin}/api/models`}
              />

              <h3>Load Model</h3>
              <CodeBlock
                id="load-model"
                language="bash"
                code={`curl -X POST ${window.location.origin}/api/models/load \\
  -H "Content-Type: application/json" \\
  -d '{"model": "path/to/model.gguf"}'`}
              />

              <h3>OpenAI SDK Usage</h3>
              <CodeBlock
                id="openai-sdk"
                language="python"
                code={`from openai import OpenAI

client = OpenAI(
    base_url="${window.location.origin}/api/v1",
    api_key="not-needed"
)

response = client.chat.completions.create(
    model="your-model-id",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)`}
              />
            </section>
          )}

          {activeSection === 'features' && (
            <section className="docs-section">
              <h2>Features</h2>

              <h3>Router Mode (Default)</h3>
              <p>
                In router mode, multiple models can be loaded simultaneously. The server
                manages model loading/unloading with LRU eviction when hitting the max models limit.
              </p>
              <ul>
                <li>Dynamic model loading without server restart</li>
                <li>Configurable max loaded models (default: 2)</li>
                <li>Automatic model switching based on requests</li>
              </ul>

              <h3>Single-Model Mode</h3>
              <p>
                Activated via presets, single-model mode runs one model with optimized settings.
                Use this for maximum performance with a specific model.
              </p>

              <h3>Presets</h3>
              <p>
                Presets are pre-configured model settings optimized for specific use cases.
                They specify the model, quantization, context size, and other parameters.
              </p>

              <h3>Download Management</h3>
              <p>
                Download GGUF models directly from HuggingFace. The manager:
              </p>
              <ul>
                <li>Searches HuggingFace for GGUF models</li>
                <li>Lists available quantizations</li>
                <li>Downloads with progress tracking</li>
                <li>Supports split model files</li>
              </ul>

              <h3>Real-time Monitoring</h3>
              <p>
                The dashboard shows real-time stats via WebSocket:
              </p>
              <ul>
                <li>CPU and memory usage</li>
                <li>GPU temperature, power, and VRAM</li>
                <li>Token generation speed</li>
                <li>Context usage per model</li>
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

// Chat Page
function ChatPage({ stats }) {
  const [conversations, setConversations] = useState(() => {
    try {
      const saved = localStorage.getItem('chat_conversations');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [activeConversationId, setActiveConversationId] = useState(() => {
    try {
      return localStorage.getItem('chat_active_conversation') || null;
    } catch {
      return null;
    }
  });
  const [models, setModels] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState('');
  const [pendingImages, setPendingImages] = useState([]);
  const [hoveredMessage, setHoveredMessage] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [copiedId, setCopiedId] = useState(null);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);

  const activeConversation = conversations.find(c => c.id === activeConversationId);

  // Persist conversations
  useEffect(() => {
    localStorage.setItem('chat_conversations', JSON.stringify(conversations));
  }, [conversations]);

  useEffect(() => {
    if (activeConversationId) {
      localStorage.setItem('chat_active_conversation', activeConversationId);
    }
  }, [activeConversationId]);

  // Fetch models
  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/v1/models`);
      if (res.ok) {
        const data = await res.json();
        setModels(data.data || []);
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
    }
  }, []);

  useEffect(() => {
    fetchModels();
    const interval = setInterval(fetchModels, 10000);
    return () => clearInterval(interval);
  }, [fetchModels]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversation?.messages, streamingMessage]);

  const createConversation = () => {
    const newConv = {
      id: Date.now().toString(),
      title: 'New Chat',
      model: models[0]?.id || '',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setConversations(prev => [newConv, ...prev]);
    setActiveConversationId(newConv.id);
  };

  const deleteConversation = (id) => {
    setConversations(prev => prev.filter(c => c.id !== id));
    if (activeConversationId === id) {
      const remaining = conversations.filter(c => c.id !== id);
      setActiveConversationId(remaining[0]?.id || null);
    }
  };

  const updateConversation = (id, updates) => {
    setConversations(prev => prev.map(c =>
      c.id === id ? { ...c, ...updates, updatedAt: new Date().toISOString() } : c
    ));
  };

  const copyToClipboard = async (text, messageId) => {
    try {
      await copyTextToClipboard(text);
      setCopiedId(messageId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleImageUpload = (e) => {
    const files = Array.from(e.target.files);
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (event) => {
        setPendingImages(prev => [...prev, {
          id: Date.now() + Math.random(),
          name: file.name,
          url: event.target.result
        }]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const removePendingImage = (id) => {
    setPendingImages(prev => prev.filter(img => img.id !== id));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if ((!prompt.trim() && pendingImages.length === 0) || isLoading || !activeConversation) return;

    // Build message content
    let content;
    if (pendingImages.length > 0) {
      content = [];
      if (prompt.trim()) {
        content.push({ type: 'text', text: prompt.trim() });
      }
      pendingImages.forEach(img => {
        content.push({
          type: 'image_url',
          image_url: { url: img.url }
        });
      });
    } else {
      content = prompt.trim();
    }

    const userMessage = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: new Date().toISOString()
    };

    // Update title from first message
    if (activeConversation.messages.length === 0 && typeof content === 'string') {
      updateConversation(activeConversation.id, {
        title: content.slice(0, 50) + (content.length > 50 ? '...' : '')
      });
    }

    updateConversation(activeConversation.id, {
      messages: [...activeConversation.messages, userMessage]
    });

    setPrompt('');
    setPendingImages([]);
    setIsLoading(true);
    setStreamingMessage('');

    const startTime = Date.now();
    let tokenCount = 0;

    try {
      // Build messages array for API
      const apiMessages = [...activeConversation.messages, userMessage].map(m => ({
        role: m.role,
        content: m.content
      }));

      const response = await fetch(`${API_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: activeConversation.model,
          messages: apiMessages,
          stream: true
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let usage = null;
      let modelUsed = activeConversation.model;

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
              if (content) {
                fullContent += content;
                tokenCount++;
                setStreamingMessage(fullContent);
              }
              if (parsed.usage) usage = parsed.usage;
              if (parsed.model) modelUsed = parsed.model;
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }

      const duration = Date.now() - startTime;
      const tokensPerSecond = duration > 0 ? (tokenCount / (duration / 1000)) : 0;

      const assistantMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: fullContent,
        timestamp: new Date().toISOString(),
        stats: {
          model: modelUsed,
          promptTokens: usage?.prompt_tokens || 0,
          completionTokens: usage?.completion_tokens || tokenCount,
          totalTokens: (usage?.prompt_tokens || 0) + (usage?.completion_tokens || tokenCount),
          tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
          duration: Math.round(duration)
        }
      };

      updateConversation(activeConversation.id, {
        messages: [...activeConversation.messages, userMessage, assistantMessage]
      });
      setStreamingMessage('');
    } catch (err) {
      console.error('Chat failed:', err);
      const errorMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: `Error: ${err.message}`,
        timestamp: new Date().toISOString()
      };
      updateConversation(activeConversation.id, {
        messages: [...activeConversation.messages, userMessage, errorMessage]
      });
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
    if (activeConversation) {
      updateConversation(activeConversation.id, { messages: [] });
    }
    setStreamingMessage('');
    setHoveredMessage(null);
  };

  const isHealthy = stats?.llama?.status === 'ok';

  const formatTimestamp = (ts) => {
    const date = new Date(ts);
    const now = new Date();
    const diff = now - date;
    if (diff < 86400000) {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const renderMessageContent = (content) => {
    if (typeof content === 'string') {
      return parseMessageWithCodeBlocks(content);
    }
    // Multimodal content
    return content.map((part, i) => {
      if (part.type === 'text') {
        return <span key={i}>{parseMessageWithCodeBlocks(part.text)}</span>;
      }
      if (part.type === 'image_url') {
        return <img key={i} src={part.image_url.url} alt="User uploaded" className="message-image" />;
      }
      return null;
    });
  };

  return (
    <div className="page chat-page">
      <div className="chat-layout">
        {/* Conversations Sidebar */}
        <div className="chat-sidebar">
          <div className="chat-sidebar-header">
            <h3>Conversations</h3>
            <button className="btn-primary btn-small" onClick={createConversation}>
              + New
            </button>
          </div>
          <div className="conversation-list">
            {conversations.length === 0 ? (
              <div className="chat-empty-sidebar">
                <p>No conversations yet</p>
              </div>
            ) : (
              conversations.map(conv => (
                <div
                  key={conv.id}
                  className={`conversation-item ${conv.id === activeConversationId ? 'active' : ''}`}
                  onClick={() => setActiveConversationId(conv.id)}
                >
                  <div className="conv-title">{conv.title}</div>
                  <div className="conv-meta">
                    {formatTimestamp(conv.updatedAt)}
                    <button
                      className="conv-delete"
                      onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Main Chat Area */}
        <div className="chat-main">
          {activeConversation ? (
            <>
              <div className="chat-header">
                <SearchableSelect
                  value={activeConversation.model}
                  onChange={(val) => updateConversation(activeConversation.id, { model: val })}
                  options={models.length === 0 ? [] : models.map(m => ({
                    value: m.id,
                    label: formatModelName(m)
                  }))}
                  placeholder={models.length === 0 ? "No models available" : "Select model..."}
                  disabled={!isHealthy || models.length === 0}
                  storageKey="chatModel"
                />
                <button className="btn-ghost btn-small" onClick={clearChat} title="Clear chat">
                  Clear
                </button>
              </div>

              <div className="chat-messages">
                {activeConversation.messages.length === 0 && !streamingMessage && (
                  <div className="chat-empty">
                    <p>Send a message to start the conversation</p>
                    {!isHealthy && <p className="hint">Server is not running</p>}
                  </div>
                )}
                {activeConversation.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`chat-message ${msg.role}`}
                  >
                    <div className="message-header">
                      <span className="message-role">
                        {msg.role === 'user' ? 'You' : `AI${msg.stats?.model ? ` - ${formatModelName({ id: msg.stats.model })}` : ''}`}
                      </span>
                      <div className="message-actions">
                        <button
                          className={`btn-icon ${copiedId === msg.id ? 'copied' : ''}`}
                          onClick={() => copyToClipboard(
                            typeof msg.content === 'string' ? msg.content : msg.content.map(p => p.text || '').join(''),
                            msg.id
                          )}
                          title="Copy"
                        >
                          {copiedId === msg.id ? '✓' : '📋'}
                        </button>
                      </div>
                    </div>
                    <div className="message-content">{renderMessageContent(msg.content)}</div>
                    {msg.role === 'assistant' && msg.stats && (
                      <div className="message-stats-inline">
                        {msg.stats.tokensPerSecond} tok/s · {msg.stats.completionTokens} tokens · {(msg.stats.duration / 1000).toFixed(2)}s
                      </div>
                    )}
                  </div>
                ))}
                {streamingMessage && (
                  <div className="chat-message assistant streaming">
                    <div className="message-header">
                      <span className="message-role">AI{activeConversation.model ? ` - ${formatModelName({ id: activeConversation.model })}` : ''}</span>
                    </div>
                    <div className="message-content">{parseMessageWithCodeBlocks(streamingMessage)}</div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Pending Images */}
              {pendingImages.length > 0 && (
                <div className="pending-images">
                  {pendingImages.map(img => (
                    <div key={img.id} className="pending-image">
                      <img src={img.url} alt={img.name} />
                      <button onClick={() => removePendingImage(img.id)}>×</button>
                    </div>
                  ))}
                </div>
              )}

              <form className="chat-input-area" onSubmit={handleSubmit}>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleImageUpload}
                  accept="image/*"
                  multiple
                  style={{ display: 'none' }}
                />
                <button
                  type="button"
                  className="btn-ghost btn-small"
                  onClick={() => fileInputRef.current?.click()}
                  title="Upload image"
                >
                  📎
                </button>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={isHealthy ? "Type a message... (Enter to send)" : "Server not running"}
                  disabled={!isHealthy || isLoading}
                  rows={1}
                  className="chat-input"
                />
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={!isHealthy || isLoading || (!prompt.trim() && pendingImages.length === 0)}
                >
                  {isLoading ? '...' : '→'}
                </button>
              </form>
            </>
          ) : (
            <div className="chat-empty">
              <p>Select a conversation or create a new one</p>
              <button className="btn-primary" onClick={createConversation}>
                + New Conversation
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Main App
function App() {
  const { stats, logs, connected, clearLogs, requestLogs, clearRequestLogs, llmLogs, clearLlmLogs } = useWebSocket();

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
          <StatsHeader stats={stats} />
          <Routes>
            <Route path="/" element={<Dashboard stats={stats} />} />
            <Route path="/chat" element={<ChatPage stats={stats} />} />
            <Route path="/presets" element={<PresetsPage stats={stats} />} />
            <Route path="/models" element={<ModelsPage stats={stats} />} />
            <Route path="/download" element={<DownloadPage stats={stats} />} />
            <Route path="/logs" element={<LogsPage logs={logs} clearLogs={clearLogs} requestLogs={requestLogs} clearRequestLogs={clearRequestLogs} llmLogs={llmLogs} clearLlmLogs={clearLlmLogs} />} />
            <Route path="/processes" element={<ProcessesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/docs" element={<DocsPage />} />
            <Route path="/api-docs" element={<ApiDocsPage />} />
          </Routes>
        </main>
        <QueryPanel stats={stats} />
      </div>
    </BrowserRouter>
  );
}

export default App;
