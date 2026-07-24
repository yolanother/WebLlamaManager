// Llama Manager — monitoring dashboard page.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Renders the standard and kiosk monitoring dashboards, including live resource,
// request, model, and historical analytics views.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, AreaChart,
  BarChart, Bar
} from 'recharts';
import { API_BASE, formatBytes, formatUptime, formatModelName } from '../api.js';
import { isLocalKioskHost, requestSystemLogin } from '../kiosk-control.js';
import {
  StatCard,
  ProgressRing,
  CHART_COLORS,
  sensorSeverity,
  severityColor,
  ChartTooltip,
  TemperatureChart,
  ModelTpsRankChart,
  ModelPerformanceBreakdown,
  ModelRequestStatsTable,
  UsageChart,
  PowerChart,
  MemoryChart,
  MODEL_SPEED_COLORS,
  TokensChart,
  ActiveRequestPanel,
  formatHistoryTime,
  HistoryTooltip,
  TimeRangeSelector,
} from '../components/util.jsx';

// Dashboard Page
//
// When `kiosk` is true the component renders its glanceable, auto-paging
// full-screen layout directly (used by the /kiosk route shown on the kiosk
// appliance). Chrome runs in --kiosk so the page is already full-screen; we do
// not call the Fullscreen API, and interactive controls are hidden.
function Dashboard({ stats, activeRequest, kiosk = false }) {
  const [serverModels, setServerModels] = useState([]);
  const [loading, setLoading] = useState({});
  const [analytics, setAnalytics] = useState(null);
  const [historyRange, setHistoryRange] = useState('1h');
  const [historyData, setHistoryData] = useState(null);
  const [crashData, setCrashData] = useState(null);
  const [modelBreakdown, setModelBreakdown] = useState(null);
  const [requestStats, setRequestStats] = useState(null);
  const [requestStatsWindow, setRequestStatsWindow] = useState('24h');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenPage, setFullscreenPage] = useState(0);
  const [showAllModels, setShowAllModels] = useState(false);
  const [systemLoginError, setSystemLoginError] = useState('');
  const fullscreenTimerRef = useRef(null);
  const FULLSCREEN_PAGES = 3;

  // Kiosk mode reuses the full-screen presentation without the Fullscreen API.
  const showFullscreen = isFullscreen || kiosk;
  const showSystemLogin = kiosk && isLocalKioskHost(window.location.hostname);

  const openSystemLogin = async () => {
    setSystemLoginError('');
    try {
      await requestSystemLogin({ hostname: window.location.hostname });
    } catch (error) {
      setSystemLoginError(error.message || 'Unable to open the system login screen.');
    }
  };

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

  const fetchModelBreakdown = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/analytics/models`);
      setModelBreakdown(await res.json());
    } catch (err) {
      console.error('Failed to fetch model breakdown:', err);
    }
  }, []);

  const fetchRequestStats = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/analytics/request-stats?window=${requestStatsWindow}`);
      setRequestStats(await res.json());
    } catch (err) {
      console.error('Failed to fetch request stats:', err);
    }
  }, [requestStatsWindow]);

  const fetchHistory = useCallback(async () => {
    try {
      const [histRes, crashRes] = await Promise.all([
        fetch(`${API_BASE}/analytics/history?range=${historyRange}`),
        fetch(`${API_BASE}/analytics/crashes?range=${historyRange}`)
      ]);
      setHistoryData(await histRes.json());
      setCrashData(await crashRes.json());
    } catch (err) {
      console.error('Failed to fetch history:', err);
    }
  }, [historyRange]);

  useEffect(() => {
    fetchModels();
    fetchAnalytics();
    fetchHistory();
    fetchModelBreakdown();
    fetchRequestStats();
    const modelsInterval = setInterval(fetchModels, 10000);
    const analyticsInterval = setInterval(fetchAnalytics, 2000);
    const historyInterval = setInterval(fetchHistory, 60000);
    // Breakdown aggregates the full analytics history file — refresh slowly.
    const breakdownInterval = setInterval(fetchModelBreakdown, 30000);
    // Request stats aggregate the per-request store — equally slow refresh.
    const requestStatsInterval = setInterval(fetchRequestStats, 30000);
    return () => {
      clearInterval(modelsInterval);
      clearInterval(analyticsInterval);
      clearInterval(historyInterval);
      clearInterval(breakdownInterval);
      clearInterval(requestStatsInterval);
    };
  }, [fetchModels, fetchAnalytics, fetchHistory, fetchModelBreakdown, fetchRequestStats]);

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

  // Kiosk: keep the screen awake. The Screen Wake Lock API maps to the
  // compositor's idle-inhibit protocol under cage/wlroots, preventing the
  // display from blanking (which on the appliance leads to a lock/lost dashboard).
  //
  // The lock is fragile: the system releases it not only when the tab is hidden
  // but on its own (power events, compositor churn), and a request can fail
  // transiently before the page is focused. The previous version only re-acquired
  // on visibilitychange, so a single system-initiated release left the screen
  // unprotected forever. Here we re-acquire on the sentinel's own `release` event,
  // on visibility changes, AND via a periodic heartbeat — so the lock is
  // effectively always held while the kiosk page is visible.
  useEffect(() => {
    if (!kiosk || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let sentinel = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      if (sentinel && !sentinel.released) return; // already held
      try {
        sentinel = await navigator.wakeLock.request('screen');
        // The system can drop the lock on its own — re-acquire immediately.
        sentinel.addEventListener('release', () => { if (!cancelled) acquire(); });
      } catch { /* transient — the heartbeat/visibility handler will retry */ }
    };

    acquire();
    const onVisibility = () => { if (document.visibilityState === 'visible') acquire(); };
    document.addEventListener('visibilitychange', onVisibility);
    // Defensive heartbeat: re-acquire if the lock was lost for any reason.
    const heartbeat = setInterval(acquire, 15000);

    return () => {
      cancelled = true;
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', onVisibility);
      if (sentinel && !sentinel.released) sentinel.release().catch(() => {});
    };
  }, [kiosk]);

  // Auto-page in fullscreen (fetch interval from settings)
  useEffect(() => {
    if (showFullscreen) {
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
  }, [showFullscreen]);

  // Close the "all models" modal on Escape.
  useEffect(() => {
    if (!showAllModels) return;
    const onKey = (e) => { if (e.key === 'Escape') setShowAllModels(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showAllModels]);

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

  const flushQueue = async () => {
    try {
      const res = await fetch(`${API_BASE}/queue/flush`, { method: 'POST' });
      const data = await res.json();
      console.log(`Queue flushed: ${data.flushed} request(s) cancelled`);
    } catch (err) {
      console.error('Failed to flush queue:', err);
    }
  };

  // Healthy when EITHER the llama server is up OR the ds4 engine is active and
  // serving (in ds4-exclusive mode llama is intentionally stopped, so ds4 health
  // is the real signal — otherwise the chat/status would show "not running").
  const isHealthy = stats?.llama?.status === 'ok' || stats?.ds4?.status === 'ok';
  const isSingleMode = stats?.mode === 'single';
  const llamaPort = stats?.llamaPort || 5251;
  const llamaUiUrl = stats?.llamaUiUrl || `http://${window.location.hostname}:${llamaPort}`;

  // Count of models that are ACTUALLY loaded — not all available models.
  // serverModels is the full available-model list reported by the llama.cpp
  // router (e.g. 16 entries), but only a couple are loaded at a time. The
  // router reports each model's real state in status.value ('loaded' |
  // 'unloaded'), so prefer that. If serverModels carries no status info, fall
  // back to the router's loaded set in stats.context.models.
  const serverModelsHaveStatus = serverModels.some(m => m && m.status != null);
  const loadedModelCount = serverModelsHaveStatus
    ? serverModels.filter(m => (m.status?.value ?? m.status) === 'loaded').length
    : (stats?.context?.models?.length || 0);

  // Normalize a model entry's loaded state. serverModels carries
  // status.value ('loaded' | 'unloaded'); the stats.context.models fallback
  // only ever contains the router's loaded set, so treat those as loaded.
  const modelStatusValue = (m) => (m?.status?.value ?? m?.status) || 'loaded';
  // The full available-model list (loaded + unloaded) for the "View all" modal.
  // Prefer serverModels (carries per-model status); else fall back to the
  // router's loaded set in stats.context.models.
  const allModels = serverModels.length > 0 ? serverModels : (stats?.context?.models || []);
  // Just the loaded models, for inline display in the compact Models card.
  const loadedModels = allModels.filter(m => modelStatusValue(m) === 'loaded');

  // Thermal-guard state — folded into the status strip's right side.
  const guardActive = !!(stats?.guard && stats.guard.state && stats.guard.state !== 'normal');

  // Prepare history chart data
  const historyPoints = (historyData?.points || []).map(p => ({
    ...p,
    time: formatHistoryTime(p.ts, historyRange)
  }));

  // Compute percentage breakdown for request health chart (0-100% stacked)
  const requestHealthPoints = historyPoints.map(p => {
    const total = (p.rOk || 0) + (p.rErr || 0) + (p.rRt || 0) + (p.rRs || 0);
    if (total === 0) return { time: p.time, pctOk: 100, pctErr: 0, pctRt: 0, pctRs: 0, pctOf: 0 };
    return {
      time: p.time,
      pctOk: Math.round(((p.rOk || 0) - (p.rOf || 0)) / total * 1000) / 10, // local success
      pctOf: Math.round((p.rOf || 0) / total * 1000) / 10, // offloaded
      pctErr: Math.round((p.rErr || 0) / total * 1000) / 10,
      pctRt: Math.round((p.rRt || 0) / total * 1000) / 10,
      pctRs: Math.round((p.rRs || 0) / total * 1000) / 10
    };
  });

  // Bucket request volume into regular intervals for readability
  const requestVolumeData = React.useMemo(() => {
    const points = historyData?.points || [];
    if (points.length === 0) return [];
    // Choose bucket size based on range: aim for ~20-40 bars
    const bucketMinutes = { '1h': 5, '1d': 60, '1w': 360, '1m': 1440, '1y': 10080 };
    const bucketMs = (bucketMinutes[historyRange] || 5) * 60000;
    const buckets = new Map();
    for (const p of points) {
      const key = Math.floor(p.ts / bucketMs) * bucketMs;
      if (!buckets.has(key)) buckets.set(key, { ts: key, rOk: 0, rErr: 0, rRt: 0, rRs: 0, rOf: 0 });
      const b = buckets.get(key);
      b.rOk += p.rOk || 0;
      b.rErr += p.rErr || 0;
      b.rRt += p.rRt || 0;
      b.rRs += p.rRs || 0;
      b.rOf += p.rOf || 0;
    }
    return [...buckets.values()]
      .sort((a, b) => a.ts - b.ts)
      .map(b => ({ ...b, time: formatHistoryTime(b.ts, historyRange) }));
  }, [historyData, historyRange]);

  // Build error code breakdown data from summary
  const errorCodeData = historyData?.summary?.statusCodes
    ? Object.entries(historyData.summary.statusCodes)
        .filter(([code]) => parseInt(code) >= 400 || isNaN(parseInt(code)))
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count)
    : [];

  // Build cumulative request growth data
  const requestGrowthData = React.useMemo(() => {
    let cumulative = 0;
    return historyPoints.map(p => {
      cumulative += (p.rT || 0);
      return { time: p.time, total: cumulative };
    });
  }, [historyPoints]);

  // Build model usage bar chart data
  const modelUsageData = historyData?.summary?.modelCounts
    ? Object.entries(historyData.summary.modelCounts)
        .map(([model, count]) => ({ model: model.length > 30 ? model.slice(0, 27) + '...' : model, count, fullModel: model }))
        .sort((a, b) => b.count - a.count)
    : [];

  // Build model usage over time (top 5 models as line series)
  const MODEL_LINE_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a78bfa'];
  const modelUsageOverTime = React.useMemo(() => {
    const points = historyData?.points || [];
    if (points.length === 0) return { data: [], models: [] };

    // Count total requests per model across all points
    const totals = {};
    for (const p of points) {
      for (const [model, count] of Object.entries(p.mc || {})) {
        totals[model] = (totals[model] || 0) + count;
      }
    }

    // Top 5 models by total count
    const top5 = Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([model]) => model);

    if (top5.length === 0) return { data: [], models: [] };

    // Bucket into same intervals as request volume
    const bucketMinutes = { '1h': 5, '1d': 60, '1w': 360, '1m': 1440, '1y': 10080 };
    const bucketMs = (bucketMinutes[historyRange] || 5) * 60000;
    const buckets = new Map();
    for (const p of points) {
      const key = Math.floor(p.ts / bucketMs) * bucketMs;
      if (!buckets.has(key)) {
        const entry = { ts: key };
        for (const m of top5) entry[m] = 0;
        buckets.set(key, entry);
      }
      const b = buckets.get(key);
      for (const m of top5) {
        b[m] += (p.mc || {})[m] || 0;
      }
    }

    const data = [...buckets.values()]
      .sort((a, b) => a.ts - b.ts)
      .map(b => ({ ...b, time: formatHistoryTime(b.ts, historyRange) }));

    return { data, models: top5 };
  }, [historyData, historyRange]);

  // Build per-model generation speed over time (uses mtps field from history points)
  const modelSpeedOverTime = React.useMemo(() => {
    const points = historyData?.points || [];
    if (points.length === 0) return { data: [], models: [] };

    // Collect all models that have speed data
    const modelTotals = {};
    for (const p of points) {
      for (const [model, tps] of Object.entries(p.mtps || {})) {
        modelTotals[model] = (modelTotals[model] || 0) + tps;
      }
    }

    // Top models by cumulative speed (proxy for most active)
    const topModels = Object.entries(modelTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([m]) => m);

    if (topModels.length === 0) return { data: [], models: [] };

    // Build data with carry-forward (dotted) and real values (solid)
    const lastKnown = {};
    const data = points.map(p => {
      const entry = { time: formatHistoryTime(p.ts, historyRange) };
      if (p.mtps) {
        for (const [m, tps] of Object.entries(p.mtps)) {
          if (topModels.includes(m)) lastKnown[m] = tps;
        }
      }
      for (const m of topModels) {
        const real = p.mtps?.[m] || null;
        entry[m] = real || lastKnown[m] || null;        // carry-forward (dotted)
        entry[m + '__real'] = real;                       // real only (solid)
      }
      return entry;
    });

    return { data, models: topModels };
  }, [historyData, historyRange]);

  // Build crash-by-model bar chart data
  const crashByModelData = crashData?.summary?.byModel
    ? Object.entries(crashData.summary.byModel)
        .map(([model, count]) => ({ model: model.length > 30 ? model.slice(0, 27) + '...' : model, count, fullModel: model }))
        .sort((a, b) => b.count - a.count)
    : [];

  // Fullscreen rendering — 2 dense pages
  if (showFullscreen) {
    return (
      <div className="fullscreen-dashboard">
        {/* Persistent header — visible on all pages */}
        <div className="fullscreen-persistent-header">
          <div className="fullscreen-resources-row">
            <div className="resource-card">
              <ProgressRing value={stats?.cpu?.usage || 0} size={56} strokeWidth={5} color={stats?.cpu?.usage > 80 ? 'var(--error)' : 'var(--accent)'} />
              <div className="resource-info">
                <span className="resource-label">CPU</span>
                <span className="resource-detail">{stats?.cpu?.cores || 0} cores @ {stats?.cpu?.loadAvg?.[0]?.toFixed(1) || '0.0'} load</span>
              </div>
            </div>
            <div className="resource-card">
              <ProgressRing value={stats?.memory?.usage || 0} size={56} strokeWidth={5} color={stats?.memory?.usage > 80 ? 'var(--error)' : 'var(--success)'} />
              <div className="resource-info">
                <span className="resource-label">Memory</span>
                <span className="resource-detail">{formatBytes(stats?.memory?.used)} / {formatBytes(stats?.memory?.total)}</span>
              </div>
            </div>
            {stats?.gpu && (
              <div className="resource-card">
                <ProgressRing value={stats.gpu.isAPU ? (stats.gpu.gtt?.usage || 0) : (stats.gpu.vram?.usage || 0)} size={56} strokeWidth={5} color="var(--warning)" />
                <div className="resource-info">
                  <span className="resource-label">{stats.gpu.isAPU ? 'GTT' : 'VRAM'}</span>
                  <span className="resource-detail">{stats.gpu.isAPU ? `${formatBytes(stats.gpu.gtt?.used)} / ${formatBytes(stats.gpu.gtt?.total)}` : `${formatBytes(stats.gpu.vram?.used)} / ${formatBytes(stats.gpu.vram?.total)}`}</span>
                </div>
              </div>
            )}
            {stats?.gpu?.power > 0 && (
              <div className="resource-card">
                <div className="power-display" style={{ width: 56, height: 56 }}><div className="power-inner"><span className="power-value" style={{ fontSize: 16 }}>{stats.gpu.power.toFixed(0)}</span><span className="power-unit">W</span></div></div>
                <div className="resource-info"><span className="resource-label">Power</span><span className="resource-detail">{stats.gpu.temperature > 0 ? `${stats.gpu.temperature}°C` : ''}</span></div>
              </div>
            )}
            <div className="resource-card">
              <ProgressRing value={stats?.context?.usage || 0} size={56} strokeWidth={5} color="var(--info)" />
              <div className="resource-info">
                <span className="resource-label">Context</span>
                <span className="resource-detail">{stats?.context?.totalContext > 0 ? `${(stats.context.usedContext || 0).toLocaleString()} / ${(stats.context.totalContext || 0).toLocaleString()}` : 'No models'}</span>
              </div>
            </div>
            <div className="resource-card persistent-queue-card">
              <div className="resource-info">
                <span className="resource-label">Queue</span>
                <span className="resource-detail">
                  <span className={`queue-count ${(stats?.queue?.active || 0) > 0 ? 'queue-active' : ''}`}>{stats?.queue?.active || 0} active</span>
                  {' / '}
                  <span className={`queue-count ${(stats?.queue?.pending || 0) > 0 ? 'queue-pending' : ''}`}>{stats?.queue?.pending || 0} pending</span>
                </span>
                {!kiosk && (stats?.queue?.pending || 0) > 0 && (
                  <button className="persistent-flush-btn" onClick={flushQueue}>Flush</button>
                )}
              </div>
            </div>
            {stats?.backends && Object.keys(stats.backends).length > 0 && (
              <div className="resource-card" style={{ minWidth: 'auto' }}>
                <div className="resource-info">
                  <span className="resource-label">Remote Backends</span>
                  <span className="resource-detail" style={{ fontSize: '0.8em' }}>
                    {Object.entries(stats.backends).map(([id, b]) => (
                      <span key={id} style={{ marginRight: '12px' }}>
                        {id}: {b.active}/{b.active + b.pending} {b.tokPerSec > 0 ? `${b.tokPerSec} t/s` : ''} {b.totalCost > 0 ? `$${b.totalCost.toFixed(4)}` : ''}
                      </span>
                    ))}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

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
                  <span className="stat-value">{loadedModelCount} Loaded</span>
                  <span className="stat-label">Models</span>
                  {serverModels.length > 0 && (
                    <div className="loaded-models-list">
                      {serverModels.map((m, i) => {
                        const modelId = m.id || m.model || '';
                        const isActive = stats?.activeModel && modelId === stats.activeModel;
                        const isLastUsed = !isActive && stats?.lastUsedModel && modelId === stats.lastUsedModel;
                        return (
                          <span key={i} className={`loaded-model-name ${isActive ? 'model-active' : ''} ${isLastUsed ? 'model-last-used' : ''}`}>
                            {isActive && <span className="model-indicator active-indicator" title="Currently processing" />}
                            {isLastUsed && <span className="model-indicator last-used-indicator" title="Most recently used" />}
                            {formatModelName(m)}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="fullscreen-charts-grid">
            <div className="chart-card">
              <h4>Temperature <span className="chart-value">
                <span style={{ color: severityColor(sensorSeverity(stats?.gpu?.temperature, stats?.guard)) }}>GPU: {stats?.gpu?.temperature?.toFixed(0) || 0}°C</span>
                {stats?.cpu?.temperature ? <> / <span style={{ color: severityColor(sensorSeverity(stats.cpu.temperature, stats?.guard)) }}>CPU: {stats.cpu.temperature}°C</span></> : ''}
              </span></h4>
              <TemperatureChart data={analytics?.temperature || []} height={200} />
            </div>
            <div className="chart-card">
              <h4>GPU / CPU Usage <span className="chart-value">GPU: {stats?.gpu?.usage?.toFixed(0) || 0}%{stats?.cpu?.usage != null ? ` / CPU: ${stats.cpu.usage.toFixed(0)}%` : ''}</span></h4>
              <UsageChart data={analytics?.usage || []} height={200} />
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
                    <span className="resource-label" style={{ fontSize: 24, fontFamily: 'monospace', color: '#f59e0b' }}>{(historyData.summary.totalRetries || 0).toLocaleString()}</span>
                    <span className="resource-detail">Retries</span>
                  </div>
                </div>
                <div className="resource-card">
                  <div className="resource-info" style={{ textAlign: 'center' }}>
                    <span className="resource-label" style={{ fontSize: 24, fontFamily: 'monospace', color: '#f97316' }}>{(historyData.summary.totalRestarts || 0).toLocaleString()}</span>
                    <span className="resource-detail">Restarts</span>
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
              <h4>Generation Speed by Model</h4>
              <div className="chart-container" style={{ height: 200 }}>
                {modelSpeedOverTime.data.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={modelSpeedOverTime.data} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                      <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                      <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
                      <Tooltip content={<HistoryTooltip unit=" tok/s" range={historyRange} />} />
                      {modelSpeedOverTime.models.map((m, i) => {
                        const color = MODEL_SPEED_COLORS[i % MODEL_SPEED_COLORS.length];
                        const label = m.length > 30 ? m.slice(0, 27) + '...' : m;
                        return (
                          <React.Fragment key={m}>
                            <Line type="monotone" dataKey={m} name={label} stroke={color} strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls={false} strokeOpacity={0.5} animationDuration={500} />
                            <Line type="monotone" dataKey={m + '__real'} name={null} stroke={color} strokeWidth={2} dot={false} connectNulls={true} legendType="none" tooltipType="none" animationDuration={500} />
                          </React.Fragment>
                        );
                      })}
                    </LineChart>
                  </ResponsiveContainer>
                ) : <div className="chart-empty">No per-model speed data yet</div>}
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
                      <Area type="monotone" dataKey="rRt" name="Retries" stroke={CHART_COLORS.requestRetry} fill={CHART_COLORS.requestRetry} fillOpacity={0.3} strokeWidth={1} dot={false} animationDuration={500} />
                      <Area type="monotone" dataKey="rRs" name="Restarts" stroke={CHART_COLORS.requestRestart} fill={CHART_COLORS.requestRestart} fillOpacity={0.5} strokeWidth={1} dot={false} animationDuration={500} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : <div className="chart-empty">No historical data yet</div>}
              </div>
            </div>
          </div>
        </div>

        {/* Page 3: Model Analytics */}
        <div className={`fullscreen-page ${fullscreenPage === 2 ? 'active' : ''}`}>
          <div className="fullscreen-top-bar">
            <div className="fullscreen-history-header">
              <h3>Model Analytics</h3>
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
                    <span className="resource-label" style={{ fontSize: 24, fontFamily: 'monospace', color: 'var(--accent)' }}>{Object.keys(historyData.summary.modelCounts || {}).length}</span>
                    <span className="resource-detail">Models Used</span>
                  </div>
                </div>
                <div className="resource-card">
                  <div className="resource-info" style={{ textAlign: 'center' }}>
                    <span className="resource-label" style={{ fontSize: 24, fontFamily: 'monospace', color: 'var(--error)' }}>{(crashData?.summary?.total || 0).toLocaleString()}</span>
                    <span className="resource-detail">Crashes</span>
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
              <h4>Requests by Model</h4>
              <div className="chart-container" style={{ height: 200 }}>
                {modelUsageData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={modelUsageData} margin={{ top: 5, right: 20, left: 5, bottom: 5 }} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                      <XAxis type="number" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} />
                      <YAxis dataKey="name" type="category" tick={{ fill: '#ccc', fontSize: 11 }} width={150} tickLine={false} axisLine={false} />
                      <Tooltip content={<HistoryTooltip unit=" requests" range={historyRange} />} />
                      <Bar dataKey="count" name="Requests" fill="var(--accent)" radius={[0, 4, 4, 0]} animationDuration={500} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : <div className="chart-empty">No model data in this time range</div>}
              </div>
            </div>
            <div className="chart-card">
              <h4>Model Usage Over Time</h4>
              <div className="chart-container" style={{ height: 200 }}>
                {modelUsageOverTime.data.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={modelUsageOverTime.data} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                      <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                      <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
                      <Tooltip content={<HistoryTooltip range={historyRange} />} />
                      {modelUsageOverTime.models.map((model, i) => (
                        <Line key={model} type="monotone" dataKey={model} name={model.length > 30 ? model.slice(0, 27) + '...' : model} stroke={MODEL_LINE_COLORS[i]} strokeWidth={2} dot={false} animationDuration={500} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                ) : <div className="chart-empty">No model usage data in this time range</div>}
              </div>
              <div className="chart-legend">
                {modelUsageOverTime.models.map((model, i) => (
                  <div key={model} className="chart-legend-item">
                    <span className="chart-legend-dot" style={{ background: MODEL_LINE_COLORS[i] }}></span>
                    {model.length > 30 ? model.slice(0, 27) + '...' : model}
                  </div>
                ))}
              </div>
            </div>
            <div className="chart-card">
              <h4>Crashes by Model</h4>
              <div className="chart-container" style={{ height: 200 }}>
                {crashByModelData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={crashByModelData} margin={{ top: 5, right: 20, left: 5, bottom: 5 }} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                      <XAxis type="number" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} allowDecimals={false} />
                      <YAxis dataKey="name" type="category" tick={{ fill: '#ccc', fontSize: 11 }} width={150} tickLine={false} axisLine={false} />
                      <Tooltip content={<HistoryTooltip unit=" crashes" range={historyRange} />} />
                      <Bar dataKey="count" name="Crashes" fill="var(--error)" radius={[0, 4, 4, 0]} animationDuration={500} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : <div className="chart-empty">No crash data</div>}
              </div>
            </div>
            <div className="chart-card">
              <h4>Generation Speed by Model</h4>
              <div className="chart-container" style={{ height: 200 }}>
                {(() => {
                  const modelTps = historyData?.summary?.modelAvgTps || {};
                  const data = Object.entries(modelTps)
                    .map(([model, tps]) => ({ model: model.length > 30 ? model.slice(0, 27) + '...' : model, tps, fullModel: model }))
                    .sort((a, b) => b.tps - a.tps);
                  return data.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data} margin={{ top: 5, right: 20, left: 5, bottom: 5 }} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                        <XAxis type="number" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} />
                        <YAxis dataKey="model" type="category" tick={{ fill: '#ccc', fontSize: 11 }} width={150} tickLine={false} axisLine={false} />
                        <Tooltip content={<HistoryTooltip unit=" tok/s" range={historyRange} />} />
                        <Bar dataKey="tps" name="Avg tok/s" fill={CHART_COLORS.tokens} radius={[0, 4, 4, 0]} animationDuration={500} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : <div className="chart-empty">No per-model speed data in this time range</div>;
                })()}
              </div>
            </div>
          </div>
        </div>

        {/* Persistent bottom bar — active request + page indicator */}
        <div className="fullscreen-persistent-bar">
          {activeRequest ? (
            <div className="persistent-bar-request">
              <span className={`active-dot ${activeRequest.status === 'processing' ? 'pulse' : 'done'}`} />
              <span className="persistent-bar-model">{activeRequest.model}</span>
              <span className="persistent-bar-prompt">
                {(activeRequest.userMessage || 'Processing...').slice(0, 80)}{(activeRequest.userMessage || '').length > 80 ? '...' : ''}
              </span>
              {activeRequest.tokens > 0 && <span className="persistent-bar-tokens">{activeRequest.tokens} tok</span>}
              <span className="persistent-bar-elapsed">{((activeRequest.duration || (Date.now() - activeRequest.startTime)) / 1000).toFixed(1)}s</span>
            </div>
          ) : (
            <div className="persistent-bar-idle">No active requests</div>
          )}
          <div className="fullscreen-indicator-inline">
            {fullscreenPage + 1} / {FULLSCREEN_PAGES}
          </div>
          {showSystemLogin && (
            <button className="kiosk-system-login" onClick={openSystemLogin}>
              System Login
            </button>
          )}
          {systemLoginError && <span className="kiosk-system-login-error">{systemLoginError}</span>}
        </div>
        <ActiveRequestPanel request={activeRequest} isFullscreen={true} />
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
          {(stats?.queue?.pending || 0) > 0 && (
            <button className="btn-warning" onClick={flushQueue} title="Cancel all pending requests">
              Flush Queue ({stats.queue.pending})
            </button>
          )}
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
        {/* Thin status strip: run-state on the left, thermal guard / temps on the right */}
        <div className={`server-status-strip ${guardActive ? (stats.guard.state === 'critical' ? 'error' : 'warning') : (isHealthy ? 'success' : stats?.mode ? 'warning' : 'error')}`}>
          <div className="status-strip-left">
            <span className={`status-strip-dot ${isHealthy ? 'success' : stats?.mode ? 'warning' : 'error'}`} />
            <span className="status-strip-state">{isHealthy ? 'Running' : stats?.mode ? 'Starting' : 'Stopped'}</span>
          </div>
          <div className="status-strip-right">
            {guardActive ? (
              <span className={`status-strip-guard ${stats.guard.state === 'critical' ? 'critical' : 'throttling'}`}>
                &#x1F525; {stats.guard.state === 'critical' ? 'Critical — unloaded' : 'Throttling'} {Math.round(stats.guard.maxTempC)}°C (gpu {Math.round(stats.guard.gpuC)} / cpu {Math.round(stats.guard.cpuC)})
              </span>
            ) : stats?.gpu?.temperature != null ? (
              <span className="status-strip-temp">
                GPU {stats.gpu.temperature.toFixed(0)}°C{stats?.cpu?.temperature ? ` · CPU ${stats.cpu.temperature}°C` : ''}
              </span>
            ) : null}
          </div>
        </div>
        <div className="status-grid status-grid-compact">
          <StatCard
            label="Mode"
            value={isSingleMode ? 'Single Model' : 'Router (Multi)'}
            subValue={stats?.activeModel ? formatModelName({ id: stats.activeModel }) : (stats?.preset?.name || (stats?.lastUsedModel ? formatModelName({ id: stats.lastUsedModel }) : null))}
            icon="&#x1F3AF;"
            status={stats?.activeModel ? 'active' : undefined}
          />
          <div className="stat-card loaded-models-card compact">
            <span className="stat-icon">&#x1F4E6;</span>
            <div className="stat-content">
              <span className="stat-value">{loadedModelCount} Loaded</span>
              <span className="stat-label">Models</span>
              {loadedModelCount === 0 && (
                <span className="loaded-model-none">No models loaded</span>
              )}
              {loadedModels.length > 0 && (
                <div className="loaded-models-list">
                  {loadedModels.map((m, i) => {
                    const modelId = m.id || m.model || '';
                    const isActive = stats?.activeModel && modelId === stats.activeModel;
                    const isLastUsed = !isActive && stats?.lastUsedModel && modelId === stats.lastUsedModel;
                    return (
                      <span key={i} className={`loaded-model-name ${isActive ? 'model-active' : ''} ${isLastUsed ? 'model-last-used' : ''}`}>
                        {isActive && <span className="model-indicator active-indicator" title="Currently processing" />}
                        {isLastUsed && <span className="model-indicator last-used-indicator" title="Most recently used" />}
                        {formatModelName(m)}
                      </span>
                    );
                  })}
                </div>
              )}
              {allModels.length > loadedModels.length && (
                <button
                  type="button"
                  className="view-all-models-btn"
                  onClick={() => setShowAllModels(true)}
                >
                  View all {allModels.length} models
                </button>
              )}
            </div>
          </div>
          {stats?.embed && (
            <StatCard
              label="Embeddings"
              value={stats.embed.status === 'ok' ? 'Ready' : stats.embed.status === 'disabled' ? 'Off' : 'Down'}
              subValue={stats.embed.model ? `${String(stats.embed.model).split('/').pop()} :${stats.embed.port}` : 'no model'}
              icon="&#x1F9EE;"
              status={stats.embed.status === 'ok' ? 'success' : stats.embed.status === 'disabled' ? '' : 'error'}
            />
          )}
        </div>

        {/* Uniform per-local-server tiles: llama.cpp router, embeddings, and
            ds4 — one shape each, differing only by the models they serve and
            their state. ds4 shows a memory-gated "enable" affordance and is
            never auto-started. */}
        {Array.isArray(stats?.servers) && stats.servers.length > 0 && (
          <>
            <h4 className="server-registry-title">Servers</h4>
            <div className="status-grid status-grid-compact server-registry-grid">
              {stats.servers.map((srv) => {
                const stateLabel = {
                  running: 'Running', degraded: 'Degraded', idle: 'Idle',
                  available: 'Available', 'insufficient-memory': 'Needs memory', down: 'Down',
                }[srv.state] || srv.state;
                const status = srv.state === 'running' ? 'success'
                  : (srv.state === 'down' || srv.state === 'degraded' || srv.state === 'insufficient-memory') ? 'error'
                  : 'warning';
                const icon = srv.type === 'ds4' ? '\u{1F9EC}' : srv.role === 'embeddings' ? '\u{1F9EE}' : '\u{1F680}';
                const models = Array.isArray(srv.models) ? srv.models : [];
                const modelSummary = models.length
                  ? `${models.slice(0, 3).map((m) => formatModelName({ id: m })).join(', ')}${models.length > 3 ? ` +${models.length - 3}` : ''}`
                  : 'no models';
                // ds4 that is not running surfaces its enable-gate reason so the
                // operator sees exactly why it can or cannot be turned on.
                const sub = (srv.id === 'ds4' && srv.enable && !srv.running)
                  ? srv.enable.reason
                  : `${modelSummary}${srv.port ? ` :${srv.port}` : ''}`;
                return (
                  <StatCard key={srv.id} label={srv.displayName} value={stateLabel}
                    subValue={sub} icon={icon} status={status} />
                );
              })}
            </div>
          </>
        )}
      </section>

      {/* All-models modal — full list with per-model loaded/unloaded status */}
      {showAllModels && (
        <div
          className="models-modal-overlay"
          onClick={() => setShowAllModels(false)}
          role="presentation"
        >
          <div
            className="models-modal"
            role="dialog"
            aria-modal="true"
            aria-label="All models"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="models-modal-header">
              <h3>All Models <span className="models-modal-count">{loadedModelCount} / {allModels.length} loaded</span></h3>
              <button
                type="button"
                className="models-modal-close"
                aria-label="Close"
                onClick={() => setShowAllModels(false)}
              >
                &times;
              </button>
            </div>
            <div className="models-modal-body">
              {allModels.length === 0 ? (
                <div className="models-modal-empty">No models available</div>
              ) : (
                allModels.map((m, i) => {
                  const modelId = m.id || m.model || '';
                  const isLoaded = modelStatusValue(m) === 'loaded';
                  const isActive = stats?.activeModel && modelId === stats.activeModel;
                  const isLastUsed = !isActive && stats?.lastUsedModel && modelId === stats.lastUsedModel;
                  return (
                    <div key={modelId || i} className={`models-modal-row ${isLoaded ? 'loaded' : 'unloaded'}`}>
                      <span className={`models-modal-status-dot ${isLoaded ? 'loaded' : 'unloaded'}`} title={isLoaded ? 'Loaded' : 'Unloaded'} />
                      <span className="models-modal-name" title={modelId}>{formatModelName(m)}</span>
                      <span className="models-modal-markers">
                        {isActive && <span className="model-indicator active-indicator" title="Currently processing" />}
                        {isLastUsed && <span className="model-indicator last-used-indicator" title="Most recently used" />}
                        <span className={`models-modal-status-label ${isLoaded ? 'loaded' : 'unloaded'}`}>{isLoaded ? 'loaded' : 'unloaded'}</span>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* System Resources */}
      <section className="dashboard-section">
        <h3>System Resources</h3>
        <div className="resources-grid">
          <div className="resource-card">
            <ProgressRing
              centerValue={stats?.cpu?.usage || 0}
              segments={[
                { value: stats?.cpu?.appUsage || 0, color: 'var(--accent)' },
                { value: Math.max(0, (stats?.cpu?.usage || 0) - (stats?.cpu?.appUsage || 0)), color: 'var(--info)' },
              ]}
            />
            <div className="resource-info">
              <span className="resource-label">CPU</span>
              <span className="resource-detail">{stats?.cpu?.cores || 0} cores @ {stats?.cpu?.loadAvg?.[0]?.toFixed(1) || '0.0'} load</span>
              <div className="resource-legend">
                <span className="resource-legend-item">
                  <span className="resource-legend-dot" style={{ background: 'var(--accent)' }} />
                  app {Math.round(stats?.cpu?.appUsage || 0)}%
                </span>
                <span className="resource-legend-item">
                  <span className="resource-legend-dot" style={{ background: 'var(--info)' }} />
                  system {Math.round(Math.max(0, (stats?.cpu?.usage || 0) - (stats?.cpu?.appUsage || 0)))}%
                </span>
              </div>
              {stats?.cpu?.temperature && (
                <span
                  className="resource-detail"
                  style={{ color: severityColor(sensorSeverity(stats.cpu.temperature, stats?.guard)) }}
                >Temp: {stats.cpu.temperature}°C</span>
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
                  <span
                    className="resource-detail"
                    style={{ color: severityColor(sensorSeverity(stats.gpu.temperature, stats?.guard)) }}
                  >Temp: {stats.gpu.temperature}°C</span>
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
                  {info.status === 'failed' && info.gatedUrl && (
                    <a className="download-gated-link" href={info.gatedUrl} target="_blank" rel="noopener noreferrer">
                      Request access on HuggingFace ↗
                    </a>
                  )}
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
                <span style={{ color: severityColor(sensorSeverity(stats?.gpu?.temperature, stats?.guard)) }}>GPU: {stats?.gpu?.temperature?.toFixed(0) || 0}°C</span>
                {stats?.cpu?.temperature ? <> / <span style={{ color: severityColor(sensorSeverity(stats.cpu.temperature, stats?.guard)) }}>CPU: {stats.cpu.temperature}°C</span></> : ''}
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

          {/* GPU/CPU Usage Chart */}
          <div className="chart-card">
            <h4>
              GPU / CPU Usage
              <span className="chart-value">
                GPU: {stats?.gpu?.usage?.toFixed(0) || 0}%
                {stats?.cpu?.usage != null && ` / CPU: ${stats.cpu.usage.toFixed(0)}%`}
              </span>
            </h4>
            <UsageChart data={analytics?.usage || []} />
            <div className="chart-legend">
              <div className="chart-legend-item">
                <span className="chart-legend-dot gpu"></span>
                GPU
              </div>
              <div className="chart-legend-item">
                <span className="chart-legend-dot cpu"></span>
                CPU
              </div>
              <div className="chart-legend-item">
                <span className="chart-legend-dot" style={{ background: CHART_COLORS.appUsage }}></span>
                App CPU
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
              <div className="chart-legend-item">
                <span className="chart-legend-dot" style={{ background: CHART_COLORS.appUsage }}></span>
                App
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

          {/* Per-Model tok/s ranking — pulls from long-term aggregated history so
              every model that ever served traffic appears, not just the in-memory
              recent-requests buffer. Color encodes local vs each remote backend. */}
          <div className="chart-card chart-card-wide">
            <h4>
              Model Speed Ranking
              <span className="chart-value">avg tok/s · all time</span>
            </h4>
            <ModelTpsRankChart
              modelBreakdown={modelBreakdown}
              window="all"
              height={Math.max(220, ((modelBreakdown?.models || []).filter(m => (m.windows?.all?.tps || 0) > 0).length * 32) + 50)}
            />
          </div>

          {/* Context Usage Chart */}
          <div className="chart-card">
            <h4>
              Context Usage
              <span className="chart-value">
                {(stats?.context?.usedContext || 0).toLocaleString()} / {(stats?.context?.totalContext || 0).toLocaleString()} tokens
              </span>
            </h4>
            <div className="chart-container">
              {(analytics?.context || []).length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={analytics.context} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <defs>
                      <linearGradient id="gradCtxTotal" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.contextTotal} stopOpacity={0.2} />
                        <stop offset="95%" stopColor={CHART_COLORS.contextTotal} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gradCtxUsed" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.contextUsed} stopOpacity={0.4} />
                        <stop offset="95%" stopColor={CHART_COLORS.contextUsed} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis dataKey="timestamp" hide />
                    <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v} />
                    <Tooltip content={<ChartTooltip unit=" tokens" />} />
                    <Area type="monotone" dataKey="totalContext" name="Total" stroke={CHART_COLORS.contextTotal} fill="url(#gradCtxTotal)" strokeWidth={1} strokeDasharray="4 2" dot={false} />
                    <Area type="monotone" dataKey="usedContext" name="Used" stroke={CHART_COLORS.contextUsed} fill="url(#gradCtxUsed)" strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <div className="chart-empty">No context data yet</div>}
            </div>
          </div>

          {/* Request Queue Chart */}
          <div className="chart-card">
            <h4>
              Request Queue
              <span className="chart-value">
                {stats?.queue?.active || 0} active, {stats?.queue?.pending || 0} pending
              </span>
            </h4>
            <div className="chart-container">
              {(analytics?.queue || []).length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={analytics.queue} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <defs>
                      <linearGradient id="gradQActive" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.queueActive} stopOpacity={0.4} />
                        <stop offset="95%" stopColor={CHART_COLORS.queueActive} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gradQPending" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.queuePending} stopOpacity={0.4} />
                        <stop offset="95%" stopColor={CHART_COLORS.queuePending} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis dataKey="timestamp" hide />
                    <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip content={<ChartTooltip />} />
                    <Area type="monotone" dataKey="active" name="Active" stroke={CHART_COLORS.queueActive} fill="url(#gradQActive)" strokeWidth={2} dot={false} />
                    <Area type="monotone" dataKey="pending" name="Pending" stroke={CHART_COLORS.queuePending} fill="url(#gradQPending)" strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <div className="chart-empty">No queue data yet</div>}
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
              <div className="token-stat-value" style={{ color: '#f59e0b' }}>{(historyData.summary.totalRetries || 0).toLocaleString()}</div>
              <div className="token-stat-label">Retries</div>
            </div>
            <div className="token-stat-card">
              <div className="token-stat-value" style={{ color: '#f97316' }}>{(historyData.summary.totalRestarts || 0).toLocaleString()}</div>
              <div className="token-stat-label">Restarts</div>
            </div>
            <div className="token-stat-card">
              <div className="token-stat-value" style={{ color: '#dc2626' }}>{(crashData?.summary?.total || 0).toLocaleString()}</div>
              <div className="token-stat-label">Crashes</div>
            </div>
            <div className="token-stat-card">
              <div className="token-stat-value">{historyData.summary.avgTps}</div>
              <div className="token-stat-label">Avg tok/s</div>
            </div>
          </div>
        )}

        {/* Long-term per-model performance breakdown table */}
        <h4 className="analytics-section-header">Model Performance Breakdown</h4>
        <div className="chart-card-wide model-breakdown-card">
          <h4>
            Average tok/s by Time Window
            <span className="chart-value">all models · weighted by request count</span>
          </h4>
          <ModelPerformanceBreakdown modelBreakdown={modelBreakdown} />
        </div>

        <div className="chart-card-wide model-breakdown-card">
          <h4>
            Request Statistics by Model
            <span className="chart-value">per-request · click a model for slot breakdown</span>
          </h4>
          <ModelRequestStatsTable
            requestStats={requestStats}
            window={requestStatsWindow}
            onWindowChange={setRequestStatsWindow}
          />
        </div>

        <h4 className="analytics-section-header">System Resources</h4>
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
            <h4>Generation Speed by Model <span className="chart-value">tok/s per model</span></h4>
            <div className="chart-container-wide">
              {modelSpeedOverTime.data.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={modelSpeedOverTime.data} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
                    <Tooltip content={<HistoryTooltip unit=" tok/s" range={historyRange} />} />
                    {modelSpeedOverTime.models.map((m, i) => (
                      <Line key={m} type="monotone" dataKey={m} name={m.length > 30 ? m.slice(0, 27) + '...' : m} stroke={MODEL_SPEED_COLORS[i % MODEL_SPEED_COLORS.length]} strokeWidth={2} dot={false} connectNulls={false} animationDuration={500} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              ) : <div className="chart-empty">No per-model speed data yet</div>}
            </div>
          </div>

        </div>

        <h4 className="analytics-section-header">Inference</h4>
        <div className="charts-grid-wide">
          {/* Context Usage History */}
          <div className="chart-card-wide">
            <h4>Context Usage <span className="chart-value">tokens used / total</span></h4>
            <div className="chart-container-wide">
              {historyPoints.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={historyPoints} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <defs>
                      <linearGradient id="gradHistCtxTotal" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.contextTotal} stopOpacity={0.2} />
                        <stop offset="95%" stopColor={CHART_COLORS.contextTotal} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gradHistCtxUsed" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.contextUsed} stopOpacity={0.4} />
                        <stop offset="95%" stopColor={CHART_COLORS.contextUsed} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v} />
                    <Tooltip content={<HistoryTooltip unit=" tokens" range={historyRange} />} />
                    <Area type="monotone" dataKey="cxT" name="Total" stroke={CHART_COLORS.contextTotal} fill="url(#gradHistCtxTotal)" strokeWidth={1} strokeDasharray="4 2" dot={false} animationDuration={500} />
                    <Area type="monotone" dataKey="cxU" name="Used" stroke={CHART_COLORS.contextUsed} fill="url(#gradHistCtxUsed)" strokeWidth={2} dot={false} animationDuration={500} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <div className="chart-empty">No historical data yet</div>}
            </div>
            <div className="chart-legend">
              <div className="chart-legend-item"><span className="chart-legend-dot" style={{ background: CHART_COLORS.contextUsed }}></span>Used</div>
              <div className="chart-legend-item"><span className="chart-legend-dot" style={{ background: CHART_COLORS.contextTotal }}></span>Total</div>
            </div>
          </div>

          {/* Request Queue History */}
          <div className="chart-card-wide">
            <h4>Request Queue <span className="chart-value">active &amp; pending</span></h4>
            <div className="chart-container-wide">
              {historyPoints.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={historyPoints} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <defs>
                      <linearGradient id="gradHistQA" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.queueActive} stopOpacity={0.4} />
                        <stop offset="95%" stopColor={CHART_COLORS.queueActive} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gradHistQP" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.queuePending} stopOpacity={0.4} />
                        <stop offset="95%" stopColor={CHART_COLORS.queuePending} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip content={<HistoryTooltip range={historyRange} />} />
                    <Area type="monotone" dataKey="qA" name="Avg Active" stroke={CHART_COLORS.queueActive} fill="url(#gradHistQA)" strokeWidth={2} dot={false} animationDuration={500} />
                    <Area type="monotone" dataKey="qP" name="Avg Pending" stroke={CHART_COLORS.queuePending} fill="url(#gradHistQP)" strokeWidth={2} dot={false} animationDuration={500} />
                    <Line type="monotone" dataKey="qMx" name="Peak Active" stroke={CHART_COLORS.queueActive} strokeWidth={1} strokeDasharray="4 2" dot={false} animationDuration={500} />
                    <Line type="monotone" dataKey="qMxP" name="Peak Pending" stroke={CHART_COLORS.queuePending} strokeWidth={1} strokeDasharray="4 2" dot={false} animationDuration={500} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <div className="chart-empty">No historical data yet</div>}
            </div>
            <div className="chart-legend">
              <div className="chart-legend-item"><span className="chart-legend-dot" style={{ background: CHART_COLORS.queueActive }}></span>Active</div>
              <div className="chart-legend-item"><span className="chart-legend-dot" style={{ background: CHART_COLORS.queuePending }}></span>Pending</div>
            </div>
          </div>

        </div>

        <h4 className="analytics-section-header">Request Health &amp; Errors</h4>
        <div className="charts-grid-wide">
          {/* Total Requests Over Time (cumulative growth) */}
          <div className="chart-card-wide">
            <h4>Total Requests <span className="chart-value">cumulative growth</span></h4>
            <div className="chart-container-wide">
              {requestGrowthData.length > 0 && requestGrowthData[requestGrowthData.length - 1].total > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={requestGrowthData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <defs>
                      <linearGradient id="gradGrowth" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.tokens} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={CHART_COLORS.tokens} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
                    <Tooltip content={<HistoryTooltip unit=" requests" range={historyRange} />} />
                    <Area type="monotone" dataKey="total" name="Total Requests" stroke={CHART_COLORS.tokens} fill="url(#gradGrowth)" strokeWidth={2} dot={false} animationDuration={500} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <div className="chart-empty">No request data yet</div>}
            </div>
          </div>

          {/* Request Volume History */}
          <div className="chart-card-wide">
            <h4>Request Volume <span className="chart-value">per {historyRange === '1h' ? '5 min' : historyRange === '1d' ? 'hour' : historyRange === '1w' ? '6 hours' : historyRange === '1m' ? 'day' : 'week'}</span></h4>
            <div className="chart-container-wide">
              {requestVolumeData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={requestVolumeData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip content={<HistoryTooltip range={historyRange} />} />
                    <Area type="monotone" dataKey="rOk" name="Success" stroke={CHART_COLORS.requestOk} fill={CHART_COLORS.requestOk} fillOpacity={0.3} strokeWidth={2} dot={false} stackId="req" animationDuration={500} />
                    <Area type="monotone" dataKey="rOf" name="Offloaded" stroke={CHART_COLORS.offloaded} fill={CHART_COLORS.offloaded} fillOpacity={0.3} strokeWidth={2} dot={false} stackId="req" animationDuration={500} />
                    <Area type="monotone" dataKey="rErr" name="Errors" stroke={CHART_COLORS.requestErr} fill={CHART_COLORS.requestErr} fillOpacity={0.3} strokeWidth={2} dot={false} stackId="req" animationDuration={500} />
                    <Area type="monotone" dataKey="rRt" name="Retries" stroke={CHART_COLORS.requestRetry} fill={CHART_COLORS.requestRetry} fillOpacity={0.3} strokeWidth={1} dot={false} animationDuration={500} />
                    <Area type="monotone" dataKey="rRs" name="Restarts" stroke={CHART_COLORS.requestRestart} fill={CHART_COLORS.requestRestart} fillOpacity={0.5} strokeWidth={1} dot={false} animationDuration={500} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <div className="chart-empty">No historical data yet</div>}
            </div>
            <div className="chart-legend">
              <div className="chart-legend-item"><span className="chart-legend-dot" style={{ background: CHART_COLORS.requestOk }}></span>Success</div>
              <div className="chart-legend-item"><span className="chart-legend-dot" style={{ background: CHART_COLORS.offloaded }}></span>Offloaded</div>
              <div className="chart-legend-item"><span className="chart-legend-dot" style={{ background: CHART_COLORS.requestErr }}></span>Errors</div>
              <div className="chart-legend-item"><span className="chart-legend-dot" style={{ background: CHART_COLORS.requestRetry }}></span>Retries</div>
              <div className="chart-legend-item"><span className="chart-legend-dot" style={{ background: CHART_COLORS.requestRestart }}></span>Restarts</div>
            </div>
          </div>

          {/* Request Health % */}
          <div className="chart-card-wide">
            <h4>Request Health <span className="chart-value">% breakdown</span></h4>
            <div className="chart-container-wide">
              {requestHealthPoints.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={requestHealthPoints} margin={{ top: 5, right: 5, left: -20, bottom: 5 }} stackOffset="none">
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                    <YAxis domain={[0, 100]} tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `${v}%`} />
                    <Tooltip content={<HistoryTooltip unit="%" range={historyRange} />} />
                    <Area type="monotone" dataKey="pctOk" name="Local" stroke={CHART_COLORS.requestOk} fill={CHART_COLORS.requestOk} fillOpacity={0.6} strokeWidth={0} dot={false} stackId="pct" animationDuration={500} />
                    <Area type="monotone" dataKey="pctOf" name="Offloaded" stroke={CHART_COLORS.offloaded} fill={CHART_COLORS.offloaded} fillOpacity={0.6} strokeWidth={0} dot={false} stackId="pct" animationDuration={500} />
                    <Area type="monotone" dataKey="pctRt" name="Retries" stroke={CHART_COLORS.requestRetry} fill={CHART_COLORS.requestRetry} fillOpacity={0.6} strokeWidth={0} dot={false} stackId="pct" animationDuration={500} />
                    <Area type="monotone" dataKey="pctRs" name="Restarts" stroke={CHART_COLORS.requestRestart} fill={CHART_COLORS.requestRestart} fillOpacity={0.6} strokeWidth={0} dot={false} stackId="pct" animationDuration={500} />
                    <Area type="monotone" dataKey="pctErr" name="Errors" stroke={CHART_COLORS.requestErr} fill={CHART_COLORS.requestErr} fillOpacity={0.6} strokeWidth={0} dot={false} stackId="pct" animationDuration={500} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <div className="chart-empty">No historical data yet</div>}
            </div>
            <div className="chart-legend">
              <div className="chart-legend-item"><span className="chart-legend-dot" style={{ background: CHART_COLORS.requestOk }}></span>Local</div>
              <div className="chart-legend-item"><span className="chart-legend-dot" style={{ background: CHART_COLORS.offloaded }}></span>Offloaded</div>
              <div className="chart-legend-item"><span className="chart-legend-dot" style={{ background: CHART_COLORS.requestRetry }}></span>Retries</div>
              <div className="chart-legend-item"><span className="chart-legend-dot" style={{ background: CHART_COLORS.requestRestart }}></span>Restarts</div>
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

        <h4 className="analytics-section-header">Model Analytics</h4>
        <div className="charts-grid-wide">
          {/* Model Usage */}
          <div className="chart-card-wide">
            <h4>Requests by Model <span className="chart-value">{Object.values(historyData?.summary?.modelCounts || {}).reduce((a, b) => a + b, 0)} total</span></h4>
            <div className="chart-container-wide">
              {modelUsageData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={modelUsageData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis type="number" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <YAxis type="category" dataKey="model" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} width={180} />
                    <Tooltip content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      return (
                        <div className="chart-tooltip">
                          <div className="chart-tooltip-time">{d.fullModel}</div>
                          <div className="chart-tooltip-row">
                            <span className="chart-tooltip-dot" style={{ background: CHART_COLORS.tokens }} />
                            <span className="chart-tooltip-label">Requests:</span>
                            <span className="chart-tooltip-value">{d.count}</span>
                          </div>
                        </div>
                      );
                    }} />
                    <Bar dataKey="count" name="Requests" fill={CHART_COLORS.tokens} radius={[0, 4, 4, 0]} animationDuration={500} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <div className="chart-empty">No model usage data in this time range</div>}
            </div>
          </div>

          {/* Model Usage Over Time */}
          <div className="chart-card-wide">
            <h4>Model Usage Over Time <span className="chart-value">top {modelUsageOverTime.models.length} models</span></h4>
            <div className="chart-container-wide">
              {modelUsageOverTime.data.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={modelUsageOverTime.data} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis dataKey="time" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip content={<HistoryTooltip range={historyRange} />} />
                    {modelUsageOverTime.models.map((model, i) => (
                      <Line
                        key={model}
                        type="monotone"
                        dataKey={model}
                        name={model.length > 30 ? model.slice(0, 27) + '...' : model}
                        stroke={MODEL_LINE_COLORS[i]}
                        strokeWidth={2}
                        dot={false}
                        animationDuration={500}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              ) : <div className="chart-empty">No model usage data in this time range</div>}
            </div>
            <div className="chart-legend">
              {modelUsageOverTime.models.map((model, i) => (
                <div key={model} className="chart-legend-item">
                  <span className="chart-legend-dot" style={{ background: MODEL_LINE_COLORS[i] }}></span>
                  {model.length > 30 ? model.slice(0, 27) + '...' : model}
                </div>
              ))}
            </div>
          </div>

          {/* Generation Speed by Model */}
          <div className="chart-card-wide">
            <h4>Generation Speed by Model <span className="chart-value">avg tok/s</span></h4>
            <div className="chart-container-wide">
              {(() => {
                const modelTps = historyData?.summary?.modelAvgTps || {};
                const data = Object.entries(modelTps)
                  .map(([model, tps]) => ({ model: model.length > 30 ? model.slice(0, 27) + '...' : model, tps, fullModel: model }))
                  .sort((a, b) => b.tps - a.tps);
                return data.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data} margin={{ top: 5, right: 20, left: 5, bottom: 5 }} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                      <XAxis type="number" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} />
                      <YAxis dataKey="model" type="category" tick={{ fill: '#ccc', fontSize: 11 }} width={180} tickLine={false} axisLine={false} />
                      <Tooltip content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload;
                        return (
                          <div className="chart-tooltip">
                            <div className="chart-tooltip-time">{d.fullModel}</div>
                            <div className="chart-tooltip-row">
                              <span className="chart-tooltip-dot" style={{ background: CHART_COLORS.tokens }} />
                              <span className="chart-tooltip-label">Avg Speed:</span>
                              <span className="chart-tooltip-value">{d.tps} tok/s</span>
                            </div>
                          </div>
                        );
                      }} />
                      <Bar dataKey="tps" name="Avg tok/s" fill={CHART_COLORS.tokens} radius={[0, 4, 4, 0]} animationDuration={500} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : <div className="chart-empty">No per-model speed data in this time range</div>;
              })()}
            </div>
          </div>

          {/* Crashes by Model */}
          <div className="chart-card-wide">
            <h4>Crashes by Model <span className="chart-value">{crashData?.summary?.total || 0} total</span></h4>
            <div className="chart-container-wide">
              {crashByModelData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={crashByModelData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
                    <XAxis type="number" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <YAxis type="category" dataKey="model" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} width={180} />
                    <Tooltip content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      return (
                        <div className="chart-tooltip">
                          <div className="chart-tooltip-time">{d.fullModel}</div>
                          <div className="chart-tooltip-row">
                            <span className="chart-tooltip-dot" style={{ background: '#f97316' }} />
                            <span className="chart-tooltip-label">Crashes:</span>
                            <span className="chart-tooltip-value">{d.count}</span>
                          </div>
                        </div>
                      );
                    }} />
                    <Bar dataKey="count" name="Crashes" fill="#f97316" radius={[0, 4, 4, 0]} animationDuration={500} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <div className="chart-empty">No crashes in this time range</div>}
            </div>
          </div>
        </div>
      </section>
      <ActiveRequestPanel request={activeRequest} />
    </div>
  );
}

export default Dashboard;
