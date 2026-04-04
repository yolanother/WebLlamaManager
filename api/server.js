import express from 'express';
import cors from 'cors';
import { spawn, exec, execSync } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, rmdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { cpus, totalmem, freemem, loadavg } from 'os';
import { EventEmitter } from 'events';
import pty from 'node-pty';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Agent: UndiciAgent } = require('undici');

// Custom dispatcher with extended timeouts for slow/large models (e.g. 120B reasoning models)
// Default undici headersTimeout is 300s which is too short for prompt processing on large models
const llamaDispatcher = new UndiciAgent({
  headersTimeout: 0,   // Disable headers timeout — large models can take minutes to start generating
  bodyTimeout: 0,      // Disable body timeout — streaming can have long pauses between tokens
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: 600000
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(__dirname);

// Load .env from project root (optional) to make DISTROBOX_CONTAINER configurable
import dotenv from 'dotenv';
dotenv.config({ path: join(PROJECT_ROOT, '.env') });

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

app.use(cors());
app.use(express.json({ limit: '200mb' }));

// Request logging middleware
const REQUEST_LOG_SKIP_PATHS = new Set(['/ws', '/api/stats', '/api/analytics', '/api/analytics/history', '/health', '/api/v1/health']);
const STATIC_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)$/;

app.use((req, res, next) => {
  const path = req.path;
  if (REQUEST_LOG_SKIP_PATHS.has(path)) return next();
  if (!path.startsWith('/api/') && STATIC_EXTENSIONS.test(path)) return next();

  // Always track basic request stats for analytics, even when detailed logging is off
  if (!config.requestLogging) {
    const origEnd = res.end;
    res.end = function(chunk, ...args) {
      requestStatsAccum.total++;
      if (res.statusCode < 400) {
        requestStatsAccum.ok++;
      } else {
        requestStatsAccum.err++;
      }
      const sc = String(res.statusCode);
      requestStatsAccum.statusCodes[sc] = (requestStatsAccum.statusCodes[sc] || 0) + 1;
      return origEnd.apply(this, [chunk, ...args]);
    };
    return next();
  }

  const start = Date.now();
  let responseSize = 0;

  const origWrite = res.write;
  const origEnd = res.end;

  let errorBody = '';

  res.write = function(chunk, ...args) {
    if (chunk) {
      responseSize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      // Capture error response body (limit to 4KB)
      if (res.statusCode >= 400 && errorBody.length < 4096) {
        errorBody += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      }
    }
    return origWrite.apply(this, [chunk, ...args]);
  };

  res.end = function(chunk, ...args) {
    if (chunk) {
      responseSize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (res.statusCode >= 400 && errorBody.length < 4096) {
        errorBody += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      }
    }
    const duration = Date.now() - start;

    // Try to extract a readable error message from the response body
    let errorMessage = null;
    if (res.statusCode >= 400) {
      try {
        const parsed = JSON.parse(errorBody);
        errorMessage = parsed?.error?.message || parsed?.error || parsed?.message || errorBody;
        if (typeof errorMessage === 'object') errorMessage = JSON.stringify(errorMessage);
      } catch {
        errorMessage = errorBody || res.statusMessage;
      }
      if (errorMessage && errorMessage.length > 4096) errorMessage = errorMessage.slice(0, 4096) + '...';
    }

    const entry = {
      id: Date.now() + Math.random(),
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl || req.path,
      status: res.statusCode,
      duration,
      requestSize: req.headers['content-length'] ? parseInt(req.headers['content-length']) : 0,
      responseSize,
      ip: req.ip || req.connection?.remoteAddress,
      userAgent: req.headers['user-agent'] || '',
      model: req.body?.model || null,
      stream: req.body?.stream || false,
      error: errorMessage,
      retries: req._retryInfo?.retries || 0,
      retryErrors: req._retryInfo?.retryErrors || [],
      restarted: req._retryInfo?.restarted || false,
      backend: req._backend || 'local'
    };

    // Track request stats for analytics
    requestStatsAccum.total++;
    if (res.statusCode < 400) {
      requestStatsAccum.ok++;
    } else {
      requestStatsAccum.err++;
    }
    const sc = String(res.statusCode);
    requestStatsAccum.statusCodes[sc] = (requestStatsAccum.statusCodes[sc] || 0) + 1;

    addRequestLog(entry);
    return origEnd.apply(this, [chunk, ...args]);
  };

  next();
});

// Serve static files from the UI build
const UI_BUILD_PATH = join(PROJECT_ROOT, 'ui', 'dist');
if (existsSync(UI_BUILD_PATH)) {
  app.use(express.static(UI_BUILD_PATH));
}

// Configuration
const CONFIG_PATH = join(PROJECT_ROOT, 'config.json');
const MODELS_DIR = process.env.MODELS_DIR || join(process.env.HOME, 'models');
const CONTAINER_NAME = process.env.DISTROBOX_CONTAINER || 'llama-rocm-7rc-rocwmma';
const API_PORT = process.env.API_PORT || 3001;
const LLAMA_PORT = process.env.LLAMA_PORT || 8080;
const LLAMA_UI_URL = process.env.LLAMA_UI_URL || null; // Optional override for llama.cpp UI URL

// Python venv for huggingface CLI (created by install.sh)
const VENV_PATH = join(PROJECT_ROOT, '.venv');
// Newer versions use 'hf', older versions use 'huggingface-cli'
const HF_CLI_PATH = existsSync(join(VENV_PATH, 'bin', 'hf'))
  ? join(VENV_PATH, 'bin', 'hf')
  : join(VENV_PATH, 'bin', 'huggingface-cli');

// State
let llamaProcess = null;
let downloadProcesses = new Map();
let currentMode = 'router'; // 'router' or 'single'
let currentPreset = null;
let lastUsedModel = null;   // most recently used model name
let lastUsedModelTime = 0;  // timestamp of last use
let idleShutdown = false;   // true when server was stopped due to idle timeout

// Request concurrency limiter for llama.cpp upstream requests
class RequestQueue {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
    this.queuedCount = 0; // total requests that had to wait
    this._nextId = 1;
    this.activeItems = new Map(); // id -> { id, model, endpoint, startTime }
  }

  setConcurrency(n) {
    this.concurrency = Math.max(1, n);
    this._drain();
  }

  async acquire(meta = {}) {
    const id = this._nextId++;
    const item = { id, ...meta, enqueuedAt: Date.now(), status: 'active' };
    if (this.running < this.concurrency) {
      this.running++;
      item.startedAt = Date.now();
      this.activeItems.set(id, item);
      return id;
    }
    this.queuedCount++;
    item.status = 'pending';
    return new Promise((resolve, reject) => {
      item._resolve = resolve;
      item._reject = reject;
      this.queue.push(item);
    });
  }

  flush() {
    const count = this.queue.length;
    for (const entry of this.queue) {
      entry._reject(new Error('Queue flushed'));
    }
    this.queue = [];
    return count;
  }

  cancel(id) {
    const idx = this.queue.findIndex(e => e.id === id);
    if (idx >= 0) {
      const entry = this.queue.splice(idx, 1)[0];
      entry._reject(new Error('Request cancelled'));
      return true;
    }
    return false;
  }

  release(id) {
    this.running--;
    if (id) this.activeItems.delete(id);
    this._drain();
  }

  _drain() {
    while (this.queue.length > 0 && this.running < this.concurrency) {
      this.running++;
      const item = this.queue.shift();
      item.status = 'active';
      item.startedAt = Date.now();
      this.activeItems.set(item.id, item);
      item._resolve(item.id);
    }
  }

  get pending() { return this.queue.length; }
  get active() { return this.running; }

  // Get all items (active + pending) for the queue management UI
  getItems() {
    const active = [...this.activeItems.values()].map(i => ({
      id: i.id, model: i.model || 'unknown', endpoint: i.endpoint || '',
      enqueuedAt: i.enqueuedAt, startedAt: i.startedAt, status: 'active',
      elapsed: Date.now() - (i.startedAt || i.enqueuedAt)
    }));
    const pending = this.queue.map(i => ({
      id: i.id, model: i.model || 'unknown', endpoint: i.endpoint || '',
      enqueuedAt: i.enqueuedAt, startedAt: null, status: 'pending',
      elapsed: Date.now() - i.enqueuedAt
    }));
    return [...active, ...pending];
  }
}

const llamaQueue = new RequestQueue(1); // default: 1 concurrent request

// Remote backend load balancing
const backendQueues = new Map();  // backend.id -> RequestQueue
const backendStats = new Map();   // backend.id -> { totalRequests, successRequests, errorRequests, ... }
let offloadCounter = 0; // rolling counter for percentage-based offloading

function initBackendQueues() {
  backendQueues.clear();
  const dir = config?.backends?.directory || [];
  for (const backend of dir) {
    backendQueues.set(backend.id, new RequestQueue(backend.maxConcurrentRequests || 5));
    if (!backendStats.has(backend.id)) {
      backendStats.set(backend.id, {
        id: backend.id,
        totalRequests: 0,
        successRequests: 0,
        errorRequests: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalCostUsd: 0,
        totalDurationMs: 0,
        avgTokPerSec: 0,
        lastUsed: null,
        recentLatencies: []
      });
    }
  }
}

// Resolve a model name against a mapping (supports exact match, glob patterns, * catch-all)
function resolveModelMapping(mapping, requestedModel) {
  if (!mapping) return null;
  // 1. Exact match
  if (mapping[requestedModel]) return mapping[requestedModel];
  // 2. Glob pattern match (e.g. "qwen*" matches "qwen-32b")
  for (const [pattern, target] of Object.entries(mapping)) {
    if (pattern === '*' || pattern === requestedModel) continue;
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    if (regex.test(requestedModel)) return target;
  }
  // 3. Wildcard catch-all
  if (mapping['*']) return mapping['*'];
  return null;
}

// Resolve which backend should handle a request
function resolveBackend(requestedModel, endpoint) {
  const backends = config.backends || {};
  if (!backends.enabled || !backends.directory?.length) {
    return { remote: false };
  }

  // Check for explicit backend prefix: "backendId/modelName"
  const slashIdx = requestedModel.indexOf('/');
  if (slashIdx > 0) {
    const prefix = requestedModel.substring(0, slashIdx);
    const explicitBackend = backends.directory.find(b => b.id === prefix && b.enabled && b.tested);
    if (explicitBackend) {
      const remoteModel = requestedModel.substring(slashIdx + 1);
      return buildRemoteRouting(explicitBackend, remoteModel, endpoint);
    }
  }

  // Evaluate offload policy
  const policy = backends.offloadPolicy || 'overflow';
  let shouldOffload = false;

  if (policy === 'manual') {
    // Only offload via explicit prefix (handled above)
    return { remote: false };
  } else if (policy === 'overflow') {
    // Offload when local queue is at capacity (active requests >= concurrency limit)
    // This triggers offload for the current request that would otherwise have to wait
    shouldOffload = llamaQueue.active >= llamaQueue.concurrency;
  } else if (policy === 'threshold') {
    const queueDepth = backends.offloadThresholdQueueDepth ?? 2;
    const waitMs = backends.offloadThresholdWaitMs ?? 5000;
    shouldOffload = llamaQueue.pending >= queueDepth;
    // Estimate wait based on average recent request duration
    if (!shouldOffload && waitMs > 0) {
      const recentDurations = tokenStats.recentRequests.slice(-10).map(r => r.duration || 0);
      if (recentDurations.length > 0) {
        const avgDuration = recentDurations.reduce((a, b) => a + b, 0) / recentDurations.length;
        const estimatedWait = llamaQueue.pending * avgDuration;
        shouldOffload = estimatedWait > waitMs;
      }
    }
  } else if (policy === 'percentage') {
    const pct = backends.offloadPercentage || 0;
    if (pct > 0) {
      offloadCounter = (offloadCounter + 1) % 100;
      shouldOffload = offloadCounter < pct;
    }
  }

  // For all policies: if a different model is currently loaded/active and we'd need a model switch,
  // prefer offloading to avoid the expensive switch wait
  if (!shouldOffload && llamaQueue.active > 0 && lastUsedModel && lastUsedModel !== requestedModel) {
    shouldOffload = true;
  }

  if (!shouldOffload) {
    return { remote: false };
  }

  // Pick best backend (must be enabled, tested, and have a model mapping)
  const endpointKey = endpoint.replace(/\//g, '/');
  const candidates = backends.directory.filter(b => {
    if (!b.enabled) return false;
    if (!b.tested) return false; // Must pass a connectivity test before use
    if (b.supportedEndpoints && !b.supportedEndpoints.includes(endpointKey)) return false;
    // Check model mapping (exact match, glob patterns, or * catch-all)
    if (!b.modelMapping) return false;
    return !!resolveModelMapping(b.modelMapping, requestedModel);
  });

  if (candidates.length === 0) {
    return { remote: false };
  }

  // Sort by priority, then sharedResourceWeight, then lowest active count
  candidates.sort((a, b) => {
    const pa = a.priority ?? 50;
    const pb = b.priority ?? 50;
    if (pa !== pb) return pa - pb;
    const wa = a.sharedResourceWeight ?? 0;
    const wb = b.sharedResourceWeight ?? 0;
    if (wa !== wb) return wa - wb;
    const qa = backendQueues.get(a.id)?.active || 0;
    const qb = backendQueues.get(b.id)?.active || 0;
    return qa - qb;
  });

  const chosen = candidates[0];
  const remoteModel = resolveModelMapping(chosen.modelMapping, requestedModel);
  return buildRemoteRouting(chosen, remoteModel, endpoint);
}

function buildRemoteRouting(backend, remoteModel, endpoint) {
  const baseUrl = backend.url.replace(/\/+$/, '');
  const apiKey = backend.apiKeyEnvVar ? process.env[backend.apiKeyEnvVar] : null;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  // Forward extra headers if configured
  if (backend.extraHeaders) {
    Object.assign(headers, backend.extraHeaders);
  }
  return {
    remote: true,
    backend,
    targetUrl: `${baseUrl}/${endpoint}`,
    targetModel: remoteModel,
    headers
  };
}

// Fetch from a remote backend with retry and per-backend queue
async function fetchRemoteBackend(backend, url, options, { label = 'remote', model } = {}) {
  const queue = backendQueues.get(backend.id);
  if (!queue) {
    throw new Error(`No queue for backend ${backend.id}`);
  }

  const queueStart = Date.now();
  await queue.acquire();
  const queueWait = Date.now() - queueStart;
  if (queueWait > 100) {
    console.log(`[${label}][${backend.name}] Queued for ${queueWait}ms`);
  }

  const stats = backendStats.get(backend.id);
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), backend.timeoutMs || 120000);
    const fetchOptions = { ...options, signal: controller.signal };

    let lastError;
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, fetchOptions);
        clearTimeout(timeout);

        const duration = Date.now() - startTime;
        if (stats) {
          stats.totalRequests++;
          stats.lastUsed = Date.now();
          if (response.ok) {
            stats.successRequests++;
          } else {
            stats.errorRequests++;
          }
          stats.totalDurationMs += duration;
          stats.recentLatencies.push(duration);
          if (stats.recentLatencies.length > 20) stats.recentLatencies.shift();
        }

        return { response, retries: attempt, backend };
      } catch (err) {
        clearTimeout(timeout);
        lastError = err;
        if (attempt < maxRetries) {
          const delay = 1000 * Math.pow(2, attempt);
          console.log(`[${label}][${backend.name}] Retry ${attempt + 1}/${maxRetries}: ${err.message}`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    if (stats) {
      stats.totalRequests++;
      stats.errorRequests++;
      stats.lastUsed = Date.now();
    }
    throw lastError;
  } finally {
    queue.release();
  }
}

// Calculate cost for a remote backend request
function calculateBackendCost(backend, promptTokens, completionTokens) {
  const costs = backend.costs || {};
  const inputCost = (promptTokens / 1_000_000) * (costs.inputTokenCostPer1M || 0);
  const outputCost = (completionTokens / 1_000_000) * (costs.outputTokenCostPer1M || 0);
  return inputCost + outputCost;
}

// Update backend stats after a completed request with token info
function updateBackendTokenStats(backendId, promptTokens, completionTokens, duration, backend) {
  const stats = backendStats.get(backendId);
  if (!stats) return;
  stats.totalPromptTokens += promptTokens;
  stats.totalCompletionTokens += completionTokens;
  if (duration > 0 && completionTokens > 0) {
    const tps = completionTokens / (duration / 1000);
    // Exponential moving average for tok/s
    stats.avgTokPerSec = stats.avgTokPerSec === 0 ? tps : stats.avgTokPerSec * 0.8 + tps * 0.2;
  }
  if (backend) {
    const cost = calculateBackendCost(backend, promptTokens, completionTokens);
    stats.totalCostUsd += cost;
  }
  // Track in per-minute accumulator
  requestStatsAccum.offloaded++;
  requestStatsAccum.backendCounts[backendId] = (requestStatsAccum.backendCounts[backendId] || 0) + 1;
}

// Analytics data storage (circular buffers for time-series data)
const MAX_ANALYTICS_POINTS = 300; // 5 minutes at 1 second intervals
const analyticsData = {
  temperature: [],   // { timestamp, gpu, cpu }
  power: [],         // { timestamp, watts }
  memory: [],        // { timestamp, vram, gtt, system }
  tokens: [],        // { timestamp, promptTokens, completionTokens, tokensPerSecond, model }
  context: [],       // { timestamp, usedContext, totalContext, usage }
  queue: []          // { timestamp, active, pending, concurrency }
};

// Persistent analytics storage (minute-level aggregates in JSONL file)
const ANALYTICS_DIR = join(PROJECT_ROOT, 'data');
const ANALYTICS_FILE = join(ANALYTICS_DIR, 'analytics.jsonl');
const MAX_ANALYTICS_HISTORY = 525600; // 1 year of minute-level data
let analyticsHistory = [];

// Crash event log — tracks which models were active when crashes occur
const CRASH_LOG_FILE = join(ANALYTICS_DIR, 'crashes.jsonl');
let crashHistory = [];

function loadCrashHistory() {
  try {
    if (existsSync(CRASH_LOG_FILE)) {
      const lines = readFileSync(CRASH_LOG_FILE, 'utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try { crashHistory.push(JSON.parse(line)); } catch { /* skip */ }
      }
      console.log(`[analytics] Loaded ${crashHistory.length} crash events`);
    }
  } catch (err) {
    console.error('[analytics] Failed to load crash history:', err.message);
  }
}

function recordCrashEvent({ exitCode, trigger, model }) {
  // Gather info about what was running at crash time
  const activeReqs = Array.from(activeRequests.values()).map(r => ({
    model: r.model, endpoint: r.endpoint, tokens: r.tokens,
    duration: Date.now() - r.startTime
  }));

  const event = {
    ts: Date.now(),
    exitCode,
    trigger, // 'exit_handler' or 'fetch_retry'
    mode: currentMode,
    preset: currentPreset || null,
    model: model || null, // model that triggered the crash (from fetch context)
    activeRequests: activeReqs,
    activeModels: [...new Set(activeReqs.map(r => r.model))],
    queueActive: llamaQueue.active,
    queuePending: llamaQueue.pending
  };

  crashHistory.push(event);
  try {
    if (!existsSync(ANALYTICS_DIR)) mkdirSync(ANALYTICS_DIR, { recursive: true });
    appendFileSync(CRASH_LOG_FILE, JSON.stringify(event) + '\n');
  } catch (err) {
    console.error('[analytics] Failed to write crash event:', err.message);
  }

  // Broadcast to dashboard
  const message = JSON.stringify({ type: 'crashEvent', data: event });
  for (const client of connectedClients) {
    if (client.readyState === client.OPEN) client.send(message);
  }

  console.log(`[crash] Recorded crash event: trigger=${trigger}, models=${event.activeModels.join(',') || 'none'}, mode=${currentMode}`);
  return event;
}

// Load existing analytics history on startup
function loadAnalyticsHistory() {
  try {
    if (!existsSync(ANALYTICS_DIR)) {
      mkdirSync(ANALYTICS_DIR, { recursive: true });
    }
    if (existsSync(ANALYTICS_FILE)) {
      const lines = readFileSync(ANALYTICS_FILE, 'utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          analyticsHistory.push(JSON.parse(line));
        } catch { /* skip malformed lines */ }
      }
      // Cap and sort
      analyticsHistory.sort((a, b) => a.ts - b.ts);
      if (analyticsHistory.length > MAX_ANALYTICS_HISTORY) {
        analyticsHistory = analyticsHistory.slice(-MAX_ANALYTICS_HISTORY);
      }
      console.log(`[analytics] Loaded ${analyticsHistory.length} historical data points`);
    }
  } catch (err) {
    console.error('[analytics] Failed to load history:', err.message);
  }
}
loadAnalyticsHistory();
loadCrashHistory();

// Request stats accumulator (per-minute tallies)
const requestStatsAccum = {
  total: 0,
  ok: 0,
  err: 0,
  retries: 0,
  restarts: 0,
  statusCodes: {},
  modelCounts: {},  // per-model request counts for this minute
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  offloaded: 0,     // requests sent to remote backends this minute
  backendCounts: {}  // per-backend request counts this minute
};

