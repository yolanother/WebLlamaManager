// Llama Manager — logs page.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Displays manager, request, and LLM logs with filtering, detail inspection,
// copying, and clearing controls.

import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { API_BASE, copyTextToClipboard } from '../api.js';
import { CodeBlock, parseMessageWithCodeBlocks } from '../components/CodeBlock.jsx';

// Logs Page
function LogsPage({ logs, clearLogs, requestLogs, clearRequestLogs, llmLogs, clearLlmLogs }) {
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [showFiltersPanel, setShowFiltersPanel] = useState(false);
  const [logFilters, setLogFilters] = useState({ defaultFilters: [], customFilters: [] });
  const [newFilterPattern, setNewFilterPattern] = useState('');
  // LLM tab structured filters (model + backend dropdowns). Empty = no filter.
  const [llmModelFilter, setLlmModelFilter] = useState('');
  const [llmBackendFilter, setLlmBackendFilter] = useState('');
  // Endpoint scope for the LLM tab. Embedding requests are recorded as LLM logs but
  // carry no conversation (no messages/prompt/response), so they read as "non-LLM"
  // noise — default to conversations only and let the user opt into embeddings/all.
  const [llmEndpointFilter, setLlmEndpointFilter] = useState('conversations');
  // Drive the active tab off the URL so /logs/llm, /logs/requests, /logs/server
  // each survive page navigation + refresh. Falls back to 'server' if no segment.
  const { tab: urlTab } = useParams();
  const navigate = useNavigate();
  const VALID_TABS = ['server', 'requests', 'llm'];
  const activeTab = VALID_TABS.includes(urlTab) ? urlTab : 'server';
  const setActiveTab = (next) => {
    if (!VALID_TABS.includes(next)) next = 'server';
    navigate(next === 'server' ? '/logs' : `/logs/${next}`, { replace: false });
  };
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
    // Dedupe by id across BOTH sources and within each (the server can emit the same
    // entry twice — e.g. a backfill replays an id). A Map keyed by id keeps the first
    // seen position (chronological) while letting the live WS copy win on value, so the
    // list never renders duplicate React keys (which silently mis-render cards).
    const byId = new Map();
    let autoKey = 0;
    for (const l of fetchedLlmLogs) byId.set(l.id ?? `h${autoKey++}`, l);
    for (const l of llmLogs) byId.set(l.id ?? `w${autoKey++}`, l);
    return [...byId.values()].slice(-50);
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

  // Build unique value lists for the model/backend dropdowns from the current
  // log set. Re-derived whenever the underlying logs change.
  const llmModelOptions = React.useMemo(() => {
    const set = new Set();
    for (const l of allLlmLogs) if (l.model) set.add(l.model);
    return [...set].sort();
  }, [allLlmLogs]);
  const llmBackendOptions = React.useMemo(() => {
    const set = new Set();
    for (const l of allLlmLogs) set.add(l.backend || 'local');
    return [...set].sort();
  }, [allLlmLogs]);

  const filteredLlmLogs = React.useMemo(() => {
    return allLlmLogs.filter(log => {
      // Endpoint scope: embeddings carry no conversation, so hide them unless asked.
      const isEmbedding = log.endpoint === 'embeddings';
      if (llmEndpointFilter === 'conversations' && isEmbedding) return false;
      if (llmEndpointFilter === 'embeddings' && !isEmbedding) return false;
      // Model dropdown filter (exact match on dropdown value)
      if (llmModelFilter && log.model !== llmModelFilter) return false;
      // Backend dropdown filter
      if (llmBackendFilter && (log.backend || 'local') !== llmBackendFilter) return false;
      // Free-text filter searches model, response, messages, prompt
      if (filter) {
        const q = filter.toLowerCase();
        const hit =
          (log.model || '').toLowerCase().includes(q) ||
          (log.response || '').toLowerCase().includes(q) ||
          (log.messages || []).some(m =>
            (typeof m.content === 'string' ? m.content : '').toLowerCase().includes(q)
          ) ||
          (log.prompt || '').toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [allLlmLogs, filter, llmModelFilter, llmBackendFilter, llmEndpointFilter]);

  // Count embeddings currently hidden by the conversations-only default, so the
  // endpoint dropdown can surface them instead of silently dropping entries.
  const llmEmbeddingCount = React.useMemo(
    () => allLlmLogs.reduce((n, l) => n + (l.endpoint === 'embeddings' ? 1 : 0), 0),
    [allLlmLogs]
  );

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
            <>
              <select
                className="logs-filter-select"
                value={llmEndpointFilter}
                onChange={(e) => setLlmEndpointFilter(e.target.value)}
                title="Filter by request type. Embeddings have no conversation, so they are hidden by default."
              >
                <option value="conversations">Conversations</option>
                <option value="all">All requests</option>
                <option value="embeddings">Embeddings{llmEmbeddingCount ? ` (${llmEmbeddingCount})` : ''}</option>
              </select>
              <select
                className="logs-filter-select"
                value={llmModelFilter}
                onChange={(e) => setLlmModelFilter(e.target.value)}
                title="Filter by model"
              >
                <option value="">All models</option>
                {llmModelOptions.map(m => (
                  <option key={m} value={m}>{m.length > 32 ? m.slice(0, 30) + '…' : m}</option>
                ))}
              </select>
              <select
                className="logs-filter-select"
                value={llmBackendFilter}
                onChange={(e) => setLlmBackendFilter(e.target.value)}
                title="Filter by backend / host"
              >
                <option value="">All backends</option>
                {llmBackendOptions.map(b => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
              {(llmModelFilter || llmBackendFilter || llmEndpointFilter !== 'conversations') && (
                <button
                  className="btn-secondary"
                  onClick={() => { setLlmModelFilter(''); setLlmBackendFilter(''); setLlmEndpointFilter('conversations'); }}
                  title="Reset endpoint/model/backend filters"
                >
                  Clear filters
                </button>
              )}
              <button className="btn-secondary" onClick={handleClearLlmLogs}>
                Clear
              </button>
            </>
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
                    <th>Backend</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRequestLogs.map((log, i) => {
                    const hasError = log.error && log.status >= 400;
                    const hasRetries = log.retries > 0;
                    const isExpandable = hasError || hasRetries;
                    const isExpanded = expandedRequestLogs.has(log.id);
                    return (
                      <React.Fragment key={log.id || i}>
                        <tr
                          className={`${getStatusClass(log.status)} ${isExpandable ? 'clickable' : ''} ${hasRetries && !hasError ? 'has-retries' : ''}`}
                          onClick={() => isExpandable && setExpandedRequestLogs(prev => {
                            const next = new Set(prev);
                            if (next.has(log.id)) next.delete(log.id); else next.add(log.id);
                            return next;
                          })}
                        >
                          <td className="log-time">
                            {isExpandable && <span className="request-expand">{isExpanded ? '\u25BC' : '\u25B6'}</span>}
                            {formatTime(log.timestamp)}
                          </td>
                          <td className="request-method">{log.method}</td>
                          <td className="request-path" title={log.path}>{log.path}</td>
                          <td className={`request-status ${getStatusClass(log.status)}`}>
                            {log.status}
                            {hasRetries && (
                              <span className="retry-badge" title={`${log.retries} ${log.retries === 1 ? 'retry' : 'retries'}${log.restarted ? ' + restart' : ''}`}>
                                {log.retries}R{log.restarted ? '+S' : ''}
                              </span>
                            )}
                          </td>
                          <td className="request-duration">{log.duration}ms</td>
                          <td className="request-model">{log.model || '-'}</td>
                          <td className="request-backend">{log.backend && log.backend !== 'local' ? (
                            <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: '3px', fontSize: '0.8em', background: '#2d1b69', color: '#a78bfa' }}>{log.backend}</span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.85em' }}>local</span>
                          )}</td>
                        </tr>
                        {isExpanded && (
                          <tr className="request-error-row">
                            <td colSpan="6">
                              {hasRetries && (
                                <div className="request-retry-details">
                                  <div className="retry-summary">
                                    <strong>{log.retries} {log.retries === 1 ? 'retry' : 'retries'}</strong>
                                    {log.restarted && <span className="restart-badge">server restarted</span>}
                                    <span className="retry-outcome">{'\u2192'} final status: {log.status}</span>
                                  </div>
                                  {log.retryErrors && log.retryErrors.length > 0 && (
                                    <div className="retry-errors-list">
                                      {log.retryErrors.map((err, j) => (
                                        <div key={j} className="retry-error-item">
                                          <span className="retry-attempt">attempt {j + 1}</span>
                                          <span className="retry-error-msg">{err}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                              {hasError && (
                                <div className="request-error-content">{log.error}</div>
                              )}
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
              {llmEndpointFilter === 'conversations' && llmEmbeddingCount > 0 ? (
                <>
                  <p>No conversations to show</p>
                  <p className="hint">
                    {llmEmbeddingCount} embedding {llmEmbeddingCount === 1 ? 'request is' : 'requests are'} hidden.
                    Switch the request-type filter to “Embeddings” or “All requests” to see them.
                  </p>
                </>
              ) : (
                <>
                  <p>No LLM conversation logs yet</p>
                  <p className="hint">Send a request via Chat or any API endpoint to see conversations here</p>
                </>
              )}
            </div>
          ) : (
            <div className="llm-logs-list">
              {filteredLlmLogs.map((log) => {
                const isExpanded = expandedLlmLogs.has(log.id);
                const isError = log.status >= 400 || !!log.error;
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
                      {log.backend && log.backend !== 'local' && <span className="llm-log-badge" style={{ background: 'var(--info-bg, #1a2a3a)', color: 'var(--info, #60a5fa)' }}>{log.backend}</span>}
                      {log.stream && <span className="llm-log-badge stream">stream</span>}
                      {log.retries > 0 && <span className="llm-log-badge retry">{log.retries} {log.retries === 1 ? 'retry' : 'retries'}</span>}
                      {isError && <span className="llm-log-badge error">{log.status || 'ERR'}</span>}
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
                        <div className={`llm-log-response-section ${isError ? 'has-error' : ''}`}>
                          <div className="llm-log-section-title">
                            Response
                            {log.response && (
                              <button
                                className="copy-field-btn"
                                onClick={(e) => { e.stopPropagation(); handleCopyField(log.response, `resp-${log.id}`); }}
                              >{copiedField === `resp-${log.id}` ? 'Copied' : 'Copy'}</button>
                            )}
                          </div>
                          <div className="llm-log-response-content">
                            {log.response
                              ? parseMessageWithCodeBlocks(log.response)
                              : <span className="llm-log-empty">{isError ? 'No response (request failed)' : 'No response captured'}</span>
                            }
                          </div>
                        </div>
                        {log.retries > 0 && (
                          <div className="llm-log-retry-section">
                            <div className="llm-log-section-title">Retries</div>
                            <div className="llm-log-retry-content">
                              <span>Retried {log.retries} time{log.retries !== 1 ? 's' : ''} before {log.error ? 'failing' : 'succeeding'}</span>
                              {log.retryErrors && log.retryErrors.length > 0 && (
                                <ul className="llm-log-retry-errors">
                                  {log.retryErrors.map((err, ri) => (
                                    <li key={ri}><span className="retry-attempt">Attempt {ri + 1}:</span> {err.slice(0, 300)}</li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          </div>
                        )}
                        {isError && (
                          <div className="llm-log-error-section">
                            <div className="llm-log-section-title">
                              Error
                              {log.error && (
                                <button
                                  className="copy-field-btn"
                                  onClick={(e) => { e.stopPropagation(); handleCopyField(log.error, `error-${log.id}`); }}
                                >{copiedField === `error-${log.id}` ? 'Copied' : 'Copy'}</button>
                              )}
                            </div>
                            <div className="llm-log-error-content">{log.error || `Status ${log.status || 'unknown'}`}</div>
                          </div>
                        )}
                        {(log.requestBody || (isError && (log.messages || log.prompt))) && (() => {
                          const displayBody = log.requestBody || {
                            model: log.model,
                            ...(log.messages ? { messages: log.messages } : {}),
                            ...(log.prompt ? { prompt: log.prompt } : {}),
                            ...(log.stream ? { stream: true } : {})
                          };
                          return (
                          <div className="llm-log-request-body-section">
                            <div className="llm-log-section-title">
                              {log.requestBody ? 'Full Request Body' : 'Request (reconstructed)'}
                              <button
                                className="copy-field-btn"
                                onClick={(e) => { e.stopPropagation(); handleCopyField(JSON.stringify(displayBody, null, 2), `body-${log.id}`); }}
                              >{copiedField === `body-${log.id}` ? 'Copied' : 'Copy'}</button>
                            </div>
                            <pre className="llm-log-request-body">{JSON.stringify(displayBody, null, 2)}</pre>
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
                          );
                        })()}
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

export default LogsPage;
