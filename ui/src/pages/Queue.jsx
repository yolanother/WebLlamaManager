// Llama Manager — request queue page.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Displays active and pending requests and provides request cancellation and
// queue management controls.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { API_BASE } from '../api.js';
import { parseMessageWithCodeBlocks } from '../components/CodeBlock.jsx';
import { StatCard } from '../components/util.jsx';

// Queue Management Page
function QueuePage({ stats, activeRequestsMap }) {
  const [queueData, setQueueData] = useState({ items: [], concurrency: 1, totalQueued: 0 });
  const [cancelling, setCancelling] = useState(new Set());
  const [expandedId, setExpandedId] = useState(null);
  const [expandedSysMsgs, setExpandedSysMsgs] = useState(new Set());
  const [watchData, setWatchData] = useState(null); // SSE live data for expanded request
  const responseRef = useRef(null);
  const eventSourceRef = useRef(null);

  // Auto-scroll expanded response
  useEffect(() => {
    if (expandedId && responseRef.current) {
      responseRef.current.scrollTop = responseRef.current.scrollHeight;
    }
  });

  // SSE connection for watching expanded active request
  useEffect(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setWatchData(null);

    if (!expandedId) return;

    // expandedId IS the activeRequestId (queue API uses ar.id for both)
    const arId = expandedId;

    const es = new EventSource(`${API_BASE}/queue/watch/${arId}`);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.event === 'init') {
          setWatchData(data);
        } else if (data.event === 'update') {
          setWatchData(prev => prev ? { ...prev, ...data, status: 'processing' } : { ...data, status: 'processing' });
        } else if (data.event === 'end') {
          setWatchData(prev => prev ? { ...prev, ...data } : data);
          es.close();
        }
      } catch { /* skip parse errors */ }
    };

    es.onerror = () => {
      es.close();
    };

    return () => es.close();
  // Only reconnect when the expanded row changes, not on every poll
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedId]);

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/queue`);
      const data = await res.json();
      setQueueData(data);
    } catch (err) {
      console.error('Failed to fetch queue:', err);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, 1000);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  const cancelItem = async (id) => {
    setCancelling(prev => new Set(prev).add(id));
    try {
      const res = await fetch(`${API_BASE}/queue/${id}`, { method: 'DELETE' });
      if (res.ok) fetchQueue();
      else console.error('Cancel failed:', (await res.json()).error);
    } catch (err) { console.error('Failed to cancel:', err); }
    setCancelling(prev => { const s = new Set(prev); s.delete(id); return s; });
  };

  const killActive = async (activeRequestId) => {
    setCancelling(prev => new Set(prev).add(`active-${activeRequestId}`));
    try {
      const res = await fetch(`${API_BASE}/queue/active/${activeRequestId}`, { method: 'DELETE' });
      if (res.ok) fetchQueue();
      else console.error('Kill failed:', (await res.json()).error);
    } catch (err) { console.error('Failed to kill:', err); }
    setCancelling(prev => { const s = new Set(prev); s.delete(`active-${activeRequestId}`); return s; });
  };

  const flushAll = async () => {
    try { await fetch(`${API_BASE}/queue/flush`, { method: 'POST' }); fetchQueue(); }
    catch (err) { console.error('Failed to flush:', err); }
  };

  const activeItems = queueData.items.filter(i => i.status === 'active');
  const pendingItems = queueData.items.filter(i => i.status === 'pending');

  const formatElapsed = (ms) => {
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${Math.floor(s % 60)}s`;
  };

  // Merge data: SSE watchData (best) > WS map > polling
  const getLiveData = (item) => {
    const isWatched = item.id === expandedId && watchData;
    const ws = item.activeRequestId ? activeRequestsMap?.[item.activeRequestId] : null;
    const live = isWatched ? watchData : ws;
    return {
      ...item,
      userMessage: live?.userMessage || item.userMessage,
      fullContext: live?.fullContext || item.fullContext || [],
      responseText: live?.responseText || item.responseText || '',
      tokens: live?.tokens || item.tokens || 0,
      status: live?.status || item.status,
      backend: live?.backend || item.backend || 'local',
      startTime: live?.startTime || item.startTime
    };
  };

  // Format a message for display (handles string and array content)
  const formatMessageContent = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(c => {
        if (c.type === 'text') return c.text;
        if (c.type === 'image_url') return '[image]';
        return JSON.stringify(c);
      }).join('\n');
    }
    return JSON.stringify(content);
  };

  const renderExpandedRow = (item) => {
    const live = getLiveData(item);
    const isProcessing = live.status === 'processing' || item.status === 'active';
    const elapsed = live.startTime ? Date.now() - live.startTime : item.elapsed;
    const tokens = live.tokens || 0;
    const tps = tokens > 0 && elapsed > 1000 ? (tokens / (elapsed / 1000)).toFixed(1) : '0.0';
    const context = live.fullContext || [];

    return (
      <div className="queue-expanded">
        <div className="queue-expanded-stats">
          <span className="queue-expanded-stat">
            <span className="queue-expanded-stat-label">Output Tokens:</span> {tokens}
          </span>
          <span className="queue-expanded-stat">
            <span className="queue-expanded-stat-label">Speed:</span> {tps} tok/s
            {isProcessing && tokens > 0 && <span className="streaming-indicator"> live</span>}
          </span>
          <span className="queue-expanded-stat">
            <span className="queue-expanded-stat-label">Elapsed:</span> {formatElapsed(elapsed)}
          </span>
          <span className="queue-expanded-stat">
            <span className="queue-expanded-stat-label">Backend:</span> {live.backend}
          </span>
          <span className="queue-expanded-stat">
            <span className="queue-expanded-stat-label">Model:</span> {item.model}
          </span>
          <span className="queue-expanded-stat">
            <span className="queue-expanded-stat-label">Context Messages:</span> {context.length}
          </span>
        </div>

        {/* Full conversation context as chat bubbles */}
        <div className="queue-expanded-section">
          <div className="queue-expanded-label">Conversation Context ({context.length} messages)</div>
          <div className="queue-chat-thread">
            {context.length > 0 ? context.map((msg, i) => {
              const role = msg.role || 'unknown';
              const content = formatMessageContent(msg.content || msg.thinking || '');
              const isSystem = role === 'system';
              const sysKey = `${item.id}-${i}`;
              const isSysExpanded = expandedSysMsgs.has(sysKey);
              const isLong = content.length > 200;

              return (
                <div key={i} className={`chat-bubble chat-bubble-${role}`}>
                  <div className="chat-bubble-header">
                    <span className={`chat-bubble-role chat-role-${role}`}>{role}</span>
                    {msg.name && <span className="chat-bubble-name">{msg.name}</span>}
                  </div>
                  {isSystem && isLong && !isSysExpanded ? (
                    <div className="chat-bubble-body">
                      <div className="chat-bubble-text">{content.slice(0, 150)}...</div>
                      <button className="chat-bubble-expand" onClick={() => setExpandedSysMsgs(prev => { const s = new Set(prev); s.add(sysKey); return s; })}>
                        Show full ({(content.length / 1000).toFixed(1)}k chars)
                      </button>
                    </div>
                  ) : (
                    <div className="chat-bubble-body">
                      <div className="chat-bubble-text">{parseMessageWithCodeBlocks(content || '(empty)')}</div>
                      {isSystem && isLong && (
                        <button className="chat-bubble-expand" onClick={() => setExpandedSysMsgs(prev => { const s = new Set(prev); s.delete(sysKey); return s; })}>
                          Collapse
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            }) : <div className="queue-context-empty">(no context captured)</div>}
          </div>
        </div>

        {/* Live response */}
        <div className="queue-expanded-section">
          <div className="queue-expanded-label">
            Response
            {isProcessing && tokens > 0 && <span className="streaming-indicator"> streaming...</span>}
            {isProcessing && tokens === 0 && <span className="streaming-indicator"> waiting...</span>}
          </div>
          <div className="queue-expanded-content queue-expanded-response" ref={expandedId === item.id ? responseRef : null}>
            {live.responseText ? parseMessageWithCodeBlocks(live.responseText) : (isProcessing ? 'Waiting for first token...' : 'No response')}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="page queue-page">
      <div className="page-header">
        <h2>Queue Management</h2>
        <div className="header-actions">
          <span className="queue-summary">
            Concurrency: {queueData.concurrency} | Total queued: {queueData.totalQueued}
          </span>
          {pendingItems.length > 0 && (
            <button className="btn-warning" onClick={flushAll}>
              Flush All Pending ({pendingItems.length})
            </button>
          )}
        </div>
      </div>

      <div className="queue-stats-row">
        <StatCard label="Active" value={activeItems.length} status={activeItems.length > 0 ? 'success' : ''} icon="&#x26A1;" />
        <StatCard label="Pending" value={pendingItems.length} status={pendingItems.length > 0 ? 'warning' : ''} icon="&#x23F3;" />
        <StatCard label="Concurrency" value={queueData.concurrency} icon="&#x1F504;" />
        <StatCard label="Total Queued" value={queueData.totalQueued} icon="&#x1F4CA;" />
      </div>

      {activeItems.length > 0 && (
        <div className="queue-section">
          <h3>Active Requests</h3>
          <div className="queue-table">
            <div className="queue-table-header">
              <span className="queue-col-id">ID</span>
              <span className="queue-col-model">Model</span>
              <span className="queue-col-endpoint">Endpoint</span>
              <span className="queue-col-message">Message</span>
              <span className="queue-col-tokens">Tokens</span>
              <span className="queue-col-elapsed">Elapsed</span>
              <span className="queue-col-actions">Actions</span>
            </div>
            {activeItems.map(item => {
              const live = getLiveData(item);
              const isExpanded = expandedId === item.id;
              return (
                <React.Fragment key={item.id}>
                  <div
                    className={`queue-table-row active clickable ${isExpanded ? 'expanded' : ''} ${item.offloaded ? 'offloaded' : ''}`}
                    onClick={() => setExpandedId(isExpanded ? null : item.id)}
                  >
                    <span className="queue-col-id">
                      <span className={`queue-expand-arrow ${isExpanded ? 'open' : ''}`}>&#x25B6;</span>
                      {item.id}
                    </span>
                    <span className="queue-col-model" title={item.model}>
                      <span className="queue-model-name">{item.model.length > 25 ? item.model.slice(0, 22) + '...' : item.model}</span>
                      {item.offloaded && <span className="queue-backend-tag">{item.backendName}</span>}
                      {!item.offloaded && item.backend === 'local' && <span className="queue-backend-tag local">local</span>}
                    </span>
                    <span className="queue-col-endpoint">{item.endpoint}</span>
                    <span className="queue-col-message" title={live.userMessage}>{live.userMessage ? (live.userMessage.length > 60 ? live.userMessage.slice(0, 57) + '...' : live.userMessage) : '-'}</span>
                    <span className="queue-col-tokens">
                      {live.tokens || '-'}
                      {item.preTokenized != null && (
                        <span className="queue-pretok-tag" title="Pre-tokenized (computed in parallel while queued)">
                          tok:{item.preTokenized}
                        </span>
                      )}
                      {item.preTokenized == null && item.backend === 'local' && (
                        <span className="queue-pretok-tag queue-pretok-pending" title="Pre-tokenization pending">
                          tok:…
                        </span>
                      )}
                      {item.upstreamProbe && (
                        <span
                          className={`queue-probe-tag queue-probe-${item.upstreamProbe.phase || 'idle'}`}
                          title={`llama.cpp slot ${item.upstreamProbe.slotId ?? '?'}: ${item.upstreamProbe.phase}; last probe ${Math.round((Date.now() - (item.upstreamProbe.probedAt || 0)) / 1000)}s ago`}
                        >
                          {item.upstreamProbe.phase === 'prompt-processing' ? '🔄 prompt' :
                           item.upstreamProbe.phase === 'decoding' ? `▶ ${item.upstreamProbe.nDecoded} tok` :
                           '○ idle'}
                        </span>
                      )}
                    </span>
                    <span className={`queue-col-elapsed ${(item.activeElapsed ?? item.elapsed) > 120000 ? 'elapsed-warning' : ''}`}>
                      <div>{formatElapsed(item.activeElapsed ?? item.elapsed)}</div>
                      {item.activeElapsed != null && item.totalElapsed != null && item.totalElapsed !== item.activeElapsed && (
                        <div className="queue-elapsed-sub" title="Total time since request entered the proxy (includes queue wait)">
                          (total {formatElapsed(item.totalElapsed)})
                        </div>
                      )}
                    </span>
                    <span className="queue-col-actions" onClick={e => e.stopPropagation()}>
                      {item.activeRequestId ? (
                        <button
                          className="btn-danger-sm"
                          onClick={() => killActive(item.activeRequestId)}
                          disabled={cancelling.has(`active-${item.activeRequestId}`)}
                          title="Kill this request"
                        >
                          {cancelling.has(`active-${item.activeRequestId}`) ? '...' : 'Kill'}
                        </button>
                      ) : (
                        <span className="queue-status-badge active-badge">Processing</span>
                      )}
                    </span>
                  </div>
                  {isExpanded && renderExpandedRow(item)}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}

      {pendingItems.length > 0 && (
        <div className="queue-section">
          <h3>Pending Requests</h3>
          <div className="queue-table">
            <div className="queue-table-header">
              <span className="queue-col-id">ID</span>
              <span className="queue-col-model">Model</span>
              <span className="queue-col-endpoint">Endpoint</span>
              <span className="queue-col-message">Message</span>
              <span className="queue-col-tokens">Tokens</span>
              <span className="queue-col-elapsed">Waiting</span>
              <span className="queue-col-actions">Actions</span>
            </div>
            {pendingItems.map(item => {
              // Items with an activeRequestId (chat/completions queued behind a slot)
              // need to be killed via the active-request abort path. Queue-only items
              // (completions/responses/messages) use the pending-cancel endpoint with
              // the numeric portion of the prefixed id.
              const hasActive = item.activeRequestId != null;
              const cancelKey = hasActive ? `active-${item.activeRequestId}` : item.id;
              const onCancel = hasActive
                ? () => killActive(item.activeRequestId)
                : () => cancelItem(item.queueItemId ?? parseInt(String(item.id).replace(/^q/, ''), 10));
              const posLabel = item.queuePosition != null
                ? `#${item.queuePosition}${item.queueLength ? ` of ${item.queueLength}` : ''}`
                : null;
              return (
                <div key={item.id} className={`queue-table-row pending ${item.offloaded ? 'offloaded' : ''}`}>
                  <span className="queue-col-id">
                    {item.id}
                    {posLabel && <div className="queue-position-tag" title={`Position in local queue: ${posLabel}`}>{posLabel}</div>}
                  </span>
                  <span className="queue-col-model" title={item.model}>
                    <span className="queue-model-name">{item.model.length > 25 ? item.model.slice(0, 22) + '...' : item.model}</span>
                    {item.backendName && <span className="queue-backend-tag">{item.backendName}</span>}
                  </span>
                  <span className="queue-col-endpoint">{item.endpoint}</span>
                  <span className="queue-col-message" title={item.userMessage}>{item.userMessage ? (item.userMessage.length > 60 ? item.userMessage.slice(0, 57) + '...' : item.userMessage) : '-'}</span>
                  <span className="queue-col-tokens">
                    {item.preTokenized != null ? (
                      <span className="queue-pretok-tag" title="Pre-tokenized while queued (CPU work parallel to GPU)">
                        tok:{item.preTokenized}
                      </span>
                    ) : item.backend === 'local' ? (
                      <span className="queue-pretok-tag queue-pretok-pending" title="Pre-tokenization in progress">
                        tok:…
                      </span>
                    ) : '-'}
                  </span>
                  <span className={`queue-col-elapsed ${item.elapsed > 60000 ? 'elapsed-warning' : ''}`}>{formatElapsed(item.elapsed)}</span>
                  <span className="queue-col-actions">
                    <button
                      className="btn-danger-sm"
                      onClick={onCancel}
                      disabled={cancelling.has(cancelKey)}
                      title={hasActive ? 'Abort this queued request' : 'Cancel this pending request'}
                    >
                      {cancelling.has(cancelKey) ? '...' : 'Cancel'}
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {queueData.items.length === 0 && (
        <div className="queue-empty">
          <span className="queue-empty-icon">&#x2705;</span>
          <p>Queue is empty — no active or pending requests</p>
        </div>
      )}
    </div>
  );
}

export default QueuePage;