// Flush minute-level aggregate to persistent storage
function flushAnalyticsMinute() {
  const now = Date.now();
  const cutoff = now - 60000;

  // Aggregate 1-second samples from the last minute
  const tempPoints = analyticsData.temperature.filter(p => p.timestamp > cutoff);
  const powerPoints = analyticsData.power.filter(p => p.timestamp > cutoff);
  const memPoints = analyticsData.memory.filter(p => p.timestamp > cutoff);
  const tokenPoints = analyticsData.tokens.filter(p => p.timestamp > cutoff);
  const ctxPoints = analyticsData.context.filter(p => p.timestamp > cutoff);
  const queuePoints = analyticsData.queue.filter(p => p.timestamp > cutoff);

  const avg = (arr, key) => arr.length > 0 ? arr.reduce((s, p) => s + (p[key] || 0), 0) / arr.length : 0;
  const max = (arr, key) => arr.length > 0 ? Math.max(...arr.map(p => p[key] || 0)) : 0;

  const record = {
    ts: now,
    pwr: Math.round(avg(powerPoints, 'watts') * 10) / 10,
    mv: Math.round(avg(memPoints, 'vram') * 10) / 10,
    mg: Math.round(avg(memPoints, 'gtt') * 10) / 10,
    ms: Math.round(avg(memPoints, 'system') * 10) / 10,
    tg: Math.round(avg(tempPoints, 'gpu') * 10) / 10,
    tc: Math.round(avg(tempPoints, 'cpu') * 10) / 10,
    tps: Math.round(avg(tokenPoints, 'tokensPerSecond') * 10) / 10,
    tpsMax: Math.round(max(tokenPoints, 'tokensPerSecond') * 10) / 10,
    // Per-model average tok/s (only from actual generation points, not zero-fill)
    mtps: (() => {
      const byModel = {};
      for (const p of tokenPoints) {
        if (!p.model || p.tokensPerSecond <= 0) continue;
        if (!byModel[p.model]) byModel[p.model] = { sum: 0, count: 0 };
        byModel[p.model].sum += p.tokensPerSecond;
        byModel[p.model].count++;
      }
      const result = {};
      for (const [m, v] of Object.entries(byModel)) {
        result[m] = Math.round(v.sum / v.count * 10) / 10;
      }
      return result;
    })(),
    qA: Math.round(avg(queuePoints, 'active') * 10) / 10,
    qP: Math.round(avg(queuePoints, 'pending') * 10) / 10,
    qMx: Math.round(max(queuePoints, 'active')),
    qMxP: Math.round(max(queuePoints, 'pending')),
    cxU: Math.round(avg(ctxPoints, 'usedContext')),
    cxT: Math.round(avg(ctxPoints, 'totalContext')),
    cxP: Math.round(avg(ctxPoints, 'usage') * 10) / 10,
    rT: requestStatsAccum.total,
    rOk: requestStatsAccum.ok,
    rErr: requestStatsAccum.err,
    rRt: requestStatsAccum.retries,
    rRs: requestStatsAccum.restarts,
    sc: { ...requestStatsAccum.statusCodes },
    tp: requestStatsAccum.totalPromptTokens,
    tcc: requestStatsAccum.totalCompletionTokens,
    mc: { ...requestStatsAccum.modelCounts },
    rOf: requestStatsAccum.offloaded,  // requests offloaded to remote backends
    bc: { ...requestStatsAccum.backendCounts },  // per-backend request counts
    // Per-backend cumulative stats snapshot
    be: Object.fromEntries([...backendStats.entries()].map(([id, s]) => [id, {
      rT: s.totalRequests, tPS: Math.round(s.avgTokPerSec * 10) / 10,
      pT: s.totalPromptTokens, cT: s.totalCompletionTokens,
      cost: Math.round(s.totalCostUsd * 10000) / 10000
    }]))
  };

  // Append to in-memory history
  analyticsHistory.push(record);
  if (analyticsHistory.length > MAX_ANALYTICS_HISTORY) {
    analyticsHistory.shift();
  }

  // Append to file
  try {
    if (!existsSync(ANALYTICS_DIR)) {
      mkdirSync(ANALYTICS_DIR, { recursive: true });
    }
    appendFileSync(ANALYTICS_FILE, JSON.stringify(record) + '\n');
  } catch (err) {
    console.error('[analytics] Failed to write history:', err.message);
  }

  // Reset accumulator
  requestStatsAccum.total = 0;
  requestStatsAccum.ok = 0;
  requestStatsAccum.err = 0;
  requestStatsAccum.retries = 0;
  requestStatsAccum.restarts = 0;
  requestStatsAccum.statusCodes = {};
  requestStatsAccum.modelCounts = {};
  requestStatsAccum.totalPromptTokens = 0;
  requestStatsAccum.totalCompletionTokens = 0;
  requestStatsAccum.offloaded = 0;
  requestStatsAccum.backendCounts = {};
}

// Flush every 60 seconds
setInterval(flushAnalyticsMinute, 60000);

// Token stats aggregation
const tokenStats = {
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalRequests: 0,
  recentRequests: [] // Last 100 requests for averaging
};
const MAX_RECENT_REQUESTS = 100;

// Log buffer (circular buffer for recent logs)
const MAX_LOG_LINES = 500;
let logBuffer = [];
let lastLogEntry = null;
let lastLogCount = 0;

// Default log patterns to filter out (noisy polling endpoints)
const DEFAULT_LOG_FILTERS = [
  'GET /health.*200',
  'GET /models.*200',
];

function shouldFilterLog(line, customFilters = []) {
  const allFilters = [...DEFAULT_LOG_FILTERS, ...customFilters];
  return allFilters.some(pattern => {
    try {
      return new RegExp(pattern, 'i').test(line);
    } catch {
      // Invalid regex, try as plain string match
      return line.includes(pattern);
    }
  });
}

function addLog(source, message) {
  const timestamp = new Date().toISOString();
  const lines = message.toString().split('\n').filter(l => l.trim());

  for (const line of lines) {
    // Skip noisy polling log entries
    if (shouldFilterLog(line, config.logFilters || [])) continue;
    // Check if this is a repeat of the last message
    if (lastLogEntry && lastLogEntry.source === source && lastLogEntry.message === line) {
      lastLogCount++;
      lastLogEntry.count = lastLogCount;
      lastLogEntry.timestamp = timestamp; // Update timestamp to latest
      // Broadcast update to existing entry
      broadcastLog({ ...lastLogEntry, type: 'update' });
    } else {
      // Flush the previous entry if it had repeats
      if (lastLogEntry && lastLogCount > 1) {
        // The entry is already in the buffer with count, just finalize it
      }

      // Create new entry
      const logEntry = { timestamp, source, message: line, count: 1, id: Date.now() + Math.random() };
      logBuffer.push(logEntry);
      if (logBuffer.length > MAX_LOG_LINES) {
        logBuffer.shift();
      }

      lastLogEntry = logEntry;
      lastLogCount = 1;

      // Broadcast new entry
      broadcastLog(logEntry);
    }
  }
}

