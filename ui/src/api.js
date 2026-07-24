// Llama Manager — shared browser API primitives.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Exposes the API base path, real-time stats/log transport hook, and small
// formatting and clipboard helpers shared by UI pages and components.

import { useState, useEffect, useCallback, useRef } from 'react';

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

// WebSocket hook for real-time stats and logs
function useWebSocket() {
  const [stats, setStats] = useState(null);
  const [logs, setLogs] = useState([]);
  const [requestLogs, setRequestLogs] = useState([]);
  const [llmLogs, setLlmLogs] = useState([]);
  const [activeRequest, setActiveRequest] = useState(null);
  const [activeRequestsMap, setActiveRequestsMap] = useState({});
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const pollIntervalRef = useRef(null);
  const wsFailCountRef = useRef(0);
  const usingPollingRef = useRef(false);
  const MAX_LOGS = 500;
  const MAX_REQUEST_LOGS = 200;
  const MAX_LLM_LOGS = 50;
  const WS_FAIL_THRESHOLD = 3; // Fall back to polling after this many WS failures

  // HTTP polling fallback for when WebSocket is unavailable (e.g. reverse proxy without WS support)
  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) return; // already polling
    usingPollingRef.current = true;
    console.log('[poll] Starting HTTP polling fallback (WebSocket unavailable)');
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/stats`);
        if (res.ok) {
          const data = await res.json();
          setStats(data);
          setConnected(true);
        }
      } catch { /* server unreachable */ }
    };
    poll(); // immediate first poll
    pollIntervalRef.current = setInterval(poll, 2000);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    usingPollingRef.current = false;
  }, []);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.onopen = () => {
        wsFailCountRef.current = 0;
        stopPolling();
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
              // Replace in place if this id was already seen (the server can broadcast
              // the same entry twice — e.g. a backfill replay), so the list never holds
              // duplicate ids that would collide as React keys.
              const i = message.data.id != null ? prev.findIndex(l => l.id === message.data.id) : -1;
              const newLogs = i >= 0
                ? prev.map((l, j) => (j === i ? message.data : l))
                : [...prev, message.data];
              return newLogs.slice(-MAX_LLM_LOGS);
            });
          } else if (message.type === 'activeRequest') {
            const { event, data } = message;
            if (event === 'start') {
              setActiveRequest(data);
              setActiveRequestsMap(prev => ({ ...prev, [data.id]: data }));
            } else if (event === 'update') {
              setActiveRequest(prev => prev && prev.id === data.id ? { ...prev, ...data } : prev);
              setActiveRequestsMap(prev => {
                const existing = prev[data.id];
                return { ...prev, [data.id]: existing ? { ...existing, ...data } : { id: data.id, status: 'processing', ...data } };
              });
            } else if (event === 'end') {
              setActiveRequest(prev => {
                if (prev && prev.id === data.id) {
                  // Mark as ended but keep briefly for UI transition
                  setTimeout(() => setActiveRequest(cur => cur && cur.id === data.id && cur.status !== 'processing' ? null : cur), 2000);
                  return { ...prev, ...data };
                }
                return prev;
              });
              setActiveRequestsMap(prev => {
                const next = { ...prev, [data.id]: { ...prev[data.id], ...data } };
                // Remove ended requests after a brief delay
                setTimeout(() => setActiveRequestsMap(cur => { const c = { ...cur }; delete c[data.id]; return c; }), 3000);
                return next;
              });
            }
          }
        } catch (e) {
          console.error('[ws] Parse error:', e);
        }
      };

      wsRef.current.onclose = () => {
        setConnected(false);
        wsFailCountRef.current++;
        if (wsFailCountRef.current >= WS_FAIL_THRESHOLD && !usingPollingRef.current) {
          console.log(`[ws] ${wsFailCountRef.current} consecutive failures, falling back to HTTP polling`);
          startPolling();
        } else if (!usingPollingRef.current) {
          console.log('[ws] Disconnected, reconnecting...');
          reconnectTimeoutRef.current = setTimeout(connect, 2000);
        }
      };

      wsRef.current.onerror = (error) => {
        console.error('[ws] Error:', error);
      };
    } catch (e) {
      console.error('[ws] Connection failed:', e);
      wsFailCountRef.current++;
      if (wsFailCountRef.current >= WS_FAIL_THRESHOLD && !usingPollingRef.current) {
        startPolling();
      } else {
        reconnectTimeoutRef.current = setTimeout(connect, 2000);
      }
    }
  }, [startPolling, stopPolling]);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      stopPolling();
    };
  }, [connect, stopPolling]);

  const clearLogs = useCallback(() => setLogs([]), []);
  const clearRequestLogs = useCallback(() => setRequestLogs([]), []);
  const clearLlmLogs = useCallback(() => setLlmLogs([]), []);

  return { stats, logs, connected, clearLogs, requestLogs, clearRequestLogs, llmLogs, clearLlmLogs, activeRequest, activeRequestsMap };
}

export { API_BASE, formatBytes, formatUptime, formatModelName, copyTextToClipboard, useWebSocket };
