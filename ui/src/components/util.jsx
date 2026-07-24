// Llama Manager — shared dashboard presentation primitives.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Contains reusable stat cards, progress rings, charts, tooltips, and thermal
// severity helpers consumed by dashboard-adjacent views.

import React, { useState, useEffect, useRef } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, AreaChart,
  BarChart, Bar, Cell
} from 'recharts';

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
function ProgressRing({ value, size = 80, strokeWidth = 8, color = 'var(--accent)', segments = null, centerValue = null }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;

  // Multi-segment mode: stack several arcs on one ring (e.g. the CPU gauge
  // showing llama/app load vs the remaining external/system load). Each
  // segment { value (0-100), color } is drawn clockwise from where the
  // previous one ended, so the ring fills to the total of all segments.
  if (segments && segments.length) {
    let cumPct = 0;
    const total = centerValue != null
      ? centerValue
      : segments.reduce((sum, seg) => sum + (seg.value || 0), 0);
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
        {segments.map((seg, i) => {
          const v = Math.max(0, Math.min(100, seg.value || 0));
          const len = (v / 100) * circumference;
          const dashoffset = -(cumPct / 100) * circumference;
          cumPct += v;
          return (
            <circle
              key={i}
              className="progress-ring-fill progress-ring-segment"
              strokeWidth={strokeWidth}
              fill="transparent"
              r={radius}
              cx={size / 2}
              cy={size / 2}
              style={{
                strokeDasharray: `${len} ${circumference}`,
                strokeDashoffset: dashoffset,
                stroke: seg.color
              }}
            />
          );
        })}
        <text x="50%" y="50%" textAnchor="middle" dy=".3em" className="progress-ring-text">
          {Math.round(total)}%
        </text>
      </svg>
    );
  }

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
  appUsage: '#38bdf8',
  tokens: '#3b82f6',
  requestOk: '#22c55e',
  requestErr: '#ef4444',
  requestRetry: '#f59e0b',
  requestRestart: '#f97316',
  contextUsed: '#a78bfa',
  contextTotal: '#4c1d95',
  queueActive: '#06b6d4',
  queuePending: '#f59e0b',
  offloaded: '#8b5cf6'
};

// --- Thermal status helpers -------------------------------------------------
// The API thermal guard (stats.guard) is the SINGLE SOURCE OF TRUTH for the
// box's thermal state. Every temperature/thermal indicator on the dashboard
// derives its severity from here so widgets can never contradict each other
// (e.g. a "good"/green gauge showing while the guard reports Critical).
//
// Thresholds are kept in sync with the API guard so that raw-sensor readouts
// (which have no direct guard context) color themselves the same way the guard
// would: warn ~90°C, critical ~95°C.
const TEMP_WARN_C = 90;
const TEMP_CRIT_C = 95;

const SEVERITY_RANK = { normal: 0, throttled: 1, critical: 2 };

/**
 * Overall thermal severity for the whole box, taken from the guard state.
 * @param {object} [guard] stats.guard — { state, maxTempC, gpuC, cpuC, paused }.
 * @returns {'normal'|'throttled'|'critical'} severity level.
 */
function guardSeverity(guard) {
  const state = guard?.state;
  if (state === 'critical') return 'critical';
  if (state === 'throttled') return 'throttled';
  if (state === 'normal') return 'normal';
  // No guard state available — fall back to the hottest reported sensor.
  const t = guard?.maxTempC;
  if (t == null) return 'normal';
  if (t >= TEMP_CRIT_C) return 'critical';
  if (t >= TEMP_WARN_C) return 'throttled';
  return 'normal';
}

/**
 * Thermal severity for a single sensor readout (e.g. the CPU or GPU temp).
 * Uses the sensor's own value against the guard-aligned thresholds, but is
 * floored by the guard state whenever this sensor is (near) the guard's
 * hottest reading — so the sensor driving a Critical guard can never render
 * as "good"/green.
 * @param {number} [sensorC] the sensor temperature in °C.
 * @param {object} [guard] stats.guard for context.
 * @returns {'normal'|'throttled'|'critical'} severity level.
 */
function sensorSeverity(sensorC, guard) {
  let sev = 'normal';
  if (sensorC != null) {
    if (sensorC >= TEMP_CRIT_C) sev = 'critical';
    else if (sensorC >= TEMP_WARN_C) sev = 'throttled';
  }
  // If this reading is the one driving the guard, inherit the guard's severity.
  if (guard?.maxTempC != null && sensorC != null && sensorC >= guard.maxTempC - 0.5) {
    const g = guardSeverity(guard);
    if (SEVERITY_RANK[g] > SEVERITY_RANK[sev]) sev = g;
  }
  return sev;
}