function broadcastLog(logEntry) {
  const message = JSON.stringify({ type: 'log', data: logEntry });
  for (const client of connectedClients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

// Request log buffer (circular buffer for HTTP request logs)
const MAX_REQUEST_LOG_ENTRIES = 200;
let requestLogBuffer = [];

function addRequestLog(entry) {
  if (!config.requestLogging) return;
  requestLogBuffer.push(entry);
  if (requestLogBuffer.length > MAX_REQUEST_LOG_ENTRIES) {
    requestLogBuffer.shift();
  }
  broadcastRequestLog(entry);
}

function broadcastRequestLog(entry) {
  const message = JSON.stringify({ type: 'requestLog', data: entry });
  for (const client of connectedClients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

// LLM conversation log buffer (stores full conversation context)
const MAX_LLM_LOG_ENTRIES = 50;
let llmLogBuffer = [];

function addLlmLog(entry) {
  entry.id = Date.now() + Math.random();
  entry.timestamp = new Date().toISOString();
  llmLogBuffer.push(entry);
  if (llmLogBuffer.length > MAX_LLM_LOG_ENTRIES) {
    llmLogBuffer.shift();
  }
  broadcastLlmLog(entry);
}

function broadcastLlmLog(entry) {
  const message = JSON.stringify({ type: 'llmLog', data: entry });
  for (const client of connectedClients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

// Active request tracking — broadcast to dashboard via WebSocket + SSE
let activeRequests = new Map(); // id -> { id, model, endpoint, userMessage, responseText, startTime, status }
let activeRequestIdCounter = 0;
const activeRequestEvents = new EventEmitter();
activeRequestEvents.setMaxListeners(100);

function broadcastActiveRequest(event, data) {
  const message = JSON.stringify({ type: 'activeRequest', event, data });
  for (const client of connectedClients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

function startActiveRequest({ model, endpoint, messages, prompt, backend }) {
  const id = ++activeRequestIdCounter;
  // Extract last user message for display
  let userMessage = '';
  if (messages && Array.isArray(messages)) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    userMessage = lastUser?.content || '';
    if (typeof userMessage !== 'string') {
      // Handle array content (e.g. vision messages)
      userMessage = Array.isArray(userMessage)
        ? userMessage.filter(c => c.type === 'text').map(c => c.text).join(' ')
        : String(userMessage);
    }
  } else if (prompt) {
    userMessage = typeof prompt === 'string' ? prompt : String(prompt);
  }
  const abortController = new AbortController();
  // Store full context for debugging (messages array or prompt)
  const fullContext = messages && Array.isArray(messages) ? messages : (prompt ? [{ role: 'user', content: prompt }] : []);
  const entry = { id, model, endpoint, userMessage, fullContext, responseText: '', startTime: Date.now(), status: 'processing', tokens: 0, backend: backend || 'local', abortController };
  activeRequests.set(id, entry);
  // Broadcast without non-serializable fields (abortController)
  const { abortController: _ac, ...broadcastData } = entry;
  broadcastActiveRequest('start', broadcastData);
  return id;
}

// Get the abort signal for an active request (used by proxy endpoints)
function getActiveRequestSignal(id) {
  const entry = activeRequests.get(id);
  return entry?.abortController?.signal;
}

function updateActiveRequest(id, text) {
  const entry = activeRequests.get(id);
  if (!entry) return;
  entry.responseText += text;
  entry.tokens++;
  // Emit for SSE watchers on every token
  activeRequestEvents.emit(`update:${id}`, { id, responseText: entry.responseText, tokens: entry.tokens, duration: Date.now() - entry.startTime });
  // Throttle WebSocket broadcasts: every 5 tokens to avoid flooding
  if (entry.tokens % 5 === 0 || text.includes('\n')) {
    broadcastActiveRequest('update', { id, responseText: entry.responseText, tokens: entry.tokens, duration: Date.now() - entry.startTime });
  }
}

function endActiveRequest(id, { status = 'complete', tokens = 0, responseText } = {}) {
  const entry = activeRequests.get(id);
  if (!entry) return;
  entry.status = status;
  if (tokens) entry.tokens = tokens;
  if (responseText !== undefined) entry.responseText = responseText;
  entry.duration = Date.now() - entry.startTime;
  // Track last used model
  if (entry.model && status === 'complete') {
    lastUsedModel = entry.model;
    lastUsedModelTime = Date.now();
  }
  broadcastActiveRequest('end', { id, status, tokens: entry.tokens, duration: entry.duration, responseText: entry.responseText });
  activeRequestEvents.emit(`end:${id}`, { id, status, tokens: entry.tokens, duration: entry.duration, responseText: entry.responseText });
  activeRequestEvents.removeAllListeners(`update:${id}`);
  activeRequestEvents.removeAllListeners(`end:${id}`);
  activeRequests.delete(id);
}

// Add analytics data point
function addAnalyticsPoint(category, data) {
  const point = { timestamp: Date.now(), ...data };
  analyticsData[category].push(point);
  if (analyticsData[category].length > MAX_ANALYTICS_POINTS) {
    analyticsData[category].shift();
  }
}

// Record token stats from a completion
function recordTokenStats(stats) {
  const { promptTokens, completionTokens, tokensPerSecond, model, duration, backend } = stats;

  tokenStats.totalPromptTokens += promptTokens || 0;
  tokenStats.totalCompletionTokens += completionTokens || 0;
  tokenStats.totalRequests++;

  // Also accumulate into per-minute request stats
  requestStatsAccum.totalPromptTokens += promptTokens || 0;
  requestStatsAccum.totalCompletionTokens += completionTokens || 0;
  // Prepend backend name for offloaded requests so telemetry shows where it ran
  const modelKey = backend && backend !== 'local' ? `${backend}/${model || 'unknown'}` : (model || 'unknown');
  requestStatsAccum.modelCounts[modelKey] = (requestStatsAccum.modelCounts[modelKey] || 0) + 1;

  const requestRecord = {
    timestamp: Date.now(),
    promptTokens: promptTokens || 0,
    completionTokens: completionTokens || 0,
    tokensPerSecond: tokensPerSecond || 0,
    model: modelKey,
    duration: duration || 0
  };

  tokenStats.recentRequests.push(requestRecord);
  if (tokenStats.recentRequests.length > MAX_RECENT_REQUESTS) {
    tokenStats.recentRequests.shift();
  }

  // Add to time-series
  addAnalyticsPoint('tokens', requestRecord);
}

// Default presets - seeded on first run, can be deleted by user
const DEFAULT_PRESETS = {
  gpt120: {
    id: 'gpt120',
    name: 'GPT-OSS 120B',
    description: 'Large reasoning model with high effort mode',
    hfRepo: 'Unsloth/gpt-oss-120b-GGUF:Q5_K_M',
    context: 131072,
    config: {
      chatTemplateKwargs: '{"reasoning_effort": "high"}',
      reasoningFormat: 'deepseek',
      temp: 1.0,
      topP: 1.0,
      topK: 0,
      minP: 0,
      extraSwitches: '--jinja'
    }
  },
  qwen3: {
    id: 'qwen3',
    name: 'Qwen3 Coder 30B-A3B',
    description: 'Fast MoE coding model with 30B total / 3B active params',
    hfRepo: 'Unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q5_K_M',
    context: 0,
    config: {
      chatTemplateKwargs: '',
      reasoningFormat: 'deepseek',
      temp: 0.7,
      topP: 1.0,
      topK: 20,
      minP: 0,
      extraSwitches: '--jinja'
    }
  },
  'qwen2.5': {
    id: 'qwen2.5',
    name: 'Qwen 2.5 Coder 32B',
    description: 'Dense 32B coding model, high quality',
    hfRepo: 'Qwen/Qwen2.5-Coder-32B-Instruct-GGUF:Q5_K_M',
    context: 0,
    config: {
      chatTemplateKwargs: '',
      reasoningFormat: 'deepseek',
      temp: 0.7,
      topP: 1.0,
      topK: 20,
      minP: 0,
      extraSwitches: '--jinja'
    }
  }
};

// Ensure models directory exists
if (!existsSync(MODELS_DIR)) {
  mkdirSync(MODELS_DIR, { recursive: true });
}

// Load or initialize config
function loadConfig() {
  let cfg;
  if (existsSync(CONFIG_PATH)) {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } else {
    // Use environment variables for defaults
    cfg = {
      autoStart: process.env.AUTO_START !== 'false',
      modelsMax: parseInt(process.env.MODELS_MAX) || 2,
      contextSize: parseInt(process.env.CONTEXT_SIZE) || 8192,
      logFilters: [],
      requestLogging: false,
      maxConcurrentRequests: 1
    };
  }

  // Migration: rename customPresets to presets
  if (cfg.customPresets) {
    if (cfg.presets) {
      // Both customPresets and presets exist; merge and log a warning.
      console.warn(
        'Config contains both "customPresets" and "presets". ' +
        'Merging them and removing "customPresets".'
      );
      cfg.presets = { ...cfg.customPresets, ...cfg.presets };
    } else {
      cfg.presets = cfg.customPresets;
    }
    delete cfg.customPresets;
    saveConfig(cfg);
  }

  // Seed default presets only once on first installation
  if (!cfg.presetsSeeded) {
    let updated = false;

    // Only seed defaults if presets is empty or doesn't exist
    if (!cfg.presets || Object.keys(cfg.presets).length === 0) {
      cfg.presets = { ...DEFAULT_PRESETS };
      updated = true;
    }

    cfg.presetsSeeded = true;
    // Save if we seeded presets or if we're upgrading an old config to include the flag
    saveConfig(cfg);
  }

  return cfg;
}

function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let config = loadConfig();

// Apply configured concurrency limit
if (config.maxConcurrentRequests) {
  llamaQueue.setConcurrency(config.maxConcurrentRequests);
}

// Initialize remote backend queues
initBackendQueues();

// WebSocket stats broadcasting
const STATS_INTERVAL = parseInt(process.env.STATS_INTERVAL) || 1000; // Default 1 second
let statsInterval = null;
let connectedClients = new Set();

// Get CPU temperature from thermal zones
function getCpuTemperature() {
  try {
    // Try to read from thermal_zone0 (usually CPU on most systems)
    const tempFiles = readdirSync('/sys/class/thermal/')
      .filter(f => f.startsWith('thermal_zone'))
      .map(f => `/sys/class/thermal/${f}/temp`);

    for (const tempFile of tempFiles) {
      try {
        const temp = parseInt(readFileSync(tempFile, 'utf-8').trim());
        if (temp > 0) {
          return Math.round(temp / 100) / 10; // Convert millidegrees to degrees with 1 decimal
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Thermal zones not available
  }
  return null;
}

// System stats collection
async function getSystemStats() {
  const cpuCores = cpus();
  const cpuUsage = cpuCores.reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;
    return acc + ((total - idle) / total) * 100;
  }, 0) / cpuCores.length;

  const totalMem = totalmem();
  const freeMem = freemem();
  const usedMem = totalMem - freeMem;
  const memUsage = (usedMem / totalMem) * 100;

  // Get CPU temperature
  const cpuTemp = getCpuTemperature();

  // Get GPU/VRAM stats from rocm-smi inside the container
  let gpuStats = null;
  try {
    gpuStats = await getGpuStats();
  } catch (e) {
    // GPU stats not available
  }

  // Get llama.cpp specific stats if running
  let llamaStats = null;
  let contextStats = null;
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/health`);
    if (response.ok) {
      llamaStats = await response.json();
    }
    // Get context usage from loaded models
    contextStats = await getContextStats();
  } catch {
    // Server not running
  }

  return {
    timestamp: Date.now(),
    cpu: {
      usage: Math.round(cpuUsage * 10) / 10,
      cores: cpuCores.length,
      loadAvg: loadavg(),
      temperature: cpuTemp
    },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      usage: Math.round(memUsage * 10) / 10
    },
    gpu: gpuStats,
    llama: llamaStats,
    context: contextStats,
    queue: {
      active: llamaQueue.active,
      pending: llamaQueue.pending,
      concurrency: llamaQueue.concurrency,
      totalQueued: llamaQueue.queuedCount
    },
    activeModel: activeRequests.size > 0 ? [...activeRequests.values()][0]?.model : null,
    lastUsedModel,
    lastUsedModelTime,
    llamaPort: LLAMA_PORT,
    llamaUiUrl: LLAMA_UI_URL,
    mode: currentMode,
    preset: currentPreset ? config.presets[currentPreset] : null,
    downloads: Object.fromEntries(
      Array.from(downloadProcesses.entries()).map(([id, info]) => [
        id,
        { progress: info.progress, status: info.status, error: info.error, output: info.output, startedAt: info.startedAt }
      ])
    ),
    backends: config.backends?.enabled ? Object.fromEntries(
      [...backendStats.entries()].map(([id, s]) => [id, {
        active: backendQueues.get(id)?.active || 0,
        pending: backendQueues.get(id)?.pending || 0,
        tokPerSec: Math.round(s.avgTokPerSec * 10) / 10,
        totalCost: Math.round(s.totalCostUsd * 10000) / 10000,
        totalRequests: s.totalRequests,
        errors: s.errorRequests
      }])
    ) : null
  };
}

// Get context usage stats from loaded models
async function getContextStats() {
  try {
    // Get list of models
    const modelsResponse = await fetch(`http://localhost:${LLAMA_PORT}/models`);
    if (!modelsResponse.ok) return null;

    const modelsData = await modelsResponse.json();
    const models = modelsData.data || [];

    // Find loaded models and get their slot info
    const loadedModels = models.filter(m => m.status?.value === 'loaded');
    if (loadedModels.length === 0) return { models: [], totalContext: 0, usedContext: 0, usage: 0 };

    const modelStats = [];
    let totalContext = 0;
    let usedContext = 0;

    for (const model of loadedModels) {
      // Extract port from args
      const args = model.status?.args || [];
      const portIndex = args.indexOf('--port');
      const port = portIndex >= 0 ? parseInt(args[portIndex + 1]) : null;

      // Extract ctx-size from args
      const ctxIndex = args.indexOf('--ctx-size');
      const configuredCtx = ctxIndex >= 0 ? parseInt(args[ctxIndex + 1]) : 0;

      if (port && port > 0) {
        try {
          const slotsResponse = await fetch(`http://localhost:${port}/slots`, { signal: AbortSignal.timeout(2000) });
          if (slotsResponse.ok) {
            const slots = await slotsResponse.json();
            // Sum up context across all slots
            let modelTotalCtx = 0;
            let modelUsedCtx = 0;

            for (const slot of slots) {
              modelTotalCtx += slot.n_ctx || 0;
              // n_decoded represents tokens in the context
              if (slot.next_token && Array.isArray(slot.next_token)) {
                for (const nt of slot.next_token) {
                  modelUsedCtx += nt.n_decoded || 0;
                }
              }
            }

            modelStats.push({
              id: model.id,
              port,
              slots: slots.length,
              totalContext: modelTotalCtx,
              usedContext: modelUsedCtx,
              usage: modelTotalCtx > 0 ? Math.round((modelUsedCtx / modelTotalCtx) * 1000) / 10 : 0
            });

            totalContext += modelTotalCtx;
            usedContext += modelUsedCtx;
          }
        } catch {
          // Worker might be busy or unreachable
          modelStats.push({
            id: model.id,
            port,
            slots: 0,
            totalContext: configuredCtx,
            usedContext: 0,
            usage: 0,
            error: 'unreachable'
          });
          totalContext += configuredCtx;
        }
      }
    }

    return {
      models: modelStats,
      totalContext,
      usedContext,
      usage: totalContext > 0 ? Math.round((usedContext / totalContext) * 1000) / 10 : 0
    };
  } catch {
    return null;
  }
}

// Read GTT (Graphics Translation Table) memory stats from sysfs
// This is the relevant metric for APUs with unified memory
async function getGttStats() {
  return new Promise((resolve) => {
    // Try multiple card paths (card0, card1, etc.)
    const cmd = spawn('bash', [
      '-c',
      `for card in /sys/class/drm/card*/device/mem_info_gtt_total; do
        if [ -f "$card" ]; then
          dir=$(dirname "$card")
          total=$(cat "$dir/mem_info_gtt_total" 2>/dev/null || echo 0)
          used=$(cat "$dir/mem_info_gtt_used" 2>/dev/null || echo 0)
          if [ "$total" != "0" ]; then
            echo "$total $used"
            exit 0
          fi
        fi
      done
      echo "0 0"`
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    cmd.stdout.on('data', (data) => {
      output += data.toString();
    });

    cmd.on('close', () => {
      try {
        const [totalStr, usedStr] = output.trim().split(' ');
        const total = parseInt(totalStr) || 0;
        const used = parseInt(usedStr) || 0;
        const usage = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
        resolve({ total, used, usage });
      } catch {
        resolve({ total: 0, used: 0, usage: 0 });
      }
    });

    cmd.on('error', () => resolve({ total: 0, used: 0, usage: 0 }));
    setTimeout(() => resolve({ total: 0, used: 0, usage: 0 }), 2000);
  });
}

async function getGpuStats() {
  // Get GTT stats first (important for APUs with unified memory)
  const gttStats = await getGttStats();

  return new Promise((resolve, reject) => {
    const cmd = spawn('/usr/local/bin/distrobox', [
      'enter', CONTAINER_NAME, '--',
      'bash', '-c',
      'rocm-smi --showmeminfo vram --showuse --showtemp --showpower --showclocks --json 2>/dev/null || echo "{}"'
    ], {
      env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    cmd.stdout.on('data', (data) => {
      output += data.toString();
    });

    cmd.on('close', (code) => {
      try {
        // Parse rocm-smi JSON output
        const data = JSON.parse(output.trim() || '{}');
        if (data.card0 || data['card0']) {
          const card = data.card0 || data['card0'];
          const vramTotal = parseInt(card['VRAM Total Memory (B)'] || 0);
          const vramUsed = parseInt(card['VRAM Total Used Memory (B)'] || 0);
          const vramUsage = vramTotal > 0 ? Math.round((vramUsed / vramTotal) * 1000) / 10 : 0;

          // Parse power (watts)
          const powerStr = card['Current Socket Graphics Package Power (W)'] || card['Average Graphics Package Power (W)'] || '0';
          const power = parseFloat(powerStr) || 0;

          // Parse clock speeds (extract MHz from strings like "(1000Mhz)")
          const sclkStr = card['sclk clock speed:'] || '';
          const mclkStr = card['mclk clock speed:'] || '';
          const sclkMatch = sclkStr.match(/\((\d+)Mhz\)/i);
          const mclkMatch = mclkStr.match(/\((\d+)Mhz\)/i);
          const coreClock = sclkMatch ? parseInt(sclkMatch[1]) : 0;
          const memClock = mclkMatch ? parseInt(mclkMatch[1]) : 0;

          // For systems with unified memory (APUs, MI300A, etc.), GTT is the primary memory for LLM inference
          // If GTT is larger than VRAM, prefer showing GTT as it represents usable memory
          const isAPU = gttStats.total > vramTotal;

          resolve({
            temperature: parseFloat(card['Temperature (Sensor edge) (C)'] || card.temperature || 0),
            usage: parseFloat(card['GPU use (%)'] || card.gpu_use || 0),
            power,
            coreClock,
            memClock,
            vram: {
              total: vramTotal,
              used: vramUsed,
              usage: vramUsage
            },
            gtt: gttStats,
            isAPU
          });
        } else {
          // rocm-smi failed, but we might still have GTT stats
          if (gttStats.total > 0) {
            resolve({
              temperature: 0,
              usage: 0,
              power: 0,
              coreClock: 0,
              memClock: 0,
              vram: { total: 0, used: 0, usage: 0 },
              gtt: gttStats,
              isAPU: true
            });
          } else {
            resolve(null);
          }
        }
      } catch {
        // Even if parsing fails, return GTT stats if available
        if (gttStats.total > 0) {
          resolve({
            temperature: 0,
            usage: 0,
            power: 0,
            coreClock: 0,
            memClock: 0,
            vram: { total: 0, used: 0, usage: 0 },
            gtt: gttStats,
            isAPU: true
          });
        } else {
          resolve(null);
        }
      }
    });

    cmd.on('error', () => {
      if (gttStats.total > 0) {
        resolve({
          temperature: 0,
          usage: 0,
          vram: { total: 0, used: 0, usage: 0 },
          gtt: gttStats,
          isAPU: true
        });
      } else {
        resolve(null);
      }
    });
    setTimeout(() => resolve(null), 3000);
  });
}

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('[ws] Client connected');
  connectedClients.add(ws);
  startStatsBroadcast();

  // Send initial stats immediately
  getSystemStats().then(stats => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'stats', data: stats }));
    }
  });

  ws.on('close', () => {
    console.log('[ws] Client disconnected');
    connectedClients.delete(ws);
    stopStatsBroadcast();
  });

  ws.on('error', (err) => {
    console.error('[ws] Error:', err);
    connectedClients.delete(ws);
    stopStatsBroadcast();
  });
});

// Broadcast stats to all connected clients
async function broadcastStats() {
  if (connectedClients.size === 0) return;

  try {
    const stats = await getSystemStats();

    // Record analytics data points
    if (stats.gpu) {
      addAnalyticsPoint('temperature', {
        gpu: stats.gpu.temperature || 0,
        cpu: stats.cpu?.temperature || 0
      });
      addAnalyticsPoint('power', {
        watts: stats.gpu.power || 0
      });
      addAnalyticsPoint('memory', {
        vram: stats.gpu.vram?.usage || 0,
        gtt: stats.gpu.gtt?.usage || 0,
        system: stats.memory?.usage || 0
      });
    } else if (stats.cpu?.temperature) {
      addAnalyticsPoint('temperature', {
        gpu: 0,
        cpu: stats.cpu.temperature
      });
    }

    // Record context usage
    if (stats.context) {
      addAnalyticsPoint('context', {
        usedContext: stats.context.usedContext || 0,
        totalContext: stats.context.totalContext || 0,
        usage: stats.context.usage || 0
      });
    }

    // Record queue stats
    addAnalyticsPoint('queue', {
      active: llamaQueue.active,
      pending: llamaQueue.pending,
      concurrency: llamaQueue.concurrency
    });

    // Add a zero-value token point if no recent token data exists,
    // so the chart shows a continuous timeline instead of "Collecting data..."
    const now = Date.now();
    const lastTokenPoint = analyticsData.tokens[analyticsData.tokens.length - 1];
    if (!lastTokenPoint || (now - lastTokenPoint.timestamp) > 2000) {
      addAnalyticsPoint('tokens', {
        promptTokens: 0,
        completionTokens: 0,
        tokensPerSecond: 0,
        model: '',
        duration: 0
      });
    }

    const message = JSON.stringify({ type: 'stats', data: stats });

    for (const client of connectedClients) {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    }
  } catch (err) {
    console.error('[ws] Broadcast error:', err);
  }
}

// Start stats broadcasting when first client connects
function startStatsBroadcast() {
  if (statsInterval) return;
  statsInterval = setInterval(broadcastStats, STATS_INTERVAL);
  console.log(`[ws] Stats broadcast started (interval: ${STATS_INTERVAL}ms)`);
}

// Stop when no clients
function stopStatsBroadcast() {
  if (statsInterval && connectedClients.size === 0) {
    clearInterval(statsInterval);
    statsInterval = null;
    console.log('[ws] Stats broadcast stopped');
  }
}

// Check if a filename is a split model part (e.g., model-00002-of-00004.gguf)
function isSplitModelPart(filename) {
  // Match patterns like: name-00001-of-00004.gguf or name.Q4_K_M-00001-of-00002.gguf
  const splitPattern = /-(\d{5})-of-(\d{5})\.gguf$/i;
  const match = filename.match(splitPattern);
  if (!match) return null;
  return {
    partNum: parseInt(match[1]),
    totalParts: parseInt(match[2]),
    baseName: filename.replace(splitPattern, '.gguf')
  };
}

// Scan local models directory
function scanLocalModels() {
  const models = [];
  const splitModels = new Map(); // Track split models to combine them

  function scanDir(dir, prefix = '') {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath, prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.name.endsWith('.gguf')) {
        const stats = statSync(fullPath);
        const modelName = prefix ? `${prefix}/${entry.name}` : entry.name;

        // Check if this is a split model part
        const splitInfo = isSplitModelPart(entry.name);
        if (splitInfo) {
          const baseModelName = prefix ? `${prefix}/${splitInfo.baseName}` : splitInfo.baseName;

          if (!splitModels.has(baseModelName)) {
            splitModels.set(baseModelName, {
              name: baseModelName,
              path: fullPath, // Use first part's path for loading
              size: 0,
              modified: stats.mtime,
              parts: [],
              totalParts: splitInfo.totalParts
            });
          }

          const splitModel = splitModels.get(baseModelName);
          splitModel.size += stats.size;
          splitModel.parts.push({
            partNum: splitInfo.partNum,
            path: fullPath,
            size: stats.size
          });

          // Update modified time to most recent
          if (stats.mtime > splitModel.modified) {
            splitModel.modified = stats.mtime;
          }
        } else {
          // Regular single-file model
          models.push({
            name: modelName,
            path: fullPath,
            size: stats.size,
            modified: stats.mtime
          });
        }
      }
    }
  }

  scanDir(MODELS_DIR);

  // Add split models to the list (using first part's path for loading)
  for (const [name, splitModel] of splitModels) {
    // Sort parts and use the first part's path
    splitModel.parts.sort((a, b) => a.partNum - b.partNum);
    if (splitModel.parts.length > 0) {
      splitModel.path = splitModel.parts[0].path;
      // Get the first part's filename relative to MODELS_DIR for llama.cpp router mode
      splitModel.firstPartName = splitModel.parts[0].path.replace(MODELS_DIR + '/', '');
    }

    // Only include if we have all parts
    if (splitModel.parts.length === splitModel.totalParts) {
      models.push({
        name: splitModel.name,
        path: splitModel.path,
        size: splitModel.size,
        modified: splitModel.modified,
        isSplit: true,
        partCount: splitModel.totalParts,
        firstPartName: splitModel.firstPartName // For llama.cpp to load correctly
      });
    } else {
      // Incomplete split model - still show it but mark as incomplete
      models.push({
        name: splitModel.name,
        path: splitModel.path,
        size: splitModel.size,
        modified: splitModel.modified,
        isSplit: true,
        partCount: splitModel.totalParts,
        partsFound: splitModel.parts.length,
        incomplete: true,
        firstPartName: splitModel.firstPartName
      });
    }
  }

  // Add aliases from config
  const aliases = config.modelAliases || {};
  return models.map(model => ({
    ...model,
    alias: aliases[model.name] || null
  }));
}

// API Routes

// Get settings
app.get('/api/settings', (req, res) => {
  res.json({
    settings: {
      contextSize: config.contextSize,
      modelsMax: config.modelsMax,
      autoStart: config.autoStart,
      noWarmup: config.noWarmup || false,
      flashAttn: config.flashAttn || false,
      gpuLayers: config.gpuLayers || 99,
      requestLogging: config.requestLogging || false,
      maxConcurrentRequests: config.maxConcurrentRequests || 1,
      defaultReasoningEffort: config.defaultReasoningEffort || null,
      modelReasoningEffort: config.modelReasoningEffort || {},
      fullscreenInterval: config.fullscreenInterval || 30000,
      backends: {
        enabled: config.backends?.enabled || false,
        offloadPolicy: config.backends?.offloadPolicy || 'overflow',
        offloadThresholdQueueDepth: config.backends?.offloadThresholdQueueDepth ?? 2,
        offloadThresholdWaitMs: config.backends?.offloadThresholdWaitMs ?? 5000,
        offloadPercentage: config.backends?.offloadPercentage || 0,
        preferLocal: config.backends?.preferLocal !== false,
        directory: (config.backends?.directory || []).map(b => ({
          ...b,
          apiKeyConfigured: !!(b.apiKeyEnvVar && process.env[b.apiKeyEnvVar])
        }))
      }
    },
    // Include environment defaults for reference
    defaults: {
      contextSize: parseInt(process.env.CONTEXT_SIZE) || 8192,
      modelsMax: parseInt(process.env.MODELS_MAX) || 2
    }
  });
});

// Update settings
app.post('/api/settings', (req, res) => {
  const { contextSize, modelsMax, autoStart, noWarmup, flashAttn, gpuLayers, requestLogging, maxConcurrentRequests, defaultReasoningEffort, modelReasoningEffort, fullscreenInterval } = req.body;

  // Validate and update settings
  if (contextSize !== undefined) {
    const size = parseInt(contextSize);
    if (size >= 512 && size <= 262144) {
      config.contextSize = size;
    } else {
      return res.status(400).json({ error: 'Context size must be between 512 and 262144' });
    }
  }

  if (modelsMax !== undefined) {
    const max = parseInt(modelsMax);
    if (max >= 1 && max <= 10) {
      config.modelsMax = max;
    } else {
      return res.status(400).json({ error: 'Max models must be between 1 and 10' });
    }
  }

  if (autoStart !== undefined) {
    config.autoStart = Boolean(autoStart);
  }

  if (noWarmup !== undefined) {
    config.noWarmup = Boolean(noWarmup);
  }

  if (flashAttn !== undefined) {
    config.flashAttn = Boolean(flashAttn);
  }

  if (gpuLayers !== undefined) {
    const layers = parseInt(gpuLayers);
    if (layers >= 0 && layers <= 999) {
      config.gpuLayers = layers;
    } else {
      return res.status(400).json({ error: 'GPU layers must be between 0 and 999' });
    }
  }

  if (requestLogging !== undefined) {
    config.requestLogging = Boolean(requestLogging);
  }

  if (maxConcurrentRequests !== undefined) {
    const n = parseInt(maxConcurrentRequests);
    if (n >= 1 && n <= 32) {
      config.maxConcurrentRequests = n;
      llamaQueue.setConcurrency(n);
    } else {
      return res.status(400).json({ error: 'Max concurrent requests must be between 1 and 32' });
    }
  }

  if (defaultReasoningEffort !== undefined) {
    const valid = [null, 'low', 'medium', 'high'];
    if (!valid.includes(defaultReasoningEffort)) {
      return res.status(400).json({ error: 'defaultReasoningEffort must be null, "low", "medium", or "high"' });
    }
    config.defaultReasoningEffort = defaultReasoningEffort;
  }

  if (modelReasoningEffort !== undefined) {
    if (typeof modelReasoningEffort !== 'object' || Array.isArray(modelReasoningEffort)) {
      return res.status(400).json({ error: 'modelReasoningEffort must be an object mapping model patterns to effort levels' });
    }
    const validEfforts = ['low', 'medium', 'high'];
    for (const [pattern, effort] of Object.entries(modelReasoningEffort)) {
      if (!validEfforts.includes(effort)) {
        return res.status(400).json({ error: `Invalid effort "${effort}" for pattern "${pattern}". Must be "low", "medium", or "high"` });
      }
    }
    config.modelReasoningEffort = modelReasoningEffort;
  }

  if (fullscreenInterval !== undefined) {
    const interval = parseInt(fullscreenInterval);
    if (interval >= 5000 && interval <= 300000) {
      config.fullscreenInterval = interval;
    } else {
      return res.status(400).json({ error: 'Fullscreen interval must be between 5000 and 300000 ms' });
    }
  }

  saveConfig(config);
  addLog('manager', `Settings updated: ${JSON.stringify(req.body)}`);

  res.json({
    success: true,
    settings: config,
    message: 'Settings saved. Restart the server for changes to take effect.'
  });
});

// ========== Remote Backend Management ==========

// List all backends with status
app.get('/api/backends', (req, res) => {
  const dir = config.backends?.directory || [];
  const result = dir.map(b => ({
    ...b,
    apiKeyConfigured: !!(b.apiKeyEnvVar && process.env[b.apiKeyEnvVar]),
    queue: {
      active: backendQueues.get(b.id)?.active || 0,
      pending: backendQueues.get(b.id)?.pending || 0,
      concurrency: b.maxConcurrentRequests || 5
    },
    stats: backendStats.get(b.id) || null
  }));
  res.json({ backends: result, routing: {
    enabled: config.backends?.enabled || false,
    offloadPolicy: config.backends?.offloadPolicy || 'overflow',
    offloadThresholdQueueDepth: config.backends?.offloadThresholdQueueDepth ?? 2,
    offloadThresholdWaitMs: config.backends?.offloadThresholdWaitMs ?? 5000,
    offloadPercentage: config.backends?.offloadPercentage || 0,
    preferLocal: config.backends?.preferLocal !== false
  }});
});

// Add a new backend
app.post('/api/backends', (req, res) => {
  const { name, url, enabled, priority, apiKeyEnvVar, modelMapping, supportedEndpoints, costs, sharedResourceWeight, maxConcurrentRequests, timeoutMs, extraHeaders } = req.body;

  if (!name || !url) {
    return res.status(400).json({ error: 'name and url are required' });
  }

  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now().toString(36);
  const backend = {
    id,
    name,
    url: url.replace(/\/+$/, ''),
    enabled: enabled !== false,
    priority: Math.max(1, Math.min(100, parseInt(priority) || 10)),
    apiKeyEnvVar: apiKeyEnvVar || '',
    modelMapping: modelMapping || { '*': '' },
    supportedEndpoints: supportedEndpoints || ['chat/completions', 'completions', 'embeddings'],
    costs: {
      inputTokenCostPer1M: parseFloat(costs?.inputTokenCostPer1M) || 0,
      outputTokenCostPer1M: parseFloat(costs?.outputTokenCostPer1M) || 0,
      currency: costs?.currency || 'USD'
    },
    sharedResourceWeight: Math.max(0, Math.min(100, parseInt(sharedResourceWeight) || 0)),
    maxConcurrentRequests: Math.max(1, Math.min(100, parseInt(maxConcurrentRequests) || 5)),
    timeoutMs: Math.max(5000, Math.min(600000, parseInt(timeoutMs) || 120000))
  };
  if (extraHeaders) backend.extraHeaders = extraHeaders;

  if (!config.backends) {
    config.backends = { enabled: false, offloadPolicy: 'overflow', offloadThresholdQueueDepth: 2, offloadThresholdWaitMs: 5000, offloadPercentage: 0, preferLocal: true, directory: [] };
  }
  config.backends.directory.push(backend);
  saveConfig(config);
  initBackendQueues();
  addLog('backends', `Added backend: ${backend.name} (${backend.id})`);
  res.json({ success: true, backend });
});

// Update a backend
app.put('/api/backends/:id', (req, res) => {
  if (!config.backends?.directory) {
    return res.status(404).json({ error: 'No backends configured' });
  }
  const idx = config.backends.directory.findIndex(b => b.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Backend not found' });
  }

  const existing = config.backends.directory[idx];
  const updates = req.body;

  // Merge updates into existing backend
  if (updates.name !== undefined) existing.name = updates.name;
  if (updates.url !== undefined) existing.url = updates.url.replace(/\/+$/, '');
  if (updates.enabled !== undefined) existing.enabled = Boolean(updates.enabled);
  if (updates.priority !== undefined) existing.priority = Math.max(1, Math.min(100, parseInt(updates.priority) || 10));
  if (updates.apiKeyEnvVar !== undefined) existing.apiKeyEnvVar = updates.apiKeyEnvVar;
  if (updates.modelMapping !== undefined) existing.modelMapping = updates.modelMapping;
  if (updates.supportedEndpoints !== undefined) existing.supportedEndpoints = updates.supportedEndpoints;
  if (updates.costs !== undefined) {
    existing.costs = {
      inputTokenCostPer1M: parseFloat(updates.costs.inputTokenCostPer1M) || 0,
      outputTokenCostPer1M: parseFloat(updates.costs.outputTokenCostPer1M) || 0,
      currency: updates.costs.currency || 'USD'
    };
  }
  if (updates.sharedResourceWeight !== undefined) existing.sharedResourceWeight = Math.max(0, Math.min(100, parseInt(updates.sharedResourceWeight) || 0));
  if (updates.maxConcurrentRequests !== undefined) existing.maxConcurrentRequests = Math.max(1, Math.min(100, parseInt(updates.maxConcurrentRequests) || 5));
  if (updates.timeoutMs !== undefined) existing.timeoutMs = Math.max(5000, Math.min(600000, parseInt(updates.timeoutMs) || 120000));
  if (updates.extraHeaders !== undefined) existing.extraHeaders = updates.extraHeaders;

  config.backends.directory[idx] = existing;
  saveConfig(config);
  initBackendQueues();
  addLog('backends', `Updated backend: ${existing.name} (${existing.id})`);
  res.json({ success: true, backend: existing });
});

// Delete a backend
app.delete('/api/backends/:id', (req, res) => {
  if (!config.backends?.directory) {
    return res.status(404).json({ error: 'No backends configured' });
  }
  const idx = config.backends.directory.findIndex(b => b.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Backend not found' });
  }
  const removed = config.backends.directory.splice(idx, 1)[0];
  saveConfig(config);
  backendQueues.delete(removed.id);
  backendStats.delete(removed.id);
  addLog('backends', `Removed backend: ${removed.name} (${removed.id})`);
  res.json({ success: true, removed });
});

// Test backend connectivity
// Fetch available models from a remote backend
app.get('/api/backends/:id/models', async (req, res) => {
  const backend = config.backends?.directory?.find(b => b.id === req.params.id);
  if (!backend) {
    return res.status(404).json({ error: 'Backend not found' });
  }

  const apiKey = backend.apiKeyEnvVar ? process.env[backend.apiKeyEnvVar] : null;
  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (backend.extraHeaders) Object.assign(headers, backend.extraHeaders);
  const baseUrl = backend.url.replace(/\/+$/, '');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      return res.json({ models: [], error: `Backend returned ${response.status}` });
    }
    const data = await response.json();
    const models = (data.data || data.models || []).map(m => typeof m === 'string' ? m : m.id || m.name || '').filter(Boolean);
    res.json({ models });
  } catch (err) {
    res.json({ models: [], error: err.message });
  }
});

// Test backend connectivity — fetches models list first, then sends a test chat request
app.post('/api/backends/:id/test', async (req, res) => {
  const backend = config.backends?.directory?.find(b => b.id === req.params.id);
  if (!backend) {
    return res.status(404).json({ error: 'Backend not found' });
  }

  const apiKey = backend.apiKeyEnvVar ? process.env[backend.apiKeyEnvVar] : null;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (backend.extraHeaders) Object.assign(headers, backend.extraHeaders);

  const baseUrl = backend.url.replace(/\/+$/, '');
  const startTime = Date.now();

  try {
    // Step 1: Fetch available models from the backend
    const modelsController = new AbortController();
    const modelsTimeout = setTimeout(() => modelsController.abort(), 10000);
    let remoteModels = [];
    try {
      const modelsRes = await fetch(`${baseUrl}/models`, {
        headers: { ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}), ...(backend.extraHeaders || {}) },
        signal: modelsController.signal
      });
      clearTimeout(modelsTimeout);
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        remoteModels = (modelsData.data || modelsData.models || []).map(m => typeof m === 'string' ? m : m.id || m.name || '').filter(Boolean);
      }
    } catch {
      clearTimeout(modelsTimeout);
    }

    // Step 2: Pick a test model — prefer configured mapping, fall back to first available remote model
    let testModel = '';
    const mappingValues = Object.values(backend.modelMapping || {}).filter(v => v && v !== '*');
    if (mappingValues.length > 0) {
      testModel = mappingValues[0];
    } else if (remoteModels.length > 0) {
      testModel = remoteModels[0];
    }

    if (!testModel) {
      const duration = Date.now() - startTime;
      return res.json({
        success: false,
        status: 0,
        latencyMs: duration,
        remoteModels,
        error: 'No model available for testing. Configure a model mapping or ensure the backend has models loaded.',
        message: 'No model available for testing'
      });
    }

    // Step 3: Send a test chat completion
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: testModel,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 5,
        stream: false
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    const duration = Date.now() - startTime;
    const body = await response.text();

    if (response.ok) {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = null; }

      // Mark backend as tested
      const idx = config.backends.directory.findIndex(b => b.id === backend.id);
      if (idx !== -1) {
        config.backends.directory[idx].tested = true;
        config.backends.directory[idx].lastTestTime = Date.now();
        saveConfig(config);
      }

      res.json({
        success: true,
        status: response.status,
        latencyMs: duration,
        model: parsed?.model || testModel,
        remoteModels,
        message: `Connected successfully in ${duration}ms (model: ${parsed?.model || testModel})`
      });
    } else {
      // Mark test as failed
      const idx = config.backends.directory.findIndex(b => b.id === backend.id);
      if (idx !== -1) {
        config.backends.directory[idx].tested = false;
        config.backends.directory[idx].lastTestTime = Date.now();
        saveConfig(config);
      }

      res.json({
        success: false,
        status: response.status,
        latencyMs: duration,
        remoteModels,
        error: body.slice(0, 500),
        message: `Backend returned ${response.status}`
      });
    }
  } catch (err) {
    const duration = Date.now() - startTime;

    // Mark test as failed
    const idx = config.backends?.directory?.findIndex(b => b.id === backend.id);
    if (idx !== undefined && idx !== -1) {
      config.backends.directory[idx].tested = false;
      config.backends.directory[idx].lastTestTime = Date.now();
      saveConfig(config);
    }

    res.json({
      success: false,
      status: 0,
      latencyMs: duration,
      error: err.message,
      message: `Connection failed: ${err.message}`
    });
  }
});

// Get per-backend stats
app.get('/api/backends/stats', (req, res) => {
  const stats = {};
  for (const [id, s] of backendStats) {
    stats[id] = { ...s };
  }
  // Add local stats
  stats.local = {
    id: 'local',
    totalRequests: tokenStats.totalRequests,
    totalPromptTokens: tokenStats.totalPromptTokens,
    totalCompletionTokens: tokenStats.totalCompletionTokens,
    totalCostUsd: 0,
    avgTokPerSec: tokenStats.recentRequests.length > 0
      ? tokenStats.recentRequests.slice(-10).reduce((a, r) => a + (r.tokensPerSecond || 0), 0) / Math.min(10, tokenStats.recentRequests.length)
      : 0,
    queue: { active: llamaQueue.active, pending: llamaQueue.pending, concurrency: llamaQueue.concurrency }
  };
  res.json({ stats });
});

// Get/set routing policy
app.get('/api/backends/routing', (req, res) => {
  res.json({
    enabled: config.backends?.enabled || false,
    offloadPolicy: config.backends?.offloadPolicy || 'overflow',
    offloadThresholdQueueDepth: config.backends?.offloadThresholdQueueDepth ?? 2,
    offloadThresholdWaitMs: config.backends?.offloadThresholdWaitMs ?? 5000,
    offloadPercentage: config.backends?.offloadPercentage || 0,
    preferLocal: config.backends?.preferLocal !== false
  });
});

app.post('/api/backends/routing', (req, res) => {
  if (!config.backends) {
    config.backends = { enabled: false, offloadPolicy: 'overflow', offloadThresholdQueueDepth: 2, offloadThresholdWaitMs: 5000, offloadPercentage: 0, preferLocal: true, directory: [] };
  }

  const { enabled, offloadPolicy, offloadThresholdQueueDepth, offloadThresholdWaitMs, offloadPercentage, preferLocal } = req.body;

  if (enabled !== undefined) config.backends.enabled = Boolean(enabled);
  if (offloadPolicy !== undefined) {
    const validPolicies = ['overflow', 'threshold', 'percentage', 'manual'];
    if (!validPolicies.includes(offloadPolicy)) {
      return res.status(400).json({ error: `Invalid policy. Must be one of: ${validPolicies.join(', ')}` });
    }
    config.backends.offloadPolicy = offloadPolicy;
  }
  if (offloadThresholdQueueDepth !== undefined) {
    const v = parseInt(offloadThresholdQueueDepth);
    if (v >= 0 && v <= 100) config.backends.offloadThresholdQueueDepth = v;
  }
  if (offloadThresholdWaitMs !== undefined) {
    const v = parseInt(offloadThresholdWaitMs);
    if (v >= 0 && v <= 300000) config.backends.offloadThresholdWaitMs = v;
  }
  if (offloadPercentage !== undefined) {
    const v = parseInt(offloadPercentage);
    if (v >= 0 && v <= 100) config.backends.offloadPercentage = v;
  }
  if (preferLocal !== undefined) config.backends.preferLocal = Boolean(preferLocal);

  saveConfig(config);
  addLog('backends', `Routing policy updated: ${JSON.stringify(req.body)}`);
  res.json({ success: true, routing: config.backends });
});

// Get server status
app.get('/api/status', async (req, res) => {
  try {
    const llamaStatus = await fetchLlamaStatus();
    res.json({
      apiRunning: true,
      llamaRunning: llamaProcess !== null && !llamaProcess.killed,
      llamaHealthy: llamaStatus.healthy,
      llamaPort: LLAMA_PORT,
      modelsDir: MODELS_DIR,
      mode: currentMode,
      currentPreset: currentPreset ? config.presets[currentPreset] : null,
      downloads: Object.fromEntries(
        Array.from(downloadProcesses.entries()).map(([id, info]) => [
          id,
          { progress: info.progress, status: info.status, error: info.error }
        ])
      ),
      queue: {
        concurrency: llamaQueue.concurrency,
        active: llamaQueue.active,
        pending: llamaQueue.pending,
        totalQueued: llamaQueue.queuedCount
      }
    });
  } catch (error) {
    res.json({
      apiRunning: true,
      llamaRunning: false,
      llamaHealthy: false,
      llamaPort: LLAMA_PORT,
      modelsDir: MODELS_DIR,
      mode: currentMode,
      currentPreset: currentPreset ? config.presets[currentPreset] : null,
      error: error.message
    });
  }
});

async function fetchLlamaStatus() {
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/health`);
    return { healthy: response.ok };
  } catch {
    return { healthy: false };
  }
}

// Health check for the manager API itself — lightweight, suitable for load balancers
app.get('/health', async (req, res) => {
  const llamaRunning = llamaProcess !== null && !llamaProcess.killed;
  const llamaStatus = await fetchLlamaStatus();
  const memPercent = getSystemMemoryPercent();

  const status = idleShutdown ? 'idle' : llamaRunning && llamaStatus.healthy ? 'healthy' : llamaRunning ? 'degraded' : 'down';
  const httpStatus = status === 'down' ? 503 : 200;

  res.status(httpStatus).json({
    status,
    uptime: process.uptime(),
    llama: {
      running: llamaRunning,
      healthy: llamaStatus.healthy,
      mode: currentMode,
      preset: currentPreset || null
    },
    queue: {
      active: llamaQueue.active,
      pending: llamaQueue.pending,
      concurrency: llamaQueue.concurrency,
      totalQueued: llamaQueue.queuedCount
    },
    system: {
      memoryPercent: Math.round(memPercent * 10) / 10,
      watchdog: {
        threshold: MEM_WATCHDOG_THRESHOLD,
        cooldown: memWatchdogCooldown
      },
      idle: {
        shutdown: idleShutdown,
        timeoutMinutes: IDLE_SHUTDOWN_MINUTES,
        idleMinutes: lastUsedModelTime ? Math.round((Date.now() - lastUsedModelTime) / 60_000) : null
      }
    }
  });
});

// Proxy llama.cpp backend /health — returns raw llama-server health status
app.get('/api/v1/health', async (req, res) => {
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/health`, {
      signal: AbortSignal.timeout(5000)
    });
    const data = await response.json().catch(() => null);
    res.status(response.status).json(data || { status: response.ok ? 'ok' : 'error' });
  } catch (err) {
    res.status(503).json({ status: 'unavailable', error: err.message });
  }
});

// Flush the request queue — reject all pending requests
app.post('/api/queue/flush', (req, res) => {
  const flushed = llamaQueue.flush();
  const msg = `Queue flushed: ${flushed} pending request(s) cancelled`;
  console.log(`[queue] ${msg}`);
  addLog('system', msg);
  res.json({ flushed });
});

// List all queue items (active + pending) with metadata
app.get('/api/queue', (req, res) => {
  const detail = req.query.detail === 'full';

  // Resolve backend id -> name for display
  const backendDir = config?.backends?.directory || [];
  const backendNameMap = {};
  for (const b of backendDir) backendNameMap[b.id] = b.name || b.id;

  // Active requests from the activeRequests map (includes both local and remote)
  const activeItems = [...activeRequests.values()].map(ar => {
    const backendId = ar.backend || 'local';
    const isOffloaded = backendId !== 'local';
    const result = {
      id: ar.id,
      model: ar.model || 'unknown',
      endpoint: ar.endpoint || '',
      enqueuedAt: ar.startTime,
      startedAt: ar.startTime,
      status: 'active',
      elapsed: Date.now() - ar.startTime,
      userMessage: detail ? (ar.userMessage || '') : ((ar.userMessage || '').slice(0, 200)),
      tokens: ar.tokens || 0,
      activeRequestId: ar.id,
      backend: backendId,
      backendName: isOffloaded ? (backendNameMap[backendId] || backendId) : 'local',
      offloaded: isOffloaded
    };
    if (detail) {
      result.responseText = ar.responseText || '';
      result.startTime = ar.startTime;
      result.fullContext = ar.fullContext || [];
    }
    return result;
  });

  // Pending requests from the local queue (waiting for a slot)
  const pendingItems = llamaQueue.queue.map(item => ({
    id: item.id,
    model: item.model || 'unknown',
    endpoint: item.endpoint || '',
    enqueuedAt: item.enqueuedAt,
    startedAt: null,
    status: 'pending',
    elapsed: Date.now() - item.enqueuedAt,
    userMessage: '',
    tokens: 0,
    activeRequestId: null,
    backend: 'local',
    backendName: 'local (queued)',
    offloaded: false
  }));

  // Pending requests from remote backend queues
  const remotePendingItems = [];
  for (const [backendId, queue] of backendQueues) {
    const name = backendNameMap[backendId] || backendId;
    for (const item of queue.queue) {
      remotePendingItems.push({
        id: item.id,
        model: item.model || 'unknown',
        endpoint: item.endpoint || '',
        enqueuedAt: item.enqueuedAt,
        startedAt: null,
        status: 'pending',
        elapsed: Date.now() - item.enqueuedAt,
        userMessage: '',
        tokens: 0,
        activeRequestId: null,
        backend: backendId,
        backendName: `${name} (queued)`,
        offloaded: true
      });
    }
  }

  res.json({
    items: [...activeItems, ...pendingItems, ...remotePendingItems],
    concurrency: llamaQueue.concurrency,
    totalQueued: llamaQueue.queuedCount
  });
});

// Cancel a specific pending queue item
app.delete('/api/queue/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid queue item ID' });
  const cancelled = llamaQueue.cancel(id);
  if (cancelled) {
    const msg = `Queue item ${id} cancelled`;
    console.log(`[queue] ${msg}`);
    addLog('system', msg);
    res.json({ cancelled: true, id });
  } else {
    res.status(404).json({ error: 'Queue item not found or already active (only pending items can be cancelled)' });
  }
});

// Kill an active (processing) request by its activeRequest ID
app.delete('/api/queue/active/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid request ID' });
  const entry = activeRequests.get(id);
  if (!entry) return res.status(404).json({ error: 'Active request not found' });
  if (entry.abortController) {
    entry.abortController.abort();
    const msg = `Active request ${id} (model: ${entry.model}) killed`;
    console.log(`[queue] ${msg}`);
    addLog('system', msg);
    endActiveRequest(id, { status: 'cancelled' });
    res.json({ killed: true, id });
  } else {
    res.status(400).json({ error: 'Request cannot be aborted (no abort controller)' });
  }
});

// SSE stream for watching an active request's live output
app.get('/api/queue/watch/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid request ID' });

  const entry = activeRequests.get(id);
  if (!entry) return res.status(404).json({ error: 'Active request not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering

  // Send initial state with full context
  const { abortController: _ac, ...safeEntry } = entry;
  res.write(`data: ${JSON.stringify({ event: 'init', ...safeEntry })}\n\n`);

  // Stream updates
  const onUpdate = (data) => {
    res.write(`data: ${JSON.stringify({ event: 'update', ...data })}\n\n`);
  };
  const onEnd = (data) => {
    res.write(`data: ${JSON.stringify({ event: 'end', ...data })}\n\n`);
    cleanup();
  };

  activeRequestEvents.on(`update:${id}`, onUpdate);
  activeRequestEvents.on(`end:${id}`, onEnd);

  const cleanup = () => {
    activeRequestEvents.off(`update:${id}`, onUpdate);
    activeRequestEvents.off(`end:${id}`, onEnd);
    res.end();
  };

  req.on('close', cleanup);
});

// Get model aliases
app.get('/api/models/aliases', (req, res) => {
  res.json({ aliases: config.modelAliases || {} });
});

// Set a model alias
app.put('/api/models/aliases/:modelName(*)', (req, res) => {
  const modelName = req.params.modelName;
  const { alias } = req.body;

  if (!config.modelAliases) {
    config.modelAliases = {};
  }

  if (alias === null || alias === '') {
    // Remove alias
    delete config.modelAliases[modelName];
  } else {
    // Set alias
    config.modelAliases[modelName] = alias;
  }

  saveConfig(config);
  res.json({ success: true, aliases: config.modelAliases });
});

// Delete a model alias
app.delete('/api/models/aliases/:modelName(*)', (req, res) => {
  const modelName = req.params.modelName;

  if (config.modelAliases && config.modelAliases[modelName]) {
    delete config.modelAliases[modelName];
    saveConfig(config);
  }

  res.json({ success: true, aliases: config.modelAliases || {} });
});