/**
 * Maps a thermal severity to its dashboard CSS color variable.
 * @param {'normal'|'throttled'|'critical'} severity
 * @returns {string} a CSS color value.
 */
function severityColor(severity) {
  if (severity === 'critical') return 'var(--error)';
  if (severity === 'throttled') return 'var(--warning)';
  return 'var(--success)';
}

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

// Color scheme for backend distinction. Local = greens; each remote backend
// gets a stable color derived from its name hash so the same backend looks
// the same every render.
const LOCAL_BAR_COLOR = '#10b981';
const REMOTE_BAR_PALETTE = ['#3b82f6', '#a855f7', '#f59e0b', '#06b6d4', '#ec4899', '#ef4444', '#84cc16', '#f97316'];
function backendColor(backend) {
  if (!backend) return LOCAL_BAR_COLOR;
  let h = 0;
  for (let i = 0; i < backend.length; i++) h = (h * 31 + backend.charCodeAt(i)) & 0xffffffff;
  return REMOTE_BAR_PALETTE[Math.abs(h) % REMOTE_BAR_PALETTE.length];
}

// Horizontal bar chart ranking models by tok/s for a given window
// ('24h' | '7d' | '30d' | 'all'), fastest at the top. Data source:
// /api/analytics/models which aggregates the full analytics history,
// so it includes every model that has ever served traffic (not just
// the in-memory recent-requests buffer).
function ModelTpsRankChart({ modelBreakdown, window = 'all', height = 200 }) {
  const data = React.useMemo(() => {
    const models = modelBreakdown?.models || [];
    return models
      .map(m => ({
        key: m.name,
        // Keep backend prefix in the label but visually demote it so the
        // actual model name reads first; the color encodes the host too.
        backend: m.backend,
        model: m.model,
        isRemote: m.isRemote,
        label: m.isRemote ? `${m.backend} · ${m.model}` : m.model,
        tps: m.windows?.[window]?.tps || 0,
        requests: m.windows?.[window]?.requests || 0
      }))
      .filter(d => d.tps > 0)
      .sort((a, b) => b.tps - a.tps)
      .slice(0, 5);  // Top 5 fastest only — keep the widget compact
  }, [modelBreakdown, window]);

  if (data.length === 0) {
    return (
      <div className="chart-container" style={{ height }}>
        <div className="chart-empty">No per-model speed data for this window yet</div>
      </div>
    );
  }

  // Truncate long labels from the front so the model name stays readable
  const labelFor = (d) => d.label.length > 38 ? '…' + d.label.slice(-37) : d.label;

  return (
    <div className="chart-container" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 5, right: 48, left: 5, bottom: 5 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" horizontal={false} />
          <XAxis type="number" tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
          <YAxis
            type="category"
            dataKey="label"
            tick={({ x, y, payload }) => {
              const d = data.find(r => r.label === payload.value);
              if (!d) return null;
              return (
                <g transform={`translate(${x},${y})`}>
                  <text x={-6} y={0} dy={4} textAnchor="end" fill={d.isRemote ? '#9ca3af' : '#10b981'} fontSize={11}>
                    {labelFor(d)}
                  </text>
                </g>
              );
            }}
            tickLine={false}
            axisLine={false}
            width={260}
          />
          <Tooltip content={<ChartTooltip unit=" tok/s" />} />
          <Bar dataKey="tps" name="tok/s" radius={[0, 4, 4, 0]} label={{ position: 'right', fill: '#ccc', fontSize: 11, formatter: (v) => v.toFixed(1) }}>
            {data.map((entry) => (
              <Cell key={entry.key} fill={backendColor(entry.backend)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Tabular long-term breakdown: per model, average tok/s for 24h / 7d / 30d /
// all-time windows. Color-codes the backend cell so users can tell local
// vs each remote backend at a glance.
function ModelPerformanceBreakdown({ modelBreakdown }) {
  // Stale models (no activity in the last 24h) are collapsed behind a
  // "show more" toggle by default so the table only surfaces what ran recently.
  const [showStale, setShowStale] = useState(false);
  const models = modelBreakdown?.models || [];
  if (models.length === 0) {
    return <div className="chart-empty">No model data yet</div>;
  }
  const windows = [
    { key: '24h', label: '24h' },
    { key: '7d', label: '7 days' },
    { key: '30d', label: '30 days' },
    { key: 'all', label: 'all time' }
  ];
  // A model is "active" if it has a real tok/s value in the last 24h window.
  const isActive24h = (m) => (m.windows?.['24h']?.tps || 0) > 0;
  const activeModels = models.filter(isActive24h);
  const staleModels = models.filter(m => !isActive24h(m));
  const visibleModels = showStale ? [...activeModels, ...staleModels] : activeModels;

  const renderRow = (m) => (
    <tr key={m.name}>
      <td>
        <span className="model-backend-pill" style={{ background: backendColor(m.backend), color: '#0a0a0a' }}>
          {m.isRemote ? m.backend : 'local'}
        </span>
      </td>
      <td className="model-cell-name" title={m.model}>{m.model}</td>
      {windows.map(w => {
        const t = m.windows?.[w.key]?.tps || 0;
        const r = m.windows?.[w.key]?.requests || 0;
        return (
          <td key={w.key} className="num">
            {t > 0 ? (
              <>
                <span className="model-tps-val">{t.toFixed(1)}</span>
                <span className="model-tps-unit"> tok/s</span>
                <div className="model-tps-reqs">{r.toLocaleString()} req</div>
              </>
            ) : <span className="model-tps-empty">—</span>}
          </td>
        );
      })}
      <td className="num">{(m.windows?.all?.requests || 0).toLocaleString()}</td>
    </tr>
  );

  return (
    <div className="model-breakdown-table-wrap">
      <table className="model-breakdown-table">
        <thead>
          <tr>
            <th>Host</th>
            <th>Model</th>
            {windows.map(w => <th key={w.key} className="num">{w.label}</th>)}
            <th className="num">requests (all)</th>
          </tr>
        </thead>
        <tbody>
          {visibleModels.length === 0 && (
            <tr>
              <td colSpan={windows.length + 3} className="model-breakdown-none">
                No models active in the last 24h
              </td>
            </tr>
          )}
          {visibleModels.map(renderRow)}
        </tbody>
      </table>
      {staleModels.length > 0 && (
        <button
          type="button"
          className="model-breakdown-toggle"
          onClick={() => setShowStale(s => !s)}
        >
          {showStale ? 'Show less' : `Show ${staleModels.length} more`}
        </button>
      )}
    </div>
  );
}

// Format a tok/s statistic; null (no samples) renders as an em dash.
function fmtTps(v) {
  return v == null ? '—' : v.toFixed(1);
}

// Format a millisecond duration compactly: sub-second in ms, otherwise
// seconds with one decimal below a minute and whole seconds above it.
function fmtMs(v) {
  if (v == null) return '—';
  if (v < 1000) return `${Math.round(v)}ms`;
  const s = v / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

// Per-model request statistics table backed by /api/analytics/request-stats,
// which reads the durable per-request store rather than minute-level averages —
// the only way median/min/max tok/s and TTFT can be reported at all. Each model
// row expands to the same statistics bucketed by how many generations were
// running concurrently ("slots"), so throughput degradation under load is
// visible per model. TTFT is llama.cpp's prompt-processing (prefill) time;
// remote backends report no timings, so theirs shows as "—".
function ModelRequestStatsTable({ requestStats, window, onWindowChange }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const models = requestStats?.models || [];

  const toggle = (name) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const windows = [
    { key: '24h', label: '24h' },
    { key: '7d', label: '7d' },
    { key: '30d', label: '30d' },
    { key: 'all', label: 'all' }
  ];

  const statCells = (s, { bold = false } = {}) => (
    <>
      <td className="num">{s.requests.toLocaleString()}</td>
      <td className={bold ? 'num model-tps-val' : 'num'}>{fmtTps(s.avgTps)}</td>
      <td className="num">{fmtTps(s.medianTps)}</td>
      <td className="num">{fmtTps(s.minTps)}</td>
      <td className="num">{fmtTps(s.maxTps)}</td>
      <td className="num">{fmtMs(s.avgDuration)}</td>
      <td className="num">
        {s.avgTtft == null
          ? <span className="model-tps-empty" title="Engine reported no prefill timings">—</span>
          : fmtMs(s.avgTtft)}
      </td>
    </>
  );

  return (
    <div className="model-breakdown-table-wrap">
      <div className="request-stats-windows">
        {windows.map(w => (
          <button
            key={w.key}
            type="button"
            className={`request-stats-window${window === w.key ? ' active' : ''}`}
            onClick={() => onWindowChange(w.key)}
          >
            {w.label}
          </button>
        ))}
      </div>
      <table className="model-breakdown-table">
        <thead>
          <tr>
            <th>Model</th>
            <th className="num">Requests</th>
            <th className="num">Avg TPS</th>
            <th className="num">Median TPS</th>
            <th className="num">Min TPS</th>
            <th className="num">Max TPS</th>
            <th className="num">Avg Duration</th>
            <th className="num">Avg TTFT</th>
          </tr>
        </thead>
        <tbody>
          {models.length === 0 && (
            <tr>
              <td colSpan={8} className="model-breakdown-none">
                No per-request samples in this window yet
              </td>
            </tr>
          )}
          {models.map(m => {
            const isOpen = expanded.has(m.name);
            return (
              <React.Fragment key={m.name}>
                <tr className="request-stats-model-row" onClick={() => toggle(m.name)}>
                  <td className="model-cell-name" title={m.name}>
                    <span className="request-stats-caret">{isOpen ? '▾' : '▸'}</span>
                    {m.isRemote && (
                      <span
                        className="model-backend-pill"
                        style={{ background: backendColor(m.backend), color: '#0a0a0a' }}
                      >
                        {m.backend}
                      </span>
                    )}
                    {m.model}
                  </td>
                  {statCells(m, { bold: true })}
                </tr>
                {isOpen && m.slots.map(s => (
                  <tr key={`${m.name}:${s.slots}`} className="request-stats-slot-row">
                    <td className="request-stats-slot-label">
                      {s.slots} {s.slots === 1 ? 'slot' : 'slots'}
                    </td>
                    {statCells(s)}
                  </tr>
                ))}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// GPU/CPU compute-usage chart. Mirrors TemperatureChart but plots
// utilization % so users can see when the iGPU is actually loaded
// (and how that correlates with CPU spikes during prompt processing).
function UsageChart({ data, height = 140 }) {
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
            <linearGradient id="gradGpuUse" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLORS.temperature} stopOpacity={0.3} />
              <stop offset="95%" stopColor={CHART_COLORS.temperature} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradCpuUse" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLORS.temperatureCpu} stopOpacity={0.2} />
              <stop offset="95%" stopColor={CHART_COLORS.temperatureCpu} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradAppUse" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLORS.appUsage} stopOpacity={0.2} />
              <stop offset="95%" stopColor={CHART_COLORS.appUsage} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
          <XAxis dataKey="timestamp" hide />
          <YAxis domain={[0, 100]} tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTooltip unit="%" />} />
          <Area type="monotone" dataKey="gpu" name="GPU" stroke={CHART_COLORS.temperature} fill="url(#gradGpuUse)" strokeWidth={2} dot={false} />
          <Area type="monotone" dataKey="cpu" name="CPU" stroke={CHART_COLORS.temperatureCpu} fill="url(#gradCpuUse)" strokeWidth={2} dot={false} strokeDasharray="4 2" />
          <Area type="monotone" dataKey="appCpu" name="App CPU" stroke={CHART_COLORS.appUsage} fill="url(#gradAppUse)" strokeWidth={2} dot={false} strokeDasharray="2 2" />
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
            <linearGradient id="gradAppMem" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLORS.appUsage} stopOpacity={0.2} />
              <stop offset="95%" stopColor={CHART_COLORS.appUsage} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
          <XAxis dataKey="timestamp" hide />
          <YAxis domain={[0, 100]} tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTooltip unit="%" />} />
          <Area type="monotone" dataKey={primaryKey} name={primaryKey.toUpperCase()} stroke={CHART_COLORS.memory} fill="url(#gradMem)" strokeWidth={2} dot={false} />
          <Area type="monotone" dataKey="system" name="System" stroke={CHART_COLORS.memorySecondary} fill="url(#gradSys)" strokeWidth={2} dot={false} strokeDasharray="4 2" />
          <Area type="monotone" dataKey="app" name="App" stroke={CHART_COLORS.appUsage} fill="url(#gradAppMem)" strokeWidth={2} dot={false} strokeDasharray="2 2" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// Model line colors for per-model charts
const MODEL_SPEED_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a78bfa', '#06b6d4', '#f97316', '#ec4899'];

// Tokens/sec Chart Component — shows separate lines per model
function TokensChart({ data, height = 140 }) {
  if (!data || data.length < 1) {
    return (
      <div className="chart-container" style={{ height }}>
        <div className="chart-empty">Collecting data...</div>
      </div>
    );
  }

  // Find all unique models with actual generation (tokensPerSecond > 0)
  const modelSet = new Set();
  for (const d of data) {
    if (d.model && d.tokensPerSecond > 0) modelSet.add(d.model);
  }
  const models = [...modelSet];

  // If only zero-fill points (no models), show simple aggregate
  if (models.length === 0) {
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

  // Transform data: two keys per model — `m` for carry-forward (dotted), `m__real` for actual (solid)
  const lastKnown = {};
  const transformed = data.map(d => {
    const point = { timestamp: d.timestamp };
    if (d.model && d.tokensPerSecond > 0) {
      lastKnown[d.model] = d.tokensPerSecond;
    }
    for (const m of models) {
      const isReal = d.model === m && d.tokensPerSecond > 0;
      point[m] = isReal ? d.tokensPerSecond : (lastKnown[m] || null);       // carry-forward (dotted)
      point[m + '__real'] = isReal ? d.tokensPerSecond : null;               // real only (solid)
    }
    return point;
  });

  const maxTokens = Math.max(...data.map(d => d.tokensPerSecond || 0), 10);
  const shortName = (m) => m.length > 25 ? m.slice(0, 22) + '...' : m;

  return (
    <div className="chart-container" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={transformed} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
          <XAxis dataKey="timestamp" hide />
          <YAxis domain={[0, Math.ceil(maxTokens / 5) * 5]} tick={{ fill: '#888', fontSize: 10 }} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTooltip unit=" tok/s" />} />
          {models.map((m, i) => {
            const color = MODEL_SPEED_COLORS[i % MODEL_SPEED_COLORS.length];
            return (
              <React.Fragment key={m}>
                <Line type="monotone" dataKey={m} name={shortName(m)} stroke={color} strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls={false} strokeOpacity={0.5} />
                <Line type="monotone" dataKey={m + '__real'} name={null} stroke={color} strokeWidth={2} dot={false} connectNulls={true} legendType="none" tooltipType="none" />
              </React.Fragment>
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// Active Request Panel — shows current request being processed
function ActiveRequestPanel({ request, isFullscreen }) {
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);
  const responseRef = useRef(null);

  // Auto-scroll response when streaming
  useEffect(() => {
    if (expanded && responseRef.current) {
      responseRef.current.scrollTop = responseRef.current.scrollHeight;
    }
  }, [expanded, request?.responseText]);

  // Auto-dismiss when request ends (unless pinned)
  const isActive = request?.status === 'processing';

  if (!request) return null;

  const elapsed = request.duration || (Date.now() - request.startTime);
  const userMsg = request.userMessage || '';
  const truncated = userMsg.length > 120 ? userMsg.slice(0, 120) + '...' : userMsg;

  return (
    <div className={`active-request-panel ${isFullscreen ? 'fullscreen' : ''} ${expanded ? 'expanded' : ''} ${isActive ? 'active' : 'ended'}`}>
      <div className="active-request-header" onClick={() => setExpanded(!expanded)}>
        <div className="active-request-indicator">
          {isActive ? <span className="active-dot pulse" /> : <span className="active-dot done" />}
        </div>
        <div className="active-request-info">
          <span className="active-request-model">{request.model}</span>
          {request.backend && request.backend !== 'local' && (
            <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: '3px', fontSize: '0.75em', background: '#2d1b69', color: '#a78bfa', marginRight: '6px' }}>
              {request.backend}
            </span>
          )}
          <span className="active-request-prompt">{truncated || 'Processing...'}</span>
        </div>
        <div className="active-request-meta">
          {request.tokens > 0 && <span className="active-request-tokens">{request.tokens} tok</span>}
          <span className="active-request-time">{(elapsed / 1000).toFixed(1)}s</span>
        </div>
        {(expanded || pinned) && (
          <button className="active-request-close" onClick={(e) => { e.stopPropagation(); setPinned(false); setExpanded(false); }}>
            {'\u2715'}
          </button>
        )}
      </div>
      {expanded && (
        <div className="active-request-body">
          <div className="active-request-section">
            <div className="active-request-label">Input</div>
            <div className="active-request-content user-input">{userMsg}</div>
          </div>
          <div className="active-request-section">
            <div className="active-request-label">
              Response
              {isActive && <span className="streaming-indicator">streaming...</span>}
            </div>
            <div className="active-request-content response-output" ref={responseRef}>
              {request.responseText || (isActive ? 'Waiting for response...' : 'No response')}
            </div>
          </div>
          {!pinned && (
            <button className="active-request-pin" onClick={() => setPinned(true)}>
              Pin open
            </button>
          )}
        </div>
      )}
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

export {
  StatCard,
  ProgressRing,
  CHART_COLORS,
  guardSeverity,
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
};