// Get models from llama-server (loaded/available)
app.get('/api/models', async (req, res) => {
  try {
    // Get models from llama-server
    let serverModels = [];
    try {
      const response = await fetch(`http://localhost:${LLAMA_PORT}/models`);
      if (response.ok) {
        const data = await response.json();
        serverModels = data.data || data || [];
      }
    } catch {
      // Server not running, that's ok
    }

    // Get local models from filesystem
    const localModels = scanLocalModels();

    res.json({
      serverModels,
      localModels,
      modelsDir: MODELS_DIR,
      lastUsedModel,
      lastUsedModelTime
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Load a model in llama-server (router mode)
// In router mode, models are loaded on-demand when chat completions are requested.
// This endpoint pre-loads a model by making a minimal completion request.
app.post('/api/models/load', async (req, res) => {
  const { model } = req.body;

  if (!model) {
    return res.status(400).json({ error: 'Missing model parameter' });
  }

  // Resolve model name to full path to verify it exists
  const modelPath = join(MODELS_DIR, model);
  console.log(`[models/load] Attempting to load model: ${model}`);
  console.log(`[models/load] Full path: ${modelPath}`);
  addLog('models', `Loading model: ${model} (${modelPath})`);

  // Verify model exists
  if (!existsSync(modelPath)) {
    console.error(`[models/load] Model file not found: ${modelPath}`);
    addLog('models', `Model file not found: ${modelPath}`);
    return res.status(404).json({ error: `Model file not found: ${model}` });
  }

  try {
    // In router mode, trigger model loading by making a minimal completion request
    // llama.cpp will load the model on-demand
    const response = await fetch(`http://localhost:${LLAMA_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[models/load] llama.cpp error (${response.status}): ${error}`);
      addLog('models', `Failed to load model: ${error}`);
      return res.status(response.status).json({ error: `Failed to load model: ${error}` });
    }

    // Consume the response
    await response.text();

    console.log(`[models/load] Model loaded successfully: ${model}`);
    addLog('models', `Model loaded: ${model}`);
    res.json({ success: true, model });
  } catch (error) {
    console.error(`[models/load] Error: ${error.message}`);
    addLog('models', `Error loading model: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Unload a model from llama-server (router mode)
// In router mode, models are automatically unloaded when new models need to be loaded
// and the max model limit is reached. This endpoint attempts to use the unload API
// if available, otherwise returns a message about automatic unloading.
app.post('/api/models/unload', async (req, res) => {
  const { model } = req.body;

  if (!model) {
    return res.status(400).json({ error: 'Missing model parameter' });
  }

  console.log(`[models/unload] Attempting to unload model: ${model}`);
  addLog('models', `Unloading model: ${model}`);

  try {
    // Try the unload endpoint (may not exist in router mode)
    const response = await fetch(`http://localhost:${LLAMA_PORT}/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });

    if (response.ok) {
      const data = await response.json();
      console.log(`[models/unload] Model unloaded successfully: ${model}`);
      addLog('models', `Model unloaded: ${model}`);
      res.json({ success: true, ...data });
    } else if (response.status === 404) {
      // Endpoint doesn't exist in router mode - this is expected
      console.log(`[models/unload] Unload endpoint not available (router mode). Model will be unloaded automatically when needed.`);
      res.json({
        success: true,
        message: 'In router mode, models are automatically unloaded when new models need to be loaded. The model will be unloaded when the slot is needed.'
      });
    } else {
      const error = await response.text();
      console.error(`[models/unload] Error: ${error}`);
      return res.status(response.status).json({ error });
    }
  } catch (error) {
    console.error(`[models/unload] Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get available presets
app.get('/api/presets', (req, res) => {
  const presets = config.presets || {};
  res.json({
    presets: Object.values(presets),
    currentPreset: currentPreset,
    mode: currentMode
  });
});

// Create a preset
app.post('/api/presets', (req, res) => {
  const { id, name, description, modelPath, hfRepo, context, config: presetConfig } = req.body;

  // Either modelPath or hfRepo must be provided
  if (!id || !name || (!modelPath && !hfRepo)) {
    return res.status(400).json({ error: 'Missing required fields: id, name, and either modelPath or hfRepo' });
  }

  // Check if preset ID already exists
  if (config.presets && config.presets[id]) {
    return res.status(409).json({ error: `Preset with ID '${id}' already exists. Use PUT to update or choose a different ID.` });
  }

  let fullModelPath = null;

  // If using local file path, validate it exists
  // When hfRepo is provided, we prioritize that and ignore modelPath
  if (modelPath && !hfRepo) {
    fullModelPath = modelPath.startsWith('/') ? modelPath : join(MODELS_DIR, modelPath);
    if (!existsSync(fullModelPath)) {
      return res.status(404).json({ error: `Model file not found: ${modelPath}` });
    }
  }

  // Create the preset
  // Note: When hfRepo is provided, modelPath is intentionally set to null
  // as the model will be downloaded from Hugging Face
  const preset = {
    id,
    name,
    description: description || `Preset for ${name}`,
    modelPath: fullModelPath,
    hfRepo: hfRepo || null, // e.g., "unsloth/Qwen3-Coder-Next-GGUF:Q5_K_M"
    context: context || 0,
    config: {
      chatTemplateKwargs: presetConfig?.chatTemplateKwargs || '',
      reasoningFormat: presetConfig?.reasoningFormat || '',
      temp: presetConfig?.temp ?? 0.7,
      topP: presetConfig?.topP ?? 1.0,
      topK: presetConfig?.topK ?? 20,
      minP: presetConfig?.minP ?? 0,
      extraSwitches: presetConfig?.extraSwitches || '--jinja'
    }
  };

  // Save to config
  if (!config.presets) {
    config.presets = {};
  }
  config.presets[id] = preset;
  saveConfig(config);

  const modelInfo = hfRepo || modelPath;
  console.log(`[presets] Created preset: ${id} for model ${modelInfo}`);
  addLog('presets', `Created preset: ${name}`);

  res.json({ success: true, preset });
});

// Update a preset
app.put('/api/presets/:presetId', (req, res) => {
  const { presetId } = req.params;
  const updates = req.body;

  if (!config.presets || !config.presets[presetId]) {
    return res.status(404).json({ error: `Preset '${presetId}' not found` });
  }

  // Update the preset
  config.presets[presetId] = {
    ...config.presets[presetId],
    ...updates,
    id: presetId // Preserve ID
  };
  saveConfig(config);

  console.log(`[presets] Updated preset: ${presetId}`);
  res.json({ success: true, preset: config.presets[presetId] });
});

// Delete a preset
app.delete('/api/presets/:presetId', (req, res) => {
  const { presetId } = req.params;

  if (!config.presets || !config.presets[presetId]) {
    return res.status(404).json({ error: `Preset '${presetId}' not found` });
  }

  // Prevent deletion of currently active preset
  if (currentPreset === presetId) {
    return res.status(400).json({ error: `Cannot delete preset '${presetId}' while it is active. Switch to router mode or another preset first.` });
  }

  delete config.presets[presetId];
  saveConfig(config);

  console.log(`[presets] Deleted preset: ${presetId}`);
  res.json({ success: true });
});

// Helper to stop llama server
async function stopLlamaServer() {
  console.log('[stop] Stopping llama server...');
  intentionalStop = true;

  // First, kill the Node.js spawned process if any
  if (llamaProcess && !llamaProcess.killed) {
    console.log('[stop] Killing spawned process...');
    llamaProcess.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (!llamaProcess.killed) {
      llamaProcess.kill('SIGKILL');
    }
  }
  llamaProcess = null;

  // Kill ALL llama-server processes inside the container
  // Router mode spawns workers on dynamic ports, so we must kill by process name
  console.log('[stop] Killing all llama-server processes...');

  await new Promise((resolve) => {
    const killCommand = `pkill -9 -f "llama-server" || true`;

    const killProcess = spawn('/usr/local/bin/distrobox', [
      'enter', CONTAINER_NAME, '--',
      'bash', '-c', killCommand
    ], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' },
      stdio: 'pipe'
    });

    killProcess.on('exit', () => {
      console.log('[stop] Kill command completed');
      resolve();
    });

    killProcess.on('error', (err) => {
      console.error('[stop] Kill command error:', err);
      resolve();
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      console.log('[stop] Kill command timeout');
      resolve();
    }, 5000);
  });

  // Also kill any llama-server processes directly on the host
  // (distrobox shares the host process namespace, but this ensures we catch everything)
  await new Promise((resolve) => {
    exec('pkill -9 -f "llama-server" || true', (err) => {
      if (err) console.error('[stop] Host pkill error:', err.message);
      resolve();
    });
    setTimeout(() => resolve(), 3000);
  });

  // Also try to kill by port using fuser/lsof inside the container
  await new Promise((resolve) => {
    const fuserCommand = `fuser -k ${LLAMA_PORT}/tcp 2>/dev/null || true`;

    const fuserProcess = spawn('/usr/local/bin/distrobox', [
      'enter', CONTAINER_NAME, '--',
      'bash', '-c', fuserCommand
    ], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' },
      stdio: 'pipe'
    });

    fuserProcess.on('exit', () => resolve());
    fuserProcess.on('error', () => resolve());
    setTimeout(() => resolve(), 3000);
  });

  // Give processes time to fully terminate
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log('[stop] Llama server stopped');
}

// Restart llama server in its current mode (router or preset)
// Used by fetchWithRetry when the server appears to have crashed
let restartInProgress = false;
async function restartLlamaServer() {
  if (restartInProgress) {
    console.log('[restart] Restart already in progress, waiting for it to complete...');
    // Wait for the in-progress restart to finish
    while (restartInProgress) {
      await new Promise(r => setTimeout(r, 1000));
    }
    return;
  }

  restartInProgress = true;
  try {
    console.log(`[restart] Restarting llama server (mode: ${currentMode}, preset: ${currentPreset || 'none'})...`);
    addLog('system', `Auto-restarting llama server (mode: ${currentMode}, preset: ${currentPreset || 'none'})`);

    await stopLlamaServer();

    if (currentMode === 'single' && currentPreset && config.presets?.[currentPreset]) {
      const preset = config.presets[currentPreset];
      const startScript = join(PROJECT_ROOT, 'start-preset.sh');
      const env = {
        ...process.env,
        PORT: String(LLAMA_PORT),
        MODELS_DIR,
        HF_REPO: preset.hfRepo || '',
        MODEL_PATH: preset.hfRepo ? '' : (preset.modelPath || ''),
        CONTEXT: String(preset.context || 0),
        TEMP: String(preset.config?.temp ?? 0.7),
        TOP_P: String(preset.config?.topP ?? 1.0),
        TOP_K: String(preset.config?.topK ?? 20),
        MIN_P: String(preset.config?.minP ?? 0),
        CHAT_TEMPLATE_KWARGS: preset.config?.chatTemplateKwargs || '',
        EXTRA_SWITCHES: preset.config?.extraSwitches || '--jinja'
      };

      console.log(`[restart] Starting preset: ${currentPreset}`);
      llamaProcess = spawn('bash', [startScript], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        detached: false
      });
    } else {
      const startScript = join(PROJECT_ROOT, 'start-llama.sh');
      const env = {
        ...process.env,
        MODELS_DIR,
        MODELS_MAX: String(config.modelsMax || 2),
        CONTEXT: String(config.contextSize || 8192),
        PORT: String(LLAMA_PORT),
        NO_WARMUP: config.noWarmup ? '1' : '',
        FLASH_ATTN: config.flashAttn ? '1' : '',
        GPU_LAYERS: String(config.gpuLayers || 99),
        HF_TOKEN: process.env.HF_TOKEN || ''
      };

      console.log('[restart] Starting router mode');
      currentMode = 'router';
      currentPreset = null;
      llamaProcess = spawn('bash', [startScript], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        detached: false
      });
    }

    llamaProcess.stdout.on('data', (data) => {
      addLog('llama', data);
    });
    llamaProcess.stderr.on('data', (data) => {
      addLog('llama', data);
    });
    attachLlamaExitHandler(llamaProcess);
    intentionalStop = false;

    // Wait for server to become healthy
    const ready = await waitForServerReady({ maxWait: 60000, label: 'restart' });
    if (ready) {
      console.log('[restart] Llama server restarted successfully');
      addLog('system', 'Llama server restarted successfully');
    } else {
      console.error('[restart] Llama server failed to become ready after restart');
      addLog('system', 'Llama server failed to become ready after restart');
    }
  } finally {
    restartInProgress = false;
  }
}

// Auto-restart llama server on unexpected exit
let intentionalStop = false; // Set true during stopLlamaServer to suppress auto-restart
function attachLlamaExitHandler(proc) {
  proc.on('exit', (code) => {
    addLog('system', `llama-server exited with code ${code} (mode: ${currentMode}, preset: ${currentPreset || 'none'})`);
    // Do NOT reset currentMode/currentPreset here — restartLlamaServer needs them to restore the same mode
    // Auto-restart if the exit was unexpected (not during intentional stop/restart)
    if (!intentionalStop && !restartInProgress && code !== 0) {
      console.log(`[auto-restart] llama-server crashed (exit code ${code}), scheduling restart...`);
      addLog('system', `llama-server crashed (exit code ${code}), auto-restarting in 3s...`);
      recordCrashEvent({ exitCode: code, trigger: 'exit_handler' });
      setTimeout(() => {
        if (!restartInProgress && !intentionalStop) {
          restartLlamaServer().catch(err => {
            console.error('[auto-restart] Failed to restart:', err.message);
            addLog('system', `Auto-restart failed: ${err.message}`);
          });
        }
      }, 3000);
    }
  });
}

// Start llama server in router mode (multi-model)
app.post('/api/server/start', async (req, res) => {
  idleShutdown = false;
  await stopLlamaServer();

  try {
    currentMode = 'router';
    currentPreset = null;

    const startScript = join(PROJECT_ROOT, 'start-llama.sh');
    const env = {
      ...process.env,
      MODELS_DIR,
      MODELS_MAX: String(config.modelsMax || 2),
      CONTEXT: String(config.contextSize || 8192),
      PORT: String(LLAMA_PORT),
      NO_WARMUP: config.noWarmup ? '1' : '',
      FLASH_ATTN: config.flashAttn ? '1' : '',
      GPU_LAYERS: String(config.gpuLayers || 99),
      HF_TOKEN: process.env.HF_TOKEN || ''
    };

    llamaProcess = spawn('bash', [startScript], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: false
    });

    llamaProcess.stdout.on('data', (data) => {
      addLog('llama', data);
    });
    llamaProcess.stderr.on('data', (data) => {
      addLog('llama', data);
    });

    attachLlamaExitHandler(llamaProcess);
    intentionalStop = false;

    res.json({ success: true, mode: 'router', pid: llamaProcess.pid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Activate a preset (single-model mode)
app.post('/api/presets/:presetId/activate', async (req, res) => {
  const { presetId } = req.params;

  // Look up preset in config
  const preset = config.presets ? config.presets[presetId] : null;

  if (!preset) {
    return res.status(404).json({ error: `Preset '${presetId}' not found` });
  }

  await stopLlamaServer();

  try {
    currentMode = 'single';
    currentPreset = presetId;

    // All presets use the same script with environment variables
    const startScript = join(PROJECT_ROOT, 'start-preset.sh');
    const env = {
      ...process.env,
      PORT: String(LLAMA_PORT),
      MODELS_DIR,
      // Use HF_REPO if available, otherwise MODEL_PATH
      HF_REPO: preset.hfRepo || '',
      MODEL_PATH: preset.hfRepo ? '' : (preset.modelPath || ''),
      CONTEXT: String(preset.context || 0),
      TEMP: String(preset.config?.temp ?? 0.7),
      TOP_P: String(preset.config?.topP ?? 1.0),
      TOP_K: String(preset.config?.topK ?? 20),
      MIN_P: String(preset.config?.minP ?? 0),
      CHAT_TEMPLATE_KWARGS: preset.config?.chatTemplateKwargs || '',
      EXTRA_SWITCHES: preset.config?.extraSwitches || '--jinja'
    };

    const modelInfo = preset.hfRepo || preset.modelPath;
    console.log(`[presets] Activating preset: ${presetId} with model ${modelInfo}`);
    console.log(`[presets] EXTRA_SWITCHES: ${env.EXTRA_SWITCHES}`);
    addLog('presets', `Activating preset: ${preset.name}`);
    addLog('presets', `EXTRA_SWITCHES: ${env.EXTRA_SWITCHES}`);

    llamaProcess = spawn('bash', [startScript], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: false
    });

    llamaProcess.stdout.on('data', (data) => {
      addLog('llama', data);
    });
    llamaProcess.stderr.on('data', (data) => {
      addLog('llama', data);
    });

    attachLlamaExitHandler(llamaProcess);
    intentionalStop = false;

    res.json({
      success: true,
      mode: 'single',
      preset: preset,
      pid: llamaProcess.pid
    });
  } catch (error) {
    currentMode = 'router';
    currentPreset = null;
    res.status(500).json({ error: error.message });
  }
});

// Stop llama server
app.post('/api/server/stop', async (req, res) => {
  if (!llamaProcess || llamaProcess.killed) {
    currentMode = 'router';
    currentPreset = null;
    return res.json({ success: true, message: 'Server not running' });
  }

  await stopLlamaServer();
  currentMode = 'router';
  currentPreset = null;

  res.json({ success: true });
});

// Update llama.cpp - pull latest and rebuild
let llamaUpdateProcess = null;
let llamaUpdateStatus = { status: 'idle', output: '', startedAt: null, completedAt: null };

app.get('/api/llama/update/status', (req, res) => {
  res.json(llamaUpdateStatus);
});

app.post('/api/llama/update', async (req, res) => {
  if (llamaUpdateProcess && !llamaUpdateProcess.killed) {
    return res.json({ success: false, error: 'Update already in progress' });
  }

  // Stop llama server if running
  if (llamaProcess && !llamaProcess.killed) {
    addLog('update', 'Stopping llama server before update...');
    await stopLlamaServer();
  }

  llamaUpdateStatus = { status: 'updating', output: '', startedAt: new Date().toISOString(), completedAt: null };

  // Run update script in distrobox
  const updateScript = `
    cd /home/yolan/llama.cpp && \
    echo "=== Fetching latest changes ===" && \
    git fetch origin master && \
    echo "" && \
    echo "=== Current version ===" && \
    git log --oneline -1 && \
    echo "" && \
    echo "=== Pulling updates ===" && \
    git checkout master && \
    git pull origin master && \
    echo "" && \
    echo "=== New version ===" && \
    git log --oneline -1 && \
    echo "" && \
    echo "=== Building llama.cpp ===" && \
    cmake --build build -j$(nproc) && \
    echo "" && \
    echo "=== Installing ===" && \
    cmake --install build --prefix ~/.local && \
    echo "" && \
    echo "=== Update complete ===" && \
    llama-server --version
  `;

  const distrobox = existsSync('/usr/local/bin/distrobox') ? '/usr/local/bin/distrobox' : 'distrobox';

  llamaUpdateProcess = spawn(distrobox, ['enter', CONTAINER_NAME, '--', 'bash', '-c', updateScript], {
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'
    }
  });

  llamaUpdateProcess.stdout.on('data', (data) => {
    const text = data.toString();
    llamaUpdateStatus.output += text;
    addLog('update', text);
    broadcast({ type: 'llama_update', data: { output: text, status: 'updating' } });
  });

  llamaUpdateProcess.stderr.on('data', (data) => {
    const text = data.toString();
    llamaUpdateStatus.output += text;
    addLog('update', text);
    broadcast({ type: 'llama_update', data: { output: text, status: 'updating' } });
  });

  llamaUpdateProcess.on('close', (code) => {
    llamaUpdateStatus.completedAt = new Date().toISOString();
    if (code === 0) {
      llamaUpdateStatus.status = 'success';
      addLog('update', 'llama.cpp update completed successfully');
    } else {
      llamaUpdateStatus.status = 'failed';
      addLog('update', `llama.cpp update failed with code ${code}`);
    }
    broadcast({ type: 'llama_update', data: { status: llamaUpdateStatus.status, code } });
    llamaUpdateProcess = null;
  });

  res.json({ success: true, message: 'Update started' });
});

// Helper: Flatten nested GGUF files to one level deep
// Moves any .gguf files from subdirectories to the target directory root
function flattenGgufFiles(targetDir) {
  try {
    const findGgufRecursive = (dir, depth = 0) => {
      const files = [];
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          // Only recurse into non-hidden directories
          files.push(...findGgufRecursive(fullPath, depth + 1));
        } else if (entry.isFile() && entry.name.endsWith('.gguf') && depth > 0) {
          // Only collect GGUF files that are nested (depth > 0)
          files.push({ path: fullPath, name: entry.name });
        }
      }
      return files;
    };

    const nestedFiles = findGgufRecursive(targetDir);

    for (const file of nestedFiles) {
      const destPath = join(targetDir, file.name);
      if (!existsSync(destPath)) {
        console.log(`[download] Flattening: ${file.path} -> ${destPath}`);
        renameSync(file.path, destPath);
      } else {
        console.log(`[download] Skipping flatten (exists): ${file.name}`);
      }
    }

    // Clean up empty subdirectories (not .cache)
    const cleanEmptyDirs = (dir) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const subDir = join(dir, entry.name);
          cleanEmptyDirs(subDir);
          // Remove if empty
          try {
            const remaining = readdirSync(subDir);
            if (remaining.length === 0) {
              rmdirSync(subDir);
              console.log(`[download] Removed empty dir: ${subDir}`);
            }
          } catch (e) { /* ignore */ }
        }
      }
    };
    cleanEmptyDirs(targetDir);

    return nestedFiles.length;
  } catch (error) {
    console.error(`[download] Error flattening files: ${error.message}`);
    return 0;
  }
}

// Download a model from HuggingFace to ~/models
// Supports: quantization pattern, specific filename, or all GGUF files
app.post('/api/pull', async (req, res) => {
  const { repo, quantization, filename, pattern } = req.body;

  if (!repo) {
    return res.status(400).json({ error: 'Missing repo parameter' });
  }

  // Determine what to download
  let includePatterns = [];
  let downloadId = repo;

  if (filename) {
    // Download specific file
    includePatterns = [filename];
    downloadId = `${repo}:${filename}`;
  } else if (quantization) {
    // Download by quantization pattern
    const quant = quantization.toUpperCase();
    const quantLower = quantization.toLowerCase();
    includePatterns = [`*${quant}*.gguf`, `*${quantLower}*.gguf`];
    downloadId = `${repo}:${quantization}`;
  } else if (pattern) {
    // Custom pattern
    includePatterns = [pattern];
    downloadId = `${repo}:${pattern}`;
  } else {
    // Download all GGUF files
    includePatterns = ['*.gguf'];
    downloadId = `${repo}:all`;
  }

  if (downloadProcesses.has(downloadId)) {
    const existing = downloadProcesses.get(downloadId);
    if (existing.status === 'downloading' || existing.status === 'starting') {
      return res.json({
        success: true,
        downloadId,
        status: 'already_downloading',
        progress: existing.progress
      });
    }
  }

  const downloadInfo = { progress: 0, status: 'starting', output: '', error: null, startedAt: new Date().toISOString() };
  downloadProcesses.set(downloadId, downloadInfo);

  try {
    // Downloads to ~/models with repo structure
    const targetDir = join(MODELS_DIR, repo.replace('/', '_'));
    mkdirSync(targetDir, { recursive: true });

    // Build include arguments for hf download
    const includeArgs = includePatterns.flatMap(p => ['--include', p]);
    const hfArgs = [
      'download', repo,
      ...includeArgs,
      '--local-dir', targetDir
    ];

    console.log(`[download] Starting: ${HF_CLI_PATH} ${hfArgs.join(' ')}`);
    addLog('download', `Starting download: ${repo} (${includePatterns.join(', ')})`);

    // Helper to strip ANSI escape sequences from PTY output
    const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

    // Run huggingface-cli using node-pty to get real-time progress updates
    // PTY prevents output buffering that causes progress indicator to not update
    let downloadProcess;
    try {
      downloadProcess = pty.spawn(HF_CLI_PATH, hfArgs, {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HF_HUB_ENABLE_HF_TRANSFER: '1',
          HF_TOKEN: process.env.HF_TOKEN || '',
          PYTHONUNBUFFERED: '1'
        },
        cols: 80,
        rows: 24
      });
    } catch (err) {
      // Handle spawn failures (e.g., missing HF_CLI_PATH)
      console.error(`[download] Process error: ${err.message}`);
      downloadInfo.status = 'failed';
      if (err.code === 'ENOENT') {
        downloadInfo.error = `huggingface-cli not found. Run ./install.sh to set up the Python environment.`;
      } else {
        downloadInfo.error = `Failed to start download: ${err.message}`;
      }
      downloadInfo.output += `\nError: ${err.message}`;
      addLog('download', `Download failed: ${repo} (${err.message})`);
      setTimeout(() => downloadProcesses.delete(downloadId), 300000);
      return res.status(500).json({ error: downloadInfo.error });
    }

    // Store process handle for cleanup
    downloadInfo.process = downloadProcess;

    downloadProcess.onData((data) => {
      // Strip ANSI escape sequences before storing output for web UI display
      const cleanData = stripAnsi(data);
      downloadInfo.output += cleanData;
      downloadInfo.status = 'downloading';

      // Parse progress from huggingface-cli output
      // Split by newline (handling optional carriage return) and filter out empty lines
      const lines = cleanData.split(/\r?\n/).filter(line => line.length > 0);
      for (const line of lines) {
        // Look for patterns like "50%|" or "Downloading: 50%"
        const progressMatch = line.match(/(\d+)%/);
        if (progressMatch) {
          downloadInfo.progress = parseInt(progressMatch[1]);
        }

        // Check for completion indicators
        if (line.includes('Download complete') || line.includes('already exists') || line.includes('Fetching')) {
          if (line.includes('100%')) {
            downloadInfo.progress = 100;
          }
        }

        // Log important messages
        if (line.includes('Downloading') || line.includes('Error') || line.includes('complete')) {
          console.log(`[download] ${line.trim()}`);
        }

        if (line.includes('Error') || line.includes('error')) {
          console.error(`[download] ${line}`);
        }
      }
    });

    downloadProcess.onExit(({ exitCode }) => {
      if (exitCode === 0) {
        // Flatten any nested GGUF files to one level deep
        const flattened = flattenGgufFiles(targetDir);
        if (flattened > 0) {
          addLog('download', `Flattened ${flattened} nested GGUF file(s)`);
        }
        downloadInfo.status = 'completed';
        downloadInfo.progress = 100;
        addLog('download', `Download completed: ${repo}`);
      } else if (downloadInfo.status !== 'failed') {
        // Only update if status wasn't already set to 'failed' earlier
        downloadInfo.status = 'failed';
        // Provide helpful error messages for common exit codes
        let errorMsg = `Process exited with code ${exitCode}.`;
        if (exitCode === 127) {
          errorMsg = `Command not found (exit code 127). Run ./install.sh to set up the Python environment.`;
        } else if (exitCode === 1) {
          errorMsg = `Download failed (exit code 1). Check output for details - this may be an authentication issue (set HF_TOKEN env var) or network problem.`;
        }
        downloadInfo.error = errorMsg;
        addLog('download', `Download failed: ${repo} (code ${exitCode})`);
      }
      // Clean up process reference and schedule deletion
      downloadInfo.process = null;
      setTimeout(() => downloadProcesses.delete(downloadId), 300000);
    });

    res.json({ success: true, downloadId, status: 'started', targetDir, patterns: includePatterns });
  } catch (error) {
    downloadInfo.status = 'failed';
    downloadInfo.error = error.message;
    res.status(500).json({ error: error.message });
  }
});

// Get download status
app.get('/api/pull/:downloadId(*)', (req, res) => {
  const downloadId = req.params.downloadId;
  const info = downloadProcesses.get(downloadId);

  if (!info) {
    return res.status(404).json({ error: 'Download not found' });
  }

  res.json({
    downloadId,
    progress: info.progress,
    status: info.status,
    error: info.error,
    output: info.output
  });
});

// Get all downloads
app.get('/api/downloads', (req, res) => {
  const downloads = Array.from(downloadProcesses.entries()).map(([id, info]) => ({
    id,
    progress: info.progress,
    status: info.status,
    error: info.error,
    output: info.output,
    startedAt: info.startedAt
  }));
  res.json({ downloads });
});

// Clear a completed/failed download
app.delete('/api/downloads/:downloadId(*)', (req, res) => {
  const downloadId = req.params.downloadId;
  const info = downloadProcesses.get(downloadId);

  if (!info) {
    return res.status(404).json({ error: 'Download not found' });
  }

  if (info.status === 'downloading' || info.status === 'starting') {
    return res.status(400).json({ error: 'Cannot clear active download' });
  }

  downloadProcesses.delete(downloadId);
  res.json({ success: true });
});

// Search HuggingFace for GGUF models
app.get('/api/search', async (req, res) => {
  const { query } = req.query;

  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter' });
  }

  try {
    const searchUrl = `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&direction=-1&limit=20`;
    const response = await fetch(searchUrl);
    const models = await response.json();

    res.json({
      results: models.map(m => ({
        id: m.id,
        author: m.author,
        modelId: m.modelId,
        downloads: m.downloads,
        likes: m.likes,
        tags: m.tags
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get files in a HuggingFace repo (to find quantizations)
// Uses huggingface-cli for file listing, falls back to API for sizes
app.get('/api/repo/:author/:model/files', async (req, res) => {
  const { author, model } = req.params;
  const repoId = `${author}/${model}`;

  try {
    // First try using huggingface-cli to list files (fast but may not have sizes)
    let files = await listRepoFilesWithCli(repoId);

    // Check if CLI returned files but without sizes - fall back to API
    const hasAnySizes = files.some(f => f.size > 0);
    if (files.length > 0 && !hasAnySizes) {
      console.log('[repo/files] CLI returned files without sizes, falling back to API');
      files = await fetchRepoFilesRecursive(repoId);
    } else if (files.length === 0) {
      // No files from CLI, use API
      files = await fetchRepoFilesRecursive(repoId);
    }

    const quantizations = groupFilesByQuantization(files);
    res.json({ quantizations });
  } catch (error) {
    console.error('[repo/files] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List repo files using huggingface CLI (from project venv)
async function listRepoFilesWithCli(repoId) {
  return new Promise((resolve) => {
    // Check if hf CLI exists in venv
    if (!existsSync(HF_CLI_PATH)) {
      console.log('[repo/files] HuggingFace CLI not found in venv, falling back to API');
      resolve([]);
      return;
    }

    // Use 'hf models info --expand=siblings' to get file listing as JSON
    const cmd = spawn(HF_CLI_PATH, ['models', 'info', repoId, '--expand=siblings'], {
      env: {
        ...process.env,
        HF_TOKEN: process.env.HF_TOKEN || ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    let errorOutput = '';

    cmd.stdout.on('data', (data) => {
      output += data.toString();
    });

    cmd.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    cmd.on('close', (code) => {
      if (code !== 0 || !output.trim()) {
        console.log('[repo/files] CLI failed or no output, falling back to API');
        resolve([]);
        return;
      }

      // Parse JSON output and extract gguf files from siblings
      const files = [];
      try {
        const data = JSON.parse(output);
        const siblings = data.siblings || [];
        for (const sibling of siblings) {
          const filename = sibling.rfilename || sibling.path || '';
          if (filename.endsWith('.gguf')) {
            // Size might be in sibling.size or sibling.lfs.size for large files
            const size = sibling.size || sibling.lfs?.size || 0;
            files.push({
              path: filename,
              size: size
            });
          }
        }
      } catch (e) {
        console.log('[repo/files] Failed to parse CLI JSON output, falling back to API');
        resolve([]);
        return;
      }

      resolve(files);
    });

    cmd.on('error', () => resolve([]));
    setTimeout(() => resolve([]), 15000);
  });
}

// Recursively fetch files from HuggingFace API
async function fetchRepoFilesRecursive(repoId, path = '') {
  const allFiles = [];

  try {
    const url = `https://huggingface.co/api/models/${repoId}/tree/main${path ? '/' + path : ''}`;
    const response = await fetch(url, {
      headers: process.env.HF_TOKEN ? { 'Authorization': `Bearer ${process.env.HF_TOKEN}` } : {}
    });

    if (!response.ok) {
      console.error(`[repo/files] API error for ${url}: ${response.status}`);
      return allFiles;
    }

    const items = await response.json();

    for (const item of items) {
      if (item.type === 'directory') {
        // Recursively fetch subdirectory
        const subFiles = await fetchRepoFilesRecursive(repoId, item.path);
        allFiles.push(...subFiles);
      } else if (item.path && item.path.endsWith('.gguf')) {
        // Size might be in item.size or item.lfs.size for large files
        const size = item.size || item.lfs?.size || 0;
        allFiles.push({
          path: item.path,
          size: size
        });
      }
    }
  } catch (error) {
    console.error(`[repo/files] Error fetching ${path}:`, error.message);
  }

  return allFiles;
}

// Group files by quantization
function groupFilesByQuantization(files) {
  const quantizations = new Map();

  for (const file of files) {
    const quant = extractQuantization(file.path);
    if (!quant) continue;

    // Check if this is a split file (e.g., model-00001-of-00003.gguf)
    const splitMatch = file.path.match(/[-_](\d{5})-of-(\d{5})\.gguf$/i);

    if (!quantizations.has(quant)) {
      quantizations.set(quant, {
        quantization: quant,
        files: [],
        totalSize: 0,
        isSplit: false,
        totalParts: 1
      });
    }

    const entry = quantizations.get(quant);
    entry.files.push(file.path);
    entry.totalSize += file.size || 0;

    if (splitMatch) {
      entry.isSplit = true;
      entry.totalParts = parseInt(splitMatch[2]);
    }
  }

  // Convert to array and sort by quantization name
  return Array.from(quantizations.values())
    .sort((a, b) => a.quantization.localeCompare(b.quantization));
}

function extractQuantization(filename) {
  // Remove split suffix first for matching
  const cleanName = filename.replace(/[-_]\d{5}-of-\d{5}\.gguf$/i, '.gguf');

  const patterns = [
    /[-_](Q\d+_K(?:_[SML])?)/i,
    /[-_](IQ\d+_[A-Z]+)/i,
    /[-_](F16|F32|BF16)/i,
    /[-_](Q\d+_0)/i,
    /[-_](Q\d+)/i
  ];

  for (const pattern of patterns) {
    const match = cleanName.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

// Update config
app.post('/api/config', (req, res) => {
  const updates = req.body;
  config = { ...config, ...updates };
  saveConfig(config);
  res.json({ success: true, config });
});

app.get('/api/config', (req, res) => {
  res.json(config);
});

// Get system stats (REST endpoint for initial load)
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getSystemStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve OpenAPI spec
app.get('/api/openapi.json', (req, res) => {
  const openapiPath = join(__dirname, 'openapi.json');
  if (existsSync(openapiPath)) {
    res.sendFile(openapiPath);
  } else {
    res.status(404).json({ error: 'OpenAPI spec not found' });
  }
});

// Simple API info endpoint for agents
app.get('/api/info', (req, res) => {
  res.json({
    name: 'Llama Manager',
    version: '1.0.0',
    description: 'API for managing llama.cpp inference servers',
    openapi: '/api/openapi.json',
    mcp: '/mcp',
    endpoints: {
      health: 'GET /health',
      llamaHealth: 'GET /api/v1/health',
      status: 'GET /api/status',
      stats: 'GET /api/stats',
      analytics: 'GET /api/analytics',
      models: 'GET /api/models',
      loadModel: 'POST /api/models/load',
      unloadModel: 'POST /api/models/unload',
      startServer: 'POST /api/server/start',
      stopServer: 'POST /api/server/stop',
      settings: 'GET|POST /api/settings',
      presets: 'GET /api/presets',
      activatePreset: 'POST /api/presets/:id/activate',
      search: 'GET /api/search',
      download: 'POST /api/pull',
      processes: 'GET /api/processes',
      logs: 'GET /api/logs',
      requestLogs: 'GET|DELETE /api/request-logs',
      chatCompletions: 'POST /api/v1/chat/completions',
      completions: 'POST /api/v1/completions'
    }
  });
});

// Get server logs
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = logBuffer.slice(-limit);
  res.json({ logs });
});

// Get log filters
app.get('/api/logs/filters', (req, res) => {
  res.json({
    defaultFilters: DEFAULT_LOG_FILTERS,
    customFilters: config.logFilters || []
  });
});

// Add a log filter
app.post('/api/logs/filters', (req, res) => {
  const { pattern } = req.body;

  if (!pattern || typeof pattern !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid pattern' });
  }

  // Validate regex
  try {
    new RegExp(pattern);
  } catch (e) {
    return res.status(400).json({ error: `Invalid regex pattern: ${e.message}` });
  }

  if (!config.logFilters) {
    config.logFilters = [];
  }

  // Avoid duplicates
  if (config.logFilters.includes(pattern)) {
    return res.json({ success: true, message: 'Filter already exists', filters: config.logFilters });
  }

  config.logFilters.push(pattern);
  saveConfig(config);

  res.json({ success: true, filters: config.logFilters });
});

// Remove a log filter
app.delete('/api/logs/filters', (req, res) => {
  const { pattern } = req.body;

  if (!pattern) {
    return res.status(400).json({ error: 'Missing pattern' });
  }

  if (!config.logFilters) {
    config.logFilters = [];
  }

  const index = config.logFilters.indexOf(pattern);
  if (index === -1) {
    return res.status(404).json({ error: 'Filter not found' });
  }

  config.logFilters.splice(index, 1);
  saveConfig(config);

  res.json({ success: true, filters: config.logFilters });
});

// Get request logs
app.get('/api/request-logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const logs = requestLogBuffer.slice(-limit);
  res.json({ logs });
});

// Clear request logs
app.delete('/api/request-logs', (req, res) => {
  requestLogBuffer = [];
  res.json({ success: true });
});

// Get LLM conversation logs
app.get('/api/llm-logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const logs = llmLogBuffer.slice(-limit);
  res.json({ logs });
});

// Clear LLM conversation logs
app.delete('/api/llm-logs', (req, res) => {
  llmLogBuffer = [];
  res.json({ success: true });
});

// Helper to get container info for a process
async function getContainerInfo(pid) {
  return new Promise((resolve) => {
    // Read cgroup to find container ID
    exec(`cat /proc/${pid}/cgroup 2>/dev/null`, (err, stdout) => {
      if (err || !stdout) {
        resolve({ container: null, containerId: null });
        return;
      }

      // Look for libpod (podman) container ID in cgroup
      const match = stdout.match(/libpod-([a-f0-9]+)/);
      if (!match) {
        resolve({ container: null, containerId: null });
        return;
      }

      const containerId = match[1];

      // Get container name from podman
      exec(`podman ps --filter id=${containerId.slice(0, 12)} --format "{{.Names}}" 2>/dev/null`, (err2, stdout2) => {
        const containerName = stdout2?.trim() || null;
        resolve({
          container: containerName,
          containerId: containerId.slice(0, 12)
        });
      });
    });
  });
}

// Get llama-server processes
app.get('/api/processes', async (req, res) => {
  try {
    const processes = await new Promise((resolve) => {
      // Get all llama-server processes with detailed info
      // Filter to only actual llama-server binaries (not wrapper scripts)
      exec('ps aux | grep -E "llama-server|llama_server" | grep -v grep', async (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve([]);
          return;
        }

        const lines = stdout.trim().split('\n');
        const procs = [];

        for (const line of lines) {
          const parts = line.split(/\s+/);
          const user = parts[0];
          const pid = parseInt(parts[1]);
          const cpu = parseFloat(parts[2]);
          const mem = parseFloat(parts[3]);
          const vsz = parseInt(parts[4]) * 1024; // Convert KB to bytes
          const rss = parseInt(parts[5]) * 1024; // Convert KB to bytes
          const startTime = parts[8];
          const command = parts.slice(10).join(' ');

          // Skip wrapper processes (shell scripts, podman, distrobox)
          if (command.startsWith('/bin/sh') ||
              command.startsWith('podman ') ||
              command.includes('distrobox')) {
            continue;
          }

          // Parse port from command
          const portMatch = command.match(/--port\s+(\d+)/);
          const port = portMatch ? parseInt(portMatch[1]) : null;

          // Parse model/alias from command
          const aliasMatch = command.match(/--alias\s+(\S+)/);
          const hfMatch = command.match(/-hf\s+(\S+)/);
          const modelMatch = command.match(/-m\s+(\S+)/);
          const model = aliasMatch ? aliasMatch[1] : hfMatch ? hfMatch[1] : modelMatch ? modelMatch[1] : null;

          // Parse host
          const hostMatch = command.match(/--host\s+(\S+)/);
          const host = hostMatch ? hostMatch[1] : '0.0.0.0';

          // Get container info
          const containerInfo = await getContainerInfo(pid);

          procs.push({
            pid,
            user,
            cpu,
            mem,
            vsz,
            rss,
            startTime,
            port,
            host,
            model,
            container: containerInfo.container,
            containerId: containerInfo.containerId,
            command: command.length > 100 ? command.slice(0, 100) + '...' : command,
            isWorker: port !== parseInt(LLAMA_PORT)
          });
        }

        resolve(procs);
      });
    });

    res.json({ processes, llamaPort: parseInt(LLAMA_PORT) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Kill a specific process by PID
app.post('/api/processes/:pid/kill', async (req, res) => {
  const pid = parseInt(req.params.pid);
  if (isNaN(pid)) {
    return res.status(400).json({ error: 'Invalid PID' });
  }

  try {
    await new Promise((resolve, reject) => {
      exec(`kill -9 ${pid}`, (err) => {
        if (err) {
          reject(new Error(`Failed to kill process ${pid}`));
        } else {
          resolve();
        }
      });
    });

    addLog('manager', `Killed process ${pid}`);
    res.json({ success: true, message: `Process ${pid} killed` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// OpenAI API Wrapper (/api/v1/*)
// Proxies to llama.cpp server and tracks stats
// ============================================

// Get analytics data
app.get('/api/analytics', (req, res) => {
  const minutes = parseInt(req.query.minutes) || 5;
  const cutoff = Date.now() - (minutes * 60 * 1000);

  res.json({
    temperature: analyticsData.temperature.filter(p => p.timestamp > cutoff),
    power: analyticsData.power.filter(p => p.timestamp > cutoff),
    memory: analyticsData.memory.filter(p => p.timestamp > cutoff),
    tokens: analyticsData.tokens.filter(p => p.timestamp > cutoff),
    context: analyticsData.context.filter(p => p.timestamp > cutoff),
    queue: analyticsData.queue.filter(p => p.timestamp > cutoff),
    tokenStats: {
      totalPromptTokens: tokenStats.totalPromptTokens,
      totalCompletionTokens: tokenStats.totalCompletionTokens,
      totalRequests: tokenStats.totalRequests,
      averageTokensPerSecond: tokenStats.recentRequests.length > 0
        ? tokenStats.recentRequests.reduce((sum, r) => sum + r.tokensPerSecond, 0) / tokenStats.recentRequests.length
        : 0,
      // Per-model average tok/s from recent requests
      modelAvgTps: (() => {
        const byModel = {};
        for (const r of tokenStats.recentRequests) {
          if (!r.model || r.tokensPerSecond <= 0) continue;
          if (!byModel[r.model]) byModel[r.model] = { sum: 0, count: 0 };
          byModel[r.model].sum += r.tokensPerSecond;
          byModel[r.model].count++;
        }
        const result = {};
        for (const [m, v] of Object.entries(byModel)) {
          result[m] = Math.round(v.sum / v.count * 10) / 10;
        }
        return result;
      })()
    }
  });
});

// Get historical analytics data with downsampling
app.get('/api/analytics/history', (req, res) => {
  const range = req.query.range || '1h';
  const now = Date.now();

  // Determine time window and downsample interval
  const rangeConfig = {
    '1h':  { ms: 3600000,       step: 1 },      // every minute, 60 points
    '1d':  { ms: 86400000,      step: 1 },      // every minute, 1440 points
    '1w':  { ms: 604800000,     step: 5 },      // every 5 minutes, ~2016 points
    '1m':  { ms: 2592000000,    step: 15 },     // every 15 minutes, ~2880 points
    '1y':  { ms: 31536000000,   step: 60 }      // every 60 minutes, ~8760 points
  };

  const cfg = rangeConfig[range] || rangeConfig['1h'];
  const cutoff = now - cfg.ms;

  // Filter to time range
  const filtered = analyticsHistory.filter(p => p.ts > cutoff);

  // Downsample by averaging within step-minute buckets
  let points;
  if (cfg.step === 1) {
    points = filtered;
  } else {
    const bucketMs = cfg.step * 60000;
    const buckets = new Map();
    for (const p of filtered) {
      const bucketKey = Math.floor(p.ts / bucketMs) * bucketMs;
      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, []);
      }
      buckets.get(bucketKey).push(p);
    }

    points = [];
    for (const [ts, items] of buckets) {
      const avg = (key) => items.reduce((s, p) => s + (p[key] || 0), 0) / items.length;
      const sum = (key) => items.reduce((s, p) => s + (p[key] || 0), 0);
      const maxVal = (key) => Math.max(...items.map(p => p[key] || 0));

      // Merge status codes, model counts, and per-model tps across bucket
      const mergedSc = {};
      const mergedMc = {};
      const mergedMtps = {};
      const mtpsCounts = {};
      for (const item of items) {
        for (const [code, count] of Object.entries(item.sc || {})) {
          mergedSc[code] = (mergedSc[code] || 0) + count;
        }
        for (const [model, count] of Object.entries(item.mc || {})) {
          mergedMc[model] = (mergedMc[model] || 0) + count;
        }
        for (const [model, tps] of Object.entries(item.mtps || {})) {
          mergedMtps[model] = (mergedMtps[model] || 0) + tps;
          mtpsCounts[model] = (mtpsCounts[model] || 0) + 1;
        }
      }
      for (const model of Object.keys(mergedMtps)) {
        mergedMtps[model] = Math.round(mergedMtps[model] / mtpsCounts[model] * 10) / 10;
      }

      points.push({
        ts: ts + bucketMs / 2, // midpoint
        pwr: Math.round(avg('pwr') * 10) / 10,
        mv: Math.round(avg('mv') * 10) / 10,
        mg: Math.round(avg('mg') * 10) / 10,
        ms: Math.round(avg('ms') * 10) / 10,
        tg: Math.round(avg('tg') * 10) / 10,
        tc: Math.round(avg('tc') * 10) / 10,
        tps: Math.round(avg('tps') * 10) / 10,
        tpsMax: Math.round(maxVal('tpsMax') * 10) / 10,
        rT: sum('rT'),
        rOk: sum('rOk'),
        rErr: sum('rErr'),
        rRt: sum('rRt'),
        rRs: sum('rRs'),
        qA: Math.round(avg('qA') * 10) / 10,
        qP: Math.round(avg('qP') * 10) / 10,
        qMx: Math.round(maxVal('qMx')),
        qMxP: Math.round(maxVal('qMxP')),
        cxU: Math.round(avg('cxU')),
        cxT: Math.round(avg('cxT')),
        cxP: Math.round(avg('cxP') * 10) / 10,
        sc: mergedSc,
        mc: mergedMc,
        mtps: mergedMtps,
        tp: sum('tp'),
        tcc: sum('tcc')
      });
    }
    points.sort((a, b) => a.ts - b.ts);
  }

  // Compute summary
  const totalRequests = points.reduce((s, p) => s + (p.rT || 0), 0);
  const totalErrors = points.reduce((s, p) => s + (p.rErr || 0), 0);
  const totalRetries = points.reduce((s, p) => s + (p.rRt || 0), 0);
  const totalRestarts = points.reduce((s, p) => s + (p.rRs || 0), 0);
  const tpsPoints = points.filter(p => p.tps > 0);
  const avgTps = tpsPoints.length > 0 ? tpsPoints.reduce((s, p) => s + p.tps, 0) / tpsPoints.length : 0;
  const allStatusCodes = {};
  const allModelCounts = {};
  const allModelTps = {};
  const modelTpsCounts = {};
  for (const p of points) {
    for (const [code, count] of Object.entries(p.sc || {})) {
      allStatusCodes[code] = (allStatusCodes[code] || 0) + count;
    }
    for (const [model, count] of Object.entries(p.mc || {})) {
      allModelCounts[model] = (allModelCounts[model] || 0) + count;
    }
    for (const [model, tps] of Object.entries(p.mtps || {})) {
      allModelTps[model] = (allModelTps[model] || 0) + tps;
      modelTpsCounts[model] = (modelTpsCounts[model] || 0) + 1;
    }
  }
  const modelAvgTps = {};
  for (const model of Object.keys(allModelTps)) {
    modelAvgTps[model] = Math.round(allModelTps[model] / modelTpsCounts[model] * 10) / 10;
  }

  res.json({
    points,
    summary: {
      totalRequests,
      totalErrors,
      totalRetries,
      totalRestarts,
      avgTps: Math.round(avgTps * 10) / 10,
      statusCodes: allStatusCodes,
      modelCounts: allModelCounts,
      modelAvgTps
    }
  });
});

// Get crash event history
app.get('/api/analytics/crashes', (req, res) => {
  const range = req.query.range || '1w';
  const now = Date.now();
  const rangeMs = { '1h': 3600000, '1d': 86400000, '1w': 604800000, '1m': 2592000000, '1y': 31536000000 };
  const cutoff = now - (rangeMs[range] || rangeMs['1w']);
  const events = crashHistory.filter(e => e.ts > cutoff);

  // Aggregate crashes by model
  const byModel = {};
  for (const e of events) {
    const models = e.activeModels?.length ? e.activeModels : [e.model || e.preset || 'unknown'];
    for (const m of models) {
      byModel[m] = (byModel[m] || 0) + 1;
    }
  }

  res.json({
    events,
    summary: {
      total: events.length,
      byModel,
      byTrigger: {
        exit_handler: events.filter(e => e.trigger === 'exit_handler').length,
        fetch_retry: events.filter(e => e.trigger === 'fetch_retry').length
      }
    }
  });
});

// OpenAI-compatible models endpoint - returns models from llama.cpp that can be loaded
app.get('/api/v1/models', async (req, res) => {
  try {
    // Get models from llama.cpp - these are the models that can actually be loaded
    const response = await fetch(`http://localhost:${LLAMA_PORT}/models`);
    if (!response.ok) {
      throw new Error(`llama.cpp returned ${response.status}`);
    }
    const llamaModels = await response.json();

    // Get aliases from config
    const aliases = config.modelAliases || {};

    // Format with our extra info
    const data = {
      object: 'list',
      data: (llamaModels.data || []).map(m => {
        // Extract runtime context size from loaded model's args
        const args = m.status?.args || [];
        const ctxIndex = args.indexOf('--ctx-size');
        const n_ctx = ctxIndex >= 0 ? parseInt(args[ctxIndex + 1]) : null;

        return {
          id: m.id,
          object: 'model',
          created: m.created || Math.floor(Date.now() / 1000),
          owned_by: m.owned_by || 'llamacpp',
          // Model metadata from GGUF (includes n_ctx_train, n_params, etc.)
          meta: m.meta || null,
          // Runtime context size (configured via --ctx-size)
          n_ctx: n_ctx || config.contextSize || null,
          // Include extra info for UI
          displayName: m.id,
          status: m.status?.value || 'unknown',
          alias: aliases[m.id] || null
        };
      })
    };
    res.json(data);
  } catch (error) {
    console.error('[v1/models] Error fetching from llama.cpp:', error.message);
    // Fallback to empty list if llama.cpp is not available
    res.json({ object: 'list', data: [] });
  }
});

// Sanitize messages for llama.cpp chat templates that reject both content+thinking on tool_calls
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = 0;
  const result = messages.map(msg => {
    if (msg.role === 'assistant' && msg.tool_calls) {
      // Remove content key entirely if thinking is also present - even empty strings
      // The Jinja template checks key existence, not just truthiness
      if ('content' in msg && 'thinking' in msg) {
        changed++;
        const { content, thinking, ...rest } = msg;
        const merged = (thinking || '') + (content ? '\n' + content : '');
        return { ...rest, thinking: merged || '' };
      }
    }
    return msg;
  });
  console.log(`[sanitize] Processed ${messages.length} messages, fixed ${changed} tool_call messages`);
  return result;
}

// Check if an error is a template error that sanitization can fix
function isTemplateSanitizable(errorText) {
  return typeof errorText === 'string' &&
    errorText.includes('Cannot pass both content and thinking');
}

// Detect transient proxy/connection errors from llama.cpp (500 with connection-related messages)
function isProxyConnectionError(status, text) {
  if (status !== 500 || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return lower.includes('could not establish connection') ||
    lower.includes('connection refused') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('socket hang up');
}

// Wait for llama.cpp server to become healthy again (e.g. after OOM model reload)
async function waitForServerReady({ maxWait = 30000, pollInterval = 2000, label = 'proxy' } = {}) {
  const deadline = Date.now() + maxWait;
  console.log(`[${label}] Waiting up to ${maxWait / 1000}s for llama server to become ready...`);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${LLAMA_PORT}/health`);
      if (res.ok) {
        console.log(`[${label}] Llama server is ready`);
        return true;
      }
    } catch { /* server not up yet */ }
    await new Promise(r => setTimeout(r, pollInterval));
  }
  console.error(`[${label}] Llama server did not become ready within ${maxWait / 1000}s`);
  return false;
}

// Retry fetch with backoff for transient connection failures (e.g. model switching in router mode)
// Also retries on proxy connection errors (500) with server health polling
// Returns { response, retries, retryErrors } so callers can log retry info
async function fetchWithRetry(url, options, { retries = 5, baseDelay = 1000, label = 'proxy', model, signal } = {}) {
  // Wake from idle shutdown if needed
  if (idleShutdown && (!llamaProcess || llamaProcess.killed)) {
    const msg = 'Waking llama-server from idle shutdown for incoming request...';
    console.log(`[idle] ${msg}`);
    addLog('system', msg);
    idleShutdown = false;
    await restartLlamaServer();
  }

  // Acquire queue slot — blocks if at concurrency limit
  const queueStart = Date.now();
  const queueId = await llamaQueue.acquire({ model: model || label, endpoint: label });
  const queueWait = Date.now() - queueStart;
  if (queueWait > 100) {
    console.log(`[${label}] Queued for ${queueWait}ms (active: ${llamaQueue.active}, pending: ${llamaQueue.pending})`);
  }
  try {
  const result = await _fetchWithRetryInner(url, options, { retries, baseDelay, label, model, signal });
  result.queueWait = queueWait;
  return result;
  } finally {
    llamaQueue.release(queueId);
  }
}

async function _fetchWithRetryInner(url, options, { retries = 5, baseDelay = 1000, label = 'proxy', model, signal } = {}) {
  const retryErrors = [];
  let hasRestarted = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Check if request was aborted before each attempt
      if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
      const response = await fetch(url, { ...options, dispatcher: llamaDispatcher, signal });

      // Check for proxy connection errors (server may be reloading after OOM)
      if (response.status === 500 && attempt < retries) {
        // Clone before reading so we can return the original if it's not a proxy error
        const cloned = response.clone();
        const text = await cloned.text();
        if (isProxyConnectionError(500, text)) {
          const msg = text.slice(0, 300);
          console.log(`[${label}] Proxy connection error (attempt ${attempt + 1}/${retries + 1}): ${msg}`);
          addLog(label, `Proxy connection error, waiting for server to recover (attempt ${attempt + 1}/${retries + 1})`);
          retryErrors.push(msg);
          requestStatsAccum.retries++;
          // Track the upstream 500 in status codes so it appears in error code breakdown
          requestStatsAccum.statusCodes['500'] = (requestStatsAccum.statusCodes['500'] || 0) + 1;
          // After 2 consecutive proxy errors, restart the server
          if (attempt >= 1 && !hasRestarted) {
            console.log(`[${label}] Multiple proxy errors, restarting llama server...`);
            addLog(label, 'Multiple proxy errors detected, restarting llama server');
            hasRestarted = true;
            requestStatsAccum.restarts++;
            recordCrashEvent({ exitCode: 500, trigger: 'fetch_retry', model });
            await restartLlamaServer();
          } else {
            await waitForServerReady({ label });
          }
          continue;
        }
        // Not a proxy error — return the original unconsumed response
        return { response, retries: attempt, retryErrors, restarted: hasRestarted };
      }

      return { response, retries: attempt, retryErrors, restarted: hasRestarted };
    } catch (err) {
      retryErrors.push(err.message);
      requestStatsAccum.retries++;
      // Node's fetch wraps errors: err.code may be undefined, real code is in err.cause.code
      const realCode = err.code || err.cause?.code || '';
      const isConnectionError = realCode === 'ECONNREFUSED' || realCode === 'ECONNRESET' ||
        err.message === 'fetch failed' || err.message?.includes('ECONNREFUSED') || err.message?.includes('ECONNRESET');
      // Track connection errors in status codes
      const errCodeLabel = isConnectionError ? (realCode || 'CONNFAIL') : '500';
      requestStatsAccum.statusCodes[errCodeLabel] = (requestStatsAccum.statusCodes[errCodeLabel] || 0) + 1;
      if (attempt === retries) {
        err.retries = attempt;
        err.retryErrors = retryErrors;
        throw err;
      }
      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`[${label}] Connection failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms: ${err.message} (code: ${realCode || 'none'})`);
      // If connection failed, server may have crashed
      if (isConnectionError) {
        // After 2 consecutive connection failures, restart the server
        if (attempt >= 1 && !hasRestarted) {
          console.log(`[${label}] Server appears crashed (${realCode || err.message}), restarting llama server...`);
          addLog(label, `Server appears crashed (${realCode || err.message}), restarting llama server`);
          hasRestarted = true;
          requestStatsAccum.restarts++;
          recordCrashEvent({ exitCode: realCode || 'CONNFAIL', trigger: 'fetch_retry', model });
          await restartLlamaServer();
        } else {
          await waitForServerReady({ label });
        }
      } else {
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
}

// Detect model load failure and unload other models to make room, then retry
function isModelLoadFailure(status, text) {
  return status === 500 && typeof text === 'string' && text.includes('failed to load');
}

async function unloadOtherModels(keepModel) {
  try {
    const modelsRes = await fetch(`http://localhost:${LLAMA_PORT}/models`);
    if (!modelsRes.ok) return false;
    const modelsData = await modelsRes.json();
    const loaded = (modelsData.data || []).filter(m => m.status?.value === 'loaded' && m.id !== keepModel);
    if (loaded.length === 0) return false;

    console.log(`[model-switch] Unloading ${loaded.length} model(s) to make room for ${keepModel}`);
    for (const model of loaded) {
      console.log(`[model-switch] Unloading: ${model.id}`);
      addLog('models', `Auto-unloading ${model.id} to make room for ${keepModel}`);
      const unloadRes = await fetch(`http://localhost:${LLAMA_PORT}/models/unload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model.id })
      });
      if (!unloadRes.ok) {
        const err = await unloadRes.text();
        console.error(`[model-switch] Failed to unload ${model.id}: ${err}`);
      }
    }
    return true;
  } catch (err) {
    console.error(`[model-switch] Error during unload: ${err.message}`);
    return false;
  }
}

// Inject reasoning_effort into chat_template_kwargs if configured
function injectReasoningEffort(body) {
  // 1. Top-level reasoning_effort (OpenAI format) → move to chat_template_kwargs
  if (body.reasoning_effort) {
    const effort = body.reasoning_effort;
    const result = { ...body };
    delete result.reasoning_effort;
    result.chat_template_kwargs = { ...result.chat_template_kwargs, reasoning_effort: effort };
    return result;
  }

  // 2. Already set in chat_template_kwargs → don't touch
  if (body.chat_template_kwargs?.reasoning_effort) {
    return body;
  }

  // 3. Look up per-model pattern match, fall back to global default
  const model = body.model || '';
  const perModel = config.modelReasoningEffort || {};
  let effort = null;

  for (const [pattern, value] of Object.entries(perModel)) {
    // Support glob-style wildcards: "gpt-oss*" matches "gpt-oss-2025"
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    if (regex.test(model)) {
      effort = value;
      break;
    }
  }

  if (!effort) {
    effort = config.defaultReasoningEffort || null;
  }

  if (effort) {
    return { ...body, chat_template_kwargs: { ...body.chat_template_kwargs, reasoning_effort: effort } };
  }

  return body;
}

// OpenAI-compatible chat completions (streaming and non-streaming)
app.post('/api/v1/chat/completions', async (req, res) => {
  const startTime = Date.now();
  const isStreaming = req.body.stream === true;
  const requestedModel = req.body.model || 'default';

  console.log(`[chat/completions] Request for model: ${requestedModel}`);

  // Normalize messages: accept stringified JSON arrays for compatibility
  if (typeof req.body.messages === 'string') {
    try {
      req.body.messages = JSON.parse(req.body.messages);
    } catch {
      return res.status(400).json({ error: { message: 'messages must be a JSON array, got unparseable string', type: 'invalid_request_error' } });
    }
  }
  if (!Array.isArray(req.body.messages)) {
    return res.status(400).json({ error: { message: 'messages must be an array', type: 'invalid_request_error' } });
  }

  // Inject reasoning_effort if configured (shallow copy preserves req.body for logs)
  const proxyBody = injectReasoningEffort(req.body);

  // Resolve backend routing (local vs remote)
  const routing = resolveBackend(requestedModel, 'chat/completions');

  const activeReqId = startActiveRequest({ model: requestedModel, endpoint: 'chat/completions', messages: req.body.messages, backend: routing.remote ? routing.backend.id : 'local' });
  // Ensure active request is cleaned up on any exit path
  res.on('finish', () => {
    if (activeRequests.has(activeReqId)) {
      endActiveRequest(activeReqId, { status: res.statusCode >= 400 ? 'error' : 'complete' });
    }
  });

  // ===== REMOTE BACKEND PATH =====
  if (routing.remote) {
    req._backend = routing.backend.id;
    const remoteBody = { ...proxyBody, model: routing.targetModel };
    console.log(`[chat/completions] Routing to remote backend: ${routing.backend.name} (model: ${routing.targetModel})`);
    addLog('backends', `Routing chat/completions to ${routing.backend.name} (queue: local=${llamaQueue.pending} pending)`);

    try {
      const { response, backend } = await fetchRemoteBackend(routing.backend, routing.targetUrl, {
        method: 'POST',
        headers: { ...routing.headers },
        body: JSON.stringify(remoteBody)
      }, { label: 'chat/completions', model: routing.targetModel });

      if (!response.ok) {
        const error = await response.text();
        addLlmLog({
          endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
          status: response.status, duration: Date.now() - startTime,
          promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
          messages: req.body.messages || null, prompt: null, response: null, error,
          backend: backend.id, requestBody: req.body
        });
        endActiveRequest(activeReqId, { status: 'error' });
        return res.status(response.status).send(error);
      }

      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let completionTokens = 0;
        let promptTokens = 0;
        let model = routing.targetModel;
        let responseText = '';

        const processStream = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value);
              res.write(chunk);
              const lines = chunk.split('\n');
              for (const line of lines) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  try {
                    const data = JSON.parse(line.slice(6));
                    const delta = data.choices?.[0]?.delta;
                    if (delta) {
                      const text = delta.content || delta.reasoning_content || delta.reasoning || '';
                      if (text) { completionTokens++; responseText += text; updateActiveRequest(activeReqId, text); }
                    }
                    if (data.usage) { promptTokens = data.usage.prompt_tokens || promptTokens; completionTokens = data.usage.completion_tokens || completionTokens; }
                    if (data.model) model = data.model;
                  } catch { /* skip */ }
                }
              }
            }
            res.end();
            const duration = Date.now() - startTime;
            const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
            recordTokenStats({ promptTokens, completionTokens, tokensPerSecond, model, duration, backend: backend.name });
            updateBackendTokenStats(backend.id, promptTokens, completionTokens, duration, backend);
            addLlmLog({
              endpoint: 'chat/completions', model, stream: true, status: 200, duration, promptTokens, completionTokens,
              tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
              messages: req.body.messages || null, prompt: null, response: responseText, error: null,
              backend: backend.id, requestBody: req.body
            });
            endActiveRequest(activeReqId, { status: 'complete', tokens: completionTokens, responseText });
          } catch (e) {
            const duration = Date.now() - startTime;
            addLlmLog({
              endpoint: 'chat/completions', model, stream: true, status: 500, duration, promptTokens, completionTokens, tokensPerSecond: 0,
              messages: req.body.messages || null, prompt: null, response: responseText || null, error: `Stream error: ${e.message}`,
              backend: backend.id, requestBody: req.body
            });
            endActiveRequest(activeReqId, { status: 'error' });
            res.end();
          }
        };
        processStream();
      } else {
        const data = await response.json();
        const duration = Date.now() - startTime;
        const usage = data.usage || {};
        const promptTokens = usage.prompt_tokens || 0;
        const completionTokens = usage.completion_tokens || 0;
        const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
        recordTokenStats({ promptTokens, completionTokens, tokensPerSecond, model: data.model || routing.targetModel, duration, backend: backend.name });
        updateBackendTokenStats(backend.id, promptTokens, completionTokens, duration, backend);
        addLlmLog({
          endpoint: 'chat/completions', model: data.model || routing.targetModel, stream: false, status: 200, duration, promptTokens, completionTokens,
          tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
          messages: req.body.messages || null, prompt: null,
          response: data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || data.choices?.[0]?.message?.reasoning || null, error: null,
          backend: backend.id, requestBody: req.body
        });
        data._llama_manager = { duration, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, backend: backend.id };
        endActiveRequest(activeReqId, { status: 'complete', tokens: completionTokens, responseText: data.choices?.[0]?.message?.content || '' });
        res.json(data);
      }
    } catch (error) {
      endActiveRequest(activeReqId, { status: 'error' });
      addLlmLog({
        endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
        status: 502, duration: Date.now() - startTime,
        promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
        messages: req.body.messages || null, prompt: null, response: null, error: error.message,
        backend: routing.backend.id, requestBody: req.body
      });
      res.status(502).json({ error: `Failed to reach remote backend ${routing.backend.name}`, details: error.message });
    }
    return;
  }

  // ===== LOCAL BACKEND PATH (existing logic) =====
  let retryInfo = { retries: 0, retryErrors: [], restarted: false };
  function logLlm(entry) {
    addLlmLog({ ...entry, retries: retryInfo.retries, retryErrors: retryInfo.retryErrors, backend: 'local', requestBody: entry.requestBody || req.body });
  }
  let totalQueueWait = 0;
  async function doFetch(body) {
    const result = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, { label: 'chat/completions', model: body.model, signal: getActiveRequestSignal(activeReqId) });
    retryInfo = { retries: result.retries, retryErrors: result.retryErrors, restarted: result.restarted };
    totalQueueWait += result.queueWait || 0;
    req._retryInfo = retryInfo;
    return result.response;
  }

  try {
    let response = await doFetch(proxyBody);
    let activeBody = proxyBody;

    // If model failed to load (e.g. too large), unload others and retry
    if (!response.ok) {
      const errorText = await response.text();
      if (isModelLoadFailure(response.status, errorText)) {
        console.log(`[chat/completions] Model load failure for ${requestedModel}, attempting to free memory`);
        const unloaded = await unloadOtherModels(requestedModel);
        if (unloaded) {
          response = await doFetch(proxyBody);
          if (!response.ok) {
            const retryError = await response.text();
            // Check for template error on retry
            if (isTemplateSanitizable(retryError) && proxyBody.messages) {
              const sanitizedBody = { ...proxyBody, messages: sanitizeMessages(proxyBody.messages) };
              activeBody = sanitizedBody;
              response = await doFetch(sanitizedBody);
            } else {
              console.error(`[chat/completions] Still failing after unload for ${requestedModel}: ${retryError}`);
              addLog('chat', `Chat completion failed for model ${requestedModel}: ${retryError}`);
              logLlm({
                endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
                status: response.status, duration: Date.now() - startTime,
                promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
                messages: req.body.messages || null, prompt: null, response: null, error: retryError
              });
              return res.status(response.status).send(retryError);
            }
          }
        } else {
          // Couldn't unload, return original error
          console.error(`[chat/completions] Error ${response.status} for model ${requestedModel}: ${errorText}`);
          addLog('chat', `Chat completion failed for model ${requestedModel}: ${errorText}`);
          logLlm({
            endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
            status: response.status, duration: Date.now() - startTime,
            promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
            messages: req.body.messages || null, prompt: null, response: null, error: errorText
          });
          return res.status(response.status).send(errorText);
        }
      } else if (isTemplateSanitizable(errorText) && proxyBody.messages) {
        // Template rejects the message format, retry with sanitized messages
        console.log(`[chat/completions] Template error, retrying with sanitized messages`);
        const sanitizedBody = { ...proxyBody, messages: sanitizeMessages(proxyBody.messages) };
        activeBody = sanitizedBody;
        response = await doFetch(sanitizedBody);
      } else {
        console.error(`[chat/completions] Error ${response.status} for model ${requestedModel}: ${errorText}`);
        addLog('chat', `Chat completion failed for model ${requestedModel}: ${errorText}`);
        logLlm({
          endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
          status: response.status, duration: Date.now() - startTime,
          promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
          messages: req.body.messages || null, prompt: null, response: null, error: errorText
        });
        return res.status(response.status).send(errorText);
      }
    }

    if (!response.ok) {
      const error = await response.text();
      console.error(`[chat/completions] Error ${response.status} for model ${requestedModel}: ${error}`);
      addLog('chat', `Chat completion failed for model ${requestedModel}: ${error}`);
      logLlm({
        endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
        status: response.status, duration: Date.now() - startTime,
        promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
        messages: req.body.messages || null, prompt: null, response: null, error
      });
      return res.status(response.status).send(error);
    }

    if (isStreaming) {
      // Stream the response and track tokens
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let completionTokens = 0;
      let promptTokens = 0;
      let model = req.body.model || 'unknown';
      let responseText = '';
      let serverTimings = null;

      const processStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            res.write(chunk);

            // Parse SSE data to count tokens
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const data = JSON.parse(line.slice(6));
                  const delta = data.choices?.[0]?.delta;
                  if (delta) {
                    const text = delta.content || delta.reasoning_content || delta.reasoning || '';
                    if (text) {
                      completionTokens++;
                      responseText += text;
                      updateActiveRequest(activeReqId, text);
                    }
                  }
                  if (data.usage) {
                    promptTokens = data.usage.prompt_tokens || promptTokens;
                    completionTokens = data.usage.completion_tokens || completionTokens;
                  }
                  if (data.timings) {
                    serverTimings = data.timings;
                  }
                  if (data.model) {
                    model = data.model;
                  }
                } catch (e) {
                  // Skip parse errors
                }
              }
            }
          }
          res.end();

          // Record stats after stream completes
          // Prefer server-reported timings (accurate inference time) over wall-clock (includes queue wait)
          const wallDuration = Date.now() - startTime;
          const inferDuration = serverTimings
            ? (serverTimings.prompt_ms || 0) + (serverTimings.predicted_ms || 0)
            : wallDuration - totalQueueWait;
          const tokensPerSecond = serverTimings?.predicted_per_second
            || (inferDuration > 0 ? (completionTokens / (inferDuration / 1000)) : 0);
          if (serverTimings) {
            promptTokens = serverTimings.prompt_n || promptTokens;
            completionTokens = serverTimings.predicted_n || completionTokens;
          }
          recordTokenStats({
            promptTokens,
            completionTokens,
            tokensPerSecond,
            model,
            duration: inferDuration
          });
          logLlm({
            endpoint: 'chat/completions', model, stream: true,
            status: 200, duration: wallDuration, promptTokens, completionTokens,
            tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
            messages: req.body.messages || null, prompt: null,
            response: responseText, error: null
          });
          endActiveRequest(activeReqId, { status: 'complete', tokens: completionTokens, responseText });
        } catch (e) {
          console.error('[proxy] Stream error:', e);
          const duration = Date.now() - startTime;
          logLlm({
            endpoint: 'chat/completions', model, stream: true,
            status: 500, duration, promptTokens, completionTokens,
            tokensPerSecond: 0,
            messages: req.body.messages || null, prompt: null,
            response: responseText || null, error: `Stream error: ${e.message}`
          });
          endActiveRequest(activeReqId, { status: 'error' });
          res.end();
        }
      };

      processStream();
    } else {
      // Non-streaming response
      const data = await response.json();

      // Extract token stats — prefer server-reported timings (excludes queue wait)
      const wallDuration = Date.now() - startTime;
      const usage = data.usage || {};
      const timings = data.timings || {};
      const promptTokens = timings.prompt_n || usage.prompt_tokens || 0;
      const completionTokens = timings.predicted_n || usage.completion_tokens || 0;
      const inferDuration = timings.predicted_ms
        ? (timings.prompt_ms || 0) + timings.predicted_ms
        : wallDuration - totalQueueWait;
      const tokensPerSecond = timings.predicted_per_second
        || (inferDuration > 0 ? (completionTokens / (inferDuration / 1000)) : 0);

      recordTokenStats({
        promptTokens,
        completionTokens,
        tokensPerSecond,
        model: data.model || req.body.model || 'unknown',
        duration: inferDuration
      });

      logLlm({
        endpoint: 'chat/completions', model: data.model || req.body.model || 'unknown',
        stream: false, status: 200, duration: wallDuration, promptTokens, completionTokens,
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
        messages: req.body.messages || null, prompt: null,
        response: data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || data.choices?.[0]?.message?.reasoning || null, error: null
      });

      // Add our tracking info to response
      data._llama_manager = {
        duration: wallDuration,
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
        backend: 'local'
      };

      endActiveRequest(activeReqId, { status: 'complete', tokens: completionTokens, responseText: data.choices?.[0]?.message?.content || '' });
      res.json(data);
    }
  } catch (error) {
    endActiveRequest(activeReqId, { status: 'error' });
    if (error.retryErrors) retryInfo = { retries: error.retries, retryErrors: error.retryErrors };
    logLlm({
      endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
      status: 502, duration: Date.now() - startTime,
      promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
      messages: req.body.messages || null, prompt: null,
      response: null, error: error.message
    });
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
});

// OpenAI-compatible completions (legacy endpoint)
app.post('/api/v1/completions', async (req, res) => {
  const startTime = Date.now();
  const requestedModel = req.body.model || 'unknown';
  const isStreaming = req.body.stream === true;

  // Route to remote backend if applicable
  const routing = resolveBackend(requestedModel, 'completions');
  if (routing.remote) {
    req._backend = routing.backend.id;
    const remoteBody = { ...req.body, model: routing.targetModel };
    try {
      const { response, backend } = await fetchRemoteBackend(routing.backend, routing.targetUrl, {
        method: 'POST', headers: { ...routing.headers }, body: JSON.stringify(remoteBody)
      }, { label: 'completions', model: routing.targetModel });

      if (!response.ok) {
        const error = await response.text();
        addLlmLog({ endpoint: 'completions', model: requestedModel, stream: isStreaming, status: response.status, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: null, prompt: req.body.prompt || null, response: null, error, backend: backend.id, requestBody: req.body });
        return res.status(response.status).send(error);
      }
      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let tokens = 0, responseText = '';
        const processStream = async () => {
          try {
            while (true) { const { done, value } = await reader.read(); if (done) break; const chunk = decoder.decode(value); res.write(chunk); const lines = chunk.split('\n'); for (const line of lines) { if (line.startsWith('data: ') && line !== 'data: [DONE]') { try { const data = JSON.parse(line.slice(6)); if (data.choices?.[0]?.text) responseText += data.choices[0].text; } catch { /* skip */ } } } tokens++; }
            res.end();
            const duration = Date.now() - startTime;
            const tokensPerSecond = duration > 0 ? tokens / (duration / 1000) : 0;
            recordTokenStats({ promptTokens: 0, completionTokens: tokens, tokensPerSecond, model: requestedModel, duration, backend: backend.name });
            updateBackendTokenStats(backend.id, 0, tokens, duration, backend);
            addLlmLog({ endpoint: 'completions', model: requestedModel, stream: true, status: 200, duration, promptTokens: 0, completionTokens: tokens, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, messages: null, prompt: req.body.prompt || null, response: responseText, error: null, backend: backend.id, requestBody: req.body });
          } catch { res.end(); }
        };
        processStream();
      } else {
        const data = await response.json();
        const duration = Date.now() - startTime;
        const usage = data.usage || {};
        const promptTokens = usage.prompt_tokens || 0;
        const completionTokens = usage.completion_tokens || 0;
        const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
        recordTokenStats({ promptTokens, completionTokens, tokensPerSecond, model: data.model || requestedModel, duration, backend: backend.name });
        updateBackendTokenStats(backend.id, promptTokens, completionTokens, duration, backend);
        addLlmLog({ endpoint: 'completions', model: data.model || requestedModel, stream: false, status: 200, duration, promptTokens, completionTokens, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, messages: null, prompt: req.body.prompt || null, response: data.choices?.[0]?.text || null, error: null, backend: backend.id, requestBody: req.body });
        res.json(data);
      }
    } catch (error) {
      addLlmLog({ endpoint: 'completions', model: requestedModel, stream: isStreaming, status: 502, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: null, prompt: req.body.prompt || null, response: null, error: error.message, backend: routing.backend.id, requestBody: req.body });
      res.status(502).json({ error: `Failed to reach remote backend ${routing.backend.name}`, details: error.message });
    }
    return;
  }

  try {
    const { response, retries: fetchRetries, retryErrors: fetchRetryErrors, restarted: fetchRestarted, queueWait: completionsQueueWait } = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    }, { label: 'completions', model: req.body.model });
    req._retryInfo = { retries: fetchRetries, retryErrors: fetchRetryErrors, restarted: fetchRestarted };
    const retryFields = { retries: fetchRetries, retryErrors: fetchRetryErrors, requestBody: req.body };

    if (!response.ok) {
      const error = await response.text();
      addLlmLog({
        endpoint: 'completions', model: requestedModel, stream: isStreaming,
        status: response.status, duration: Date.now() - startTime,
        promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
        messages: null, prompt: req.body.prompt || null, response: null, error,
        ...retryFields
      });
      return res.status(response.status).send(error);
    }

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let tokens = 0;
      let responseText = '';

      const processStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            res.write(chunk);

            let completionsServerTimings = null;
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.choices?.[0]?.text) {
                    responseText += data.choices[0].text;
                  }
                  if (data.timings) completionsServerTimings = data.timings;
                } catch (e) { /* skip */ }
              }
            }
            tokens++;
          }
          res.end();

          const wallDuration = Date.now() - startTime;
          const inferDuration = completionsServerTimings
            ? (completionsServerTimings.prompt_ms || 0) + (completionsServerTimings.predicted_ms || 0)
            : wallDuration - (completionsQueueWait || 0);
          const tokensPerSecond = completionsServerTimings?.predicted_per_second
            || (inferDuration > 0 ? (tokens / (inferDuration / 1000)) : 0);
          recordTokenStats({
            promptTokens: 0,
            completionTokens: completionsServerTimings?.predicted_n || tokens,
            tokensPerSecond,
            model: requestedModel,
            duration: inferDuration
          });
          addLlmLog({
            endpoint: 'completions', model: requestedModel, stream: true,
            status: 200, duration: wallDuration, promptTokens: 0, completionTokens: tokens,
            tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
            messages: null, prompt: req.body.prompt || null,
            response: responseText, error: null, ...retryFields
          });
        } catch (e) {
          res.end();
        }
      };

      processStream();
    } else {
      const data = await response.json();
      const wallDuration = Date.now() - startTime;
      const usage = data.usage || {};
      const timings = data.timings || {};
      const promptTokens = timings.prompt_n || usage.prompt_tokens || 0;
      const completionTokens = timings.predicted_n || usage.completion_tokens || 0;
      const inferDuration = timings.predicted_ms
        ? (timings.prompt_ms || 0) + timings.predicted_ms
        : wallDuration - (completionsQueueWait || 0);
      const tokensPerSecond = timings.predicted_per_second
        || (inferDuration > 0 ? (completionTokens / (inferDuration / 1000)) : 0);

      recordTokenStats({
        promptTokens,
        completionTokens,
        tokensPerSecond,
        model: data.model || requestedModel,
        duration: inferDuration
      });

      addLlmLog({
        endpoint: 'completions', model: data.model || requestedModel,
        stream: false, status: 200, duration: wallDuration, promptTokens, completionTokens,
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
        messages: null, prompt: req.body.prompt || null,
        response: data.choices?.[0]?.text || null, error: null, ...retryFields
      });

      res.json(data);
    }
  } catch (error) {
    addLlmLog({
      endpoint: 'completions', model: requestedModel, stream: isStreaming,
      status: 502, duration: Date.now() - startTime,
      promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
      messages: null, prompt: req.body.prompt || null,
      response: null, error: error.message, requestBody: req.body,
      retries: error.retries || 0, retryErrors: error.retryErrors || []
    });
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
});

// OpenAI-compatible embeddings endpoint
app.post('/api/v1/embeddings', async (req, res) => {
  const requestedModel = req.body.model || 'default';

  // Route to remote backend if applicable
  const routing = resolveBackend(requestedModel, 'embeddings');
  if (routing.remote) {
    req._backend = routing.backend.id;
    const remoteBody = { ...req.body, model: routing.targetModel };
    try {
      const { response, backend } = await fetchRemoteBackend(routing.backend, routing.targetUrl, {
        method: 'POST', headers: { ...routing.headers }, body: JSON.stringify(remoteBody)
      }, { label: 'embeddings', model: routing.targetModel });
      if (!response.ok) {
        const error = await response.text();
        return res.status(response.status).send(error);
      }
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(502).json({ error: `Failed to reach remote backend ${routing.backend.name}`, details: error.message });
    }
    return;
  }

  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).send(error);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
});

// OpenAI-compatible single model retrieval
app.get('/api/v1/models/:model', async (req, res) => {
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/models`);
    if (!response.ok) {
      throw new Error(`llama.cpp returned ${response.status}`);
    }
    const llamaModels = await response.json();
    const aliases = config.modelAliases || {};
    const modelId = req.params.model;

    const m = (llamaModels.data || []).find(m => m.id === modelId);
    if (!m) {
      return res.status(404).json({ error: { message: `Model '${modelId}' not found`, type: 'invalid_request_error', code: 'model_not_found' } });
    }

    const args = m.status?.args || [];
    const ctxIndex = args.indexOf('--ctx-size');
    const n_ctx = ctxIndex >= 0 ? parseInt(args[ctxIndex + 1]) : null;

    res.json({
      id: m.id,
      object: 'model',
      created: m.created || Math.floor(Date.now() / 1000),
      owned_by: m.owned_by || 'llamacpp',
      meta: m.meta || null,
      n_ctx: n_ctx || config.contextSize || null,
      displayName: m.id,
      status: m.status?.value || 'unknown',
      alias: aliases[m.id] || null
    });
  } catch (error) {
    console.error('[v1/models/:model] Error:', error.message);
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
});

// OpenAI Responses API (proxied to llama.cpp)
app.post('/api/v1/responses', async (req, res) => {
  const startTime = Date.now();
  const isStreaming = req.body.stream === true;
  const requestedModel = req.body.model || 'default';

  console.log(`[responses] Request for model: ${requestedModel}`);

  // Inject reasoning_effort if configured
  const proxyBody = injectReasoningEffort(req.body);

  // Route to remote backend if applicable
  const routing = resolveBackend(requestedModel, 'responses');
  if (routing.remote) {
    req._backend = routing.backend.id;
    const remoteBody = { ...proxyBody, model: routing.targetModel };
    try {
      const { response, backend } = await fetchRemoteBackend(routing.backend, routing.targetUrl, {
        method: 'POST', headers: { ...routing.headers }, body: JSON.stringify(remoteBody)
      }, { label: 'responses', model: routing.targetModel });
      if (!response.ok) {
        const error = await response.text();
        addLlmLog({ endpoint: 'responses', model: requestedModel, stream: isStreaming, status: response.status, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: null, prompt: null, response: null, error, backend: backend.id, requestBody: req.body });
        return res.status(response.status).send(error);
      }
      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let completionTokens = 0, promptTokens = 0, model = routing.targetModel, responseText = '';
        const processStream = async () => {
          try {
            while (true) { const { done, value } = await reader.read(); if (done) break; const chunk = decoder.decode(value); res.write(chunk); const lines = chunk.split('\n'); for (const line of lines) { if (line.startsWith('data: ') && line !== 'data: [DONE]') { try { const data = JSON.parse(line.slice(6)); if (data.type === 'response.output_text.delta' && data.delta) responseText += data.delta; if (data.usage) { promptTokens = data.usage.input_tokens || data.usage.prompt_tokens || promptTokens; completionTokens = data.usage.output_tokens || data.usage.completion_tokens || completionTokens; } if (data.model) model = data.model; } catch { /* skip */ } } } }
            res.end();
            const duration = Date.now() - startTime;
            const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
            recordTokenStats({ promptTokens, completionTokens, tokensPerSecond, model, duration, backend: backend.name });
            updateBackendTokenStats(backend.id, promptTokens, completionTokens, duration, backend);
            addLlmLog({ endpoint: 'responses', model, stream: true, status: 200, duration, promptTokens, completionTokens, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, messages: null, prompt: null, response: responseText, error: null, backend: backend.id, requestBody: req.body });
          } catch (e) { res.end(); }
        };
        processStream();
      } else {
        const data = await response.json();
        const duration = Date.now() - startTime;
        const usage = data.usage || {};
        const promptTokens = usage.input_tokens || usage.prompt_tokens || 0;
        const completionTokens = usage.output_tokens || usage.completion_tokens || 0;
        const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
        recordTokenStats({ promptTokens, completionTokens, tokensPerSecond, model: data.model || routing.targetModel, duration, backend: backend.name });
        updateBackendTokenStats(backend.id, promptTokens, completionTokens, duration, backend);
        addLlmLog({ endpoint: 'responses', model: data.model || routing.targetModel, stream: false, status: 200, duration, promptTokens, completionTokens, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, messages: null, prompt: null, response: null, error: null, backend: backend.id, requestBody: req.body });
        data._llama_manager = { duration, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, backend: backend.id };
        res.json(data);
      }
    } catch (error) {
      addLlmLog({ endpoint: 'responses', model: requestedModel, stream: isStreaming, status: 502, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: null, prompt: null, response: null, error: error.message, backend: routing.backend.id, requestBody: req.body });
      res.status(502).json({ error: `Failed to reach remote backend ${routing.backend.name}`, details: error.message });
    }
    return;
  }

  let totalRetries = 0;
  let allRetryErrors = [];
  let anyRestarted = false;
  try {
    let result = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proxyBody)
    }, { label: 'responses', model: proxyBody.model });
    let response = result.response;
    totalRetries = result.retries;
    allRetryErrors = [...result.retryErrors];
    anyRestarted = anyRestarted || result.restarted;
    req._retryInfo = { retries: totalRetries, retryErrors: allRetryErrors, restarted: anyRestarted };
    const retryFields = () => ({ retries: totalRetries, retryErrors: allRetryErrors, requestBody: req.body });

    // If model failed to load, unload others and retry
    if (!response.ok) {
      const error = await response.text();
      if (isModelLoadFailure(response.status, error)) {
        console.log(`[responses] Model load failure for ${requestedModel}, attempting to free memory`);
        const unloaded = await unloadOtherModels(requestedModel);
        if (unloaded) {
          result = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/responses`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(proxyBody)
          }, { label: 'responses', model: proxyBody.model });
          response = result.response;
          totalRetries += result.retries;
          allRetryErrors.push(...result.retryErrors);
          anyRestarted = anyRestarted || result.restarted;
          req._retryInfo = { retries: totalRetries, retryErrors: allRetryErrors, restarted: anyRestarted };
        }
      }
      if (!response.ok) {
        const retryError = response.bodyUsed ? error : await response.text();
        console.error(`[responses] Error ${response.status} for model ${requestedModel}: ${retryError}`);
        addLog('responses', `Responses API failed for model ${requestedModel}: ${retryError}`);
        addLlmLog({
          endpoint: 'responses', model: requestedModel, stream: isStreaming,
          status: response.status, duration: Date.now() - startTime,
          promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
          messages: req.body.input ? (Array.isArray(req.body.input) ? req.body.input : [{ role: 'user', content: req.body.input }]) : null,
          prompt: null, response: null, error: retryError, ...retryFields()
        });
        return res.status(response.status).send(retryError);
      }
    }

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let completionTokens = 0;
      let promptTokens = 0;
      let model = requestedModel;
      let responseText = '';

      const processStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            res.write(chunk);

            // Parse SSE data to count tokens
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.type === 'response.output_text.delta' && data.delta) {
                    responseText += data.delta;
                  }
                  if (data.usage) {
                    promptTokens = data.usage.input_tokens || data.usage.prompt_tokens || promptTokens;
                    completionTokens = data.usage.output_tokens || data.usage.completion_tokens || completionTokens;
                  }
                  if (data.model) {
                    model = data.model;
                  }
                } catch (e) {
                  // Skip parse errors
                }
              }
            }
          }
          res.end();

          const duration = Date.now() - startTime;
          const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
          recordTokenStats({ promptTokens, completionTokens, tokensPerSecond, model, duration });
          addLlmLog({
            endpoint: 'responses', model, stream: true,
            status: 200, duration, promptTokens, completionTokens,
            tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
            messages: req.body.input ? (Array.isArray(req.body.input) ? req.body.input : [{ role: 'user', content: req.body.input }]) : null,
            prompt: null, response: responseText, error: null, ...retryFields()
          });
        } catch (e) {
          console.error('[responses] Stream error:', e);
          res.end();
        }
      };

      processStream();
    } else {
      const data = await response.json();
      const duration = Date.now() - startTime;
      const usage = data.usage || {};
      const promptTokens = usage.input_tokens || usage.prompt_tokens || 0;
      const completionTokens = usage.output_tokens || usage.completion_tokens || 0;
      const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;

      recordTokenStats({
        promptTokens,
        completionTokens,
        tokensPerSecond,
        model: data.model || requestedModel,
        duration
      });

      // Extract response text from Responses API output
      let respText = null;
      if (data.output) {
        for (const item of data.output) {
          if (item.type === 'message' && item.content) {
            respText = item.content.map(c => c.text || '').join('');
            break;
          }
        }
      }

      addLlmLog({
        endpoint: 'responses', model: data.model || requestedModel,
        stream: false, status: 200, duration, promptTokens, completionTokens,
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
        messages: req.body.input ? (Array.isArray(req.body.input) ? req.body.input : [{ role: 'user', content: req.body.input }]) : null,
        prompt: null, response: respText, error: null, ...retryFields()
      });

      data._llama_manager = {
        duration,
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10
      };

      res.json(data);
    }
  } catch (error) {
    addLlmLog({
      endpoint: 'responses', model: requestedModel, stream: isStreaming,
      status: 502, duration: Date.now() - startTime,
      promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
      messages: req.body.input ? (Array.isArray(req.body.input) ? req.body.input : [{ role: 'user', content: req.body.input }]) : null,
      prompt: null, response: null, error: error.message, requestBody: req.body,
      retries: error.retries || totalRetries, retryErrors: error.retryErrors || allRetryErrors
    });
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
});

// Anthropic Messages API compatibility (proxied to llama.cpp)
app.post('/api/v1/messages', async (req, res) => {
  const startTime = Date.now();
  const isStreaming = req.body.stream === true;
  const requestedModel = req.body.model || 'default';

  console.log(`[messages] Request for model: ${requestedModel}`);

  // Inject reasoning_effort if configured
  const proxyBody = injectReasoningEffort(req.body);

  // Route to remote backend if applicable
  const routing = resolveBackend(requestedModel, 'messages');
  if (routing.remote) {
    req._backend = routing.backend.id;
    const remoteBody = { ...proxyBody, model: routing.targetModel };
    try {
      const { response, backend } = await fetchRemoteBackend(routing.backend, routing.targetUrl, {
        method: 'POST', headers: { ...routing.headers }, body: JSON.stringify(remoteBody)
      }, { label: 'messages', model: routing.targetModel });
      if (!response.ok) {
        const error = await response.text();
        addLlmLog({ endpoint: 'messages', model: requestedModel, stream: isStreaming, status: response.status, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: req.body.messages || null, prompt: null, response: null, error, backend: backend.id, requestBody: req.body });
        return res.status(response.status).send(error);
      }
      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let completionTokens = 0, promptTokens = 0, model = routing.targetModel, responseText = '';
        const processStream = async () => {
          try {
            while (true) { const { done, value } = await reader.read(); if (done) break; const chunk = decoder.decode(value); res.write(chunk); const lines = chunk.split('\n'); for (const line of lines) { if (line.startsWith('data: ') && line !== 'data: [DONE]') { try { const data = JSON.parse(line.slice(6)); if (data.type === 'content_block_delta' && data.delta?.text) { responseText += data.delta.text; completionTokens++; } if (data.usage) { promptTokens = data.usage.input_tokens || promptTokens; completionTokens = data.usage.output_tokens || completionTokens; } if (data.model) model = data.model; } catch { /* skip */ } } } }
            res.end();
            const duration = Date.now() - startTime;
            const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
            recordTokenStats({ promptTokens, completionTokens, tokensPerSecond, model, duration, backend: backend.name });
            updateBackendTokenStats(backend.id, promptTokens, completionTokens, duration, backend);
            addLlmLog({ endpoint: 'messages', model, stream: true, status: 200, duration, promptTokens, completionTokens, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, messages: req.body.messages || null, prompt: null, response: responseText, error: null, backend: backend.id, requestBody: req.body });
          } catch (e) { res.end(); }
        };
        processStream();
      } else {
        const data = await response.json();
        const duration = Date.now() - startTime;
        const usage = data.usage || {};
        const promptTokens = usage.input_tokens || 0;
        const completionTokens = usage.output_tokens || 0;
        const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
        recordTokenStats({ promptTokens, completionTokens, tokensPerSecond, model: data.model || routing.targetModel, duration, backend: backend.name });
        updateBackendTokenStats(backend.id, promptTokens, completionTokens, duration, backend);
        addLlmLog({ endpoint: 'messages', model: data.model || routing.targetModel, stream: false, status: 200, duration, promptTokens, completionTokens, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, messages: req.body.messages || null, prompt: null, response: null, error: null, backend: backend.id, requestBody: req.body });
        data._llama_manager = { duration, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, backend: backend.id };
        res.json(data);
      }
    } catch (error) {
      addLlmLog({ endpoint: 'messages', model: requestedModel, stream: isStreaming, status: 502, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: req.body.messages || null, prompt: null, response: null, error: error.message, backend: routing.backend.id, requestBody: req.body });
      res.status(502).json({ error: `Failed to reach remote backend ${routing.backend.name}`, details: error.message });
    }
    return;
  }

  let totalRetries = 0;
  let allRetryErrors = [];
  let anyRestarted = false;
  try {
    let result = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proxyBody)
    }, { label: 'messages', model: proxyBody.model });
    let response = result.response;
    totalRetries = result.retries;
    allRetryErrors = [...result.retryErrors];
    anyRestarted = anyRestarted || result.restarted;
    req._retryInfo = { retries: totalRetries, retryErrors: allRetryErrors, restarted: anyRestarted };
    const retryFields = () => ({ retries: totalRetries, retryErrors: allRetryErrors, requestBody: req.body });

    // If model failed to load, unload others and retry
    if (!response.ok) {
      const error = await response.text();
      if (isModelLoadFailure(response.status, error)) {
        console.log(`[messages] Model load failure for ${requestedModel}, attempting to free memory`);
        const unloaded = await unloadOtherModels(requestedModel);
        if (unloaded) {
          result = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(proxyBody)
          }, { label: 'messages', model: proxyBody.model });
          response = result.response;
          totalRetries += result.retries;
          allRetryErrors.push(...result.retryErrors);
          anyRestarted = anyRestarted || result.restarted;
          req._retryInfo = { retries: totalRetries, retryErrors: allRetryErrors, restarted: anyRestarted };
        }
      }
      if (!response.ok) {
        const retryError = response.bodyUsed ? error : await response.text();
        console.error(`[messages] Error ${response.status} for model ${requestedModel}: ${retryError}`);
        addLog('messages', `Messages API failed for model ${requestedModel}: ${retryError}`);
        addLlmLog({
          endpoint: 'messages', model: requestedModel, stream: isStreaming,
          status: response.status, duration: Date.now() - startTime,
          promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
          messages: req.body.messages || null, prompt: null, response: null, error: retryError,
          ...retryFields()
        });
        return res.status(response.status).send(retryError);
      }
    }

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let inputTokens = 0;
      let outputTokens = 0;
      let model = requestedModel;
      let responseText = '';

      const processStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            res.write(chunk);

            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.type === 'content_block_delta' && data.delta?.text) {
                    responseText += data.delta.text;
                  }
                  if (data.usage) {
                    inputTokens = data.usage.input_tokens || inputTokens;
                    outputTokens = data.usage.output_tokens || outputTokens;
                  }
                  if (data.message?.usage) {
                    inputTokens = data.message.usage.input_tokens || inputTokens;
                  }
                  if (data.model) {
                    model = data.model;
                  }
                } catch (e) {
                  // Skip parse errors
                }
              }
            }
          }
          res.end();

          const duration = Date.now() - startTime;
          const tokensPerSecond = duration > 0 ? (outputTokens / (duration / 1000)) : 0;
          recordTokenStats({ promptTokens: inputTokens, completionTokens: outputTokens, tokensPerSecond, model, duration });
          addLlmLog({
            endpoint: 'messages', model, stream: true,
            status: 200, duration, promptTokens: inputTokens, completionTokens: outputTokens,
            tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
            messages: req.body.messages || null, prompt: null,
            response: responseText, error: null, ...retryFields()
          });
        } catch (e) {
          console.error('[messages] Stream error:', e);
          res.end();
        }
      };

      processStream();
    } else {
      const data = await response.json();
      const duration = Date.now() - startTime;
      const usage = data.usage || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const tokensPerSecond = duration > 0 ? (outputTokens / (duration / 1000)) : 0;

      recordTokenStats({
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        tokensPerSecond,
        model: data.model || requestedModel,
        duration
      });

      addLlmLog({
        endpoint: 'messages', model: data.model || requestedModel,
        stream: false, status: 200, duration,
        promptTokens: inputTokens, completionTokens: outputTokens,
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
        messages: req.body.messages || null, prompt: null,
        response: data.content?.[0]?.text || null, error: null, ...retryFields()
      });

      data._llama_manager = {
        duration,
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10
      };

      res.json(data);
    }
  } catch (error) {
    addLlmLog({
      endpoint: 'messages', model: requestedModel, stream: isStreaming,
      status: 502, duration: Date.now() - startTime,
      promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
      messages: req.body.messages || null, prompt: null,
      response: null, error: error.message, requestBody: req.body,
      retries: error.retries || totalRetries, retryErrors: error.retryErrors || allRetryErrors
    });
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
});

// Anthropic Messages token counting (proxied to llama.cpp)
app.post('/api/v1/messages/count_tokens', async (req, res) => {
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).send(error);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
});

// OpenAI-compatible reranking endpoint
app.post('/api/v1/rerank', async (req, res) => {
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/v1/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).send(error);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
});

// Reranking alias
app.post('/api/v1/reranking', async (req, res) => {
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/v1/reranking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).send(error);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
});

// Catch-all for SPA routing
app.get('*', (req, res) => {
  if (existsSync(join(UI_BUILD_PATH, 'index.html'))) {
    res.sendFile(join(UI_BUILD_PATH, 'index.html'));
  } else {
    res.status(404).json({ error: 'UI not built. Run: cd ui && npm install && npm run build' });
  }
});

// Start the API server with WebSocket support
httpServer.listen(API_PORT, '0.0.0.0', () => {
  console.log(`Llama Manager API running on http://0.0.0.0:${API_PORT}`);
  console.log(`WebSocket available at ws://0.0.0.0:${API_PORT}/ws`);
  console.log(`Models directory: ${MODELS_DIR}`);
  console.log(`Llama server will run on port ${LLAMA_PORT}`);
  console.log(`Stats interval: ${STATS_INTERVAL}ms`);

  // Auto-start llama if configured
  if (config.autoStart) {
    console.log('Auto-starting llama server...');
    setTimeout(() => {
      fetch(`http://localhost:${API_PORT}/api/server/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }).catch(err => console.error('Auto-start failed:', err));
    }, 1000);
  }
});

// Memory watchdog — restart llama-server if system memory >= 95% and it's the heaviest process
const MEM_WATCHDOG_INTERVAL = 30_000; // check every 30s
const MEM_WATCHDOG_THRESHOLD = 95; // percent
let memWatchdogCooldown = false;

function getSystemMemoryPercent() {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const total = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] || '0', 10);
    const available = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] || '0', 10);
    if (total === 0) return 0;
    return ((total - available) / total) * 100;
  } catch {
    return 0;
  }
}

function isLlamaServerHeaviestProcess() {
  try {
    // Get top process by RSS, excluding kernel threads (pid 0) and this node process
    const output = execSync('ps -eo pid,rss,comm --sort=-rss --no-headers', { encoding: 'utf8', timeout: 5000 });
    const lines = output.trim().split('\n');
    if (lines.length === 0) return false;
    const top = lines[0].trim().split(/\s+/);
    // top = [pid, rss_kb, command]
    const topComm = top.slice(2).join(' ');
    return topComm.includes('llama-server');
  } catch {
    return false;
  }
}

setInterval(() => {
  if (!llamaProcess || memWatchdogCooldown || restartInProgress) return;

  const memPercent = getSystemMemoryPercent();
  if (memPercent >= MEM_WATCHDOG_THRESHOLD) {
    if (isLlamaServerHeaviestProcess()) {
      memWatchdogCooldown = true;
      const msg = `Memory watchdog triggered: system at ${memPercent.toFixed(1)}% and llama-server is heaviest process. Restarting...`;
      console.warn(`[mem-watchdog] ${msg}`);
      addLog('system', msg);
      recordCrashEvent({ exitCode: null, trigger: 'memory_watchdog' });

      restartLlamaServer()
        .then(() => {
          addLog('system', 'Memory watchdog restart completed successfully');
        })
        .catch(err => {
          console.error('[mem-watchdog] Restart failed:', err.message);
          addLog('system', `Memory watchdog restart failed: ${err.message}`);
        })
        .finally(() => {
          // Cooldown for 60s to avoid rapid-fire restarts
          setTimeout(() => { memWatchdogCooldown = false; }, 60_000);
        });
    }
  }
}, MEM_WATCHDOG_INTERVAL);

// Idle shutdown — stop llama-server after 15 min with no requests
const IDLE_SHUTDOWN_MINUTES = 15;
const IDLE_CHECK_INTERVAL = 60_000; // check every minute

setInterval(async () => {
  if (!llamaProcess || llamaProcess.killed || restartInProgress) return;
  if (activeRequests.size > 0) return; // requests in flight
  if (llamaQueue.active > 0 || llamaQueue.pending > 0) return;

  const idleMs = Date.now() - (lastUsedModelTime || 0);
  if (idleMs >= IDLE_SHUTDOWN_MINUTES * 60_000) {
    const msg = `Idle shutdown: no requests for ${Math.round(idleMs / 60_000)} minutes. Stopping llama-server to save resources.`;
    console.log(`[idle] ${msg}`);
    addLog('system', msg);
    idleShutdown = true;
    intentionalStop = true;
    await stopLlamaServer();
    intentionalStop = false;
  }
}, IDLE_CHECK_INTERVAL);

// Graceful shutdown with forced exit timeout
function shutdownWithTimeout(signal) {
  console.log(`Received ${signal}, shutting down...`);
  const forceExit = setTimeout(() => {
    console.log('Shutdown timeout, forcing exit');
    process.exit(1);
  }, 10000);
  forceExit.unref();
  stopLlamaServer().finally(() => process.exit(0));
}

process.on('SIGTERM', () => shutdownWithTimeout('SIGTERM'));
process.on('SIGINT', () => shutdownWithTimeout('SIGINT'));
