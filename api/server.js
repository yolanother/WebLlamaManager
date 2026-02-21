import express from 'express';
import cors from 'cors';
import { spawn, exec, execSync } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, rmdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { cpus, totalmem, freemem, loadavg } from 'os';
import pty from 'node-pty';

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
const REQUEST_LOG_SKIP_PATHS = new Set(['/ws', '/api/stats', '/api/analytics', '/api/analytics/history']);
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
      error: errorMessage
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
// Expand ~ to home directory for MODELS_DIR
const MODELS_DIR_RAW = process.env.MODELS_DIR || join(process.env.HOME, 'models');
const MODELS_DIR = MODELS_DIR_RAW.startsWith('~') ? MODELS_DIR_RAW.replace(/^~/, process.env.HOME) : MODELS_DIR_RAW;
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

// Track current llama-server configuration for compatibility checks
// Updated when server starts in router or preset mode
let serverConfig = {
  context: 8192,        // Context window size (-c)
  gpuLayers: 99,        // GPU layers for offloading (-ngl)
  flashAttn: false,     // Flash attention enabled (--flash-attn)
  modelsMax: 2,         // Max models for router mode (--model-slot)
  reasoningFormat: null, // Reasoning format (--reasoning-format)
  extraSwitches: '--jinja' // Additional llama-server switches
};

// Mutex to prevent concurrent server restarts
let serverRestartLock = false;

// Analytics data storage (circular buffers for time-series data)
const MAX_ANALYTICS_POINTS = 300; // 5 minutes at 1 second intervals
const analyticsData = {
  temperature: [],   // { timestamp, gpu, cpu }
  power: [],         // { timestamp, watts }
  memory: [],        // { timestamp, vram, gtt, system }
  tokens: []         // { timestamp, promptTokens, completionTokens, tokensPerSecond, model }
};

// Persistent analytics storage (minute-level aggregates in JSONL file)
const ANALYTICS_DIR = join(PROJECT_ROOT, 'data');
const ANALYTICS_FILE = join(ANALYTICS_DIR, 'analytics.jsonl');
const MAX_ANALYTICS_HISTORY = 525600; // 1 year of minute-level data
let analyticsHistory = [];

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

// Request stats accumulator (per-minute tallies)
const requestStatsAccum = {
  total: 0,
  ok: 0,
  err: 0,
  statusCodes: {},
  totalPromptTokens: 0,
  totalCompletionTokens: 0
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
    rT: requestStatsAccum.total,
    rOk: requestStatsAccum.ok,
    rErr: requestStatsAccum.err,
    sc: { ...requestStatsAccum.statusCodes },
    tp: requestStatsAccum.totalPromptTokens,
    tcc: requestStatsAccum.totalCompletionTokens
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
  requestStatsAccum.statusCodes = {};
  requestStatsAccum.totalPromptTokens = 0;
  requestStatsAccum.totalCompletionTokens = 0;
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
  const { promptTokens, completionTokens, tokensPerSecond, model, duration } = stats;

  tokenStats.totalPromptTokens += promptTokens || 0;
  tokenStats.totalCompletionTokens += completionTokens || 0;
  tokenStats.totalRequests++;

  // Also accumulate into per-minute request stats
  requestStatsAccum.totalPromptTokens += promptTokens || 0;
  requestStatsAccum.totalCompletionTokens += completionTokens || 0;

  const requestRecord = {
    timestamp: Date.now(),
    promptTokens: promptTokens || 0,
    completionTokens: completionTokens || 0,
    tokensPerSecond: tokensPerSecond || 0,
    model: model || 'unknown',
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
      requestLogging: false
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
    llamaPort: LLAMA_PORT,
    llamaUiUrl: LLAMA_UI_URL,
    mode: currentMode,
    preset: currentPreset ? config.presets[currentPreset] : null,
    downloads: Object.fromEntries(
      Array.from(downloadProcesses.entries()).map(([id, info]) => [
        id,
        { progress: info.progress, status: info.status, error: info.error, output: info.output, startedAt: info.startedAt }
      ])
    )
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

// ============================================================================
// Unified Model Configuration: Preset Resolution Layer
// ============================================================================

/**
 * Resolve a model ID to a preset configuration or file path.
 * 
 * Resolution order:
 * 1. Check if modelId matches a preset ID in config.presets
 * 2. Fall back to file path lookup in MODELS_DIR (with deprecation warning)
 * 3. Return null if not found
 * 
 * @param {string} modelId - The model identifier (preset ID or file path)
 * @returns {object|null} - { type: 'preset', preset: {...} } or { type: 'file', path: '...' } or null
 */
function resolveModel(modelId) {
  if (!modelId) return null;

  // 1. Check if it's a preset ID
  if (config.presets && config.presets[modelId]) {
    const preset = config.presets[modelId];
    console.log(`[resolveModel] Resolved "${modelId}" to preset: ${preset.name}`);
    return { type: 'preset', preset };
  }

  // 2. Check for file path (backward compatibility)
  const fullPath = modelId.startsWith('/') ? modelId : join(MODELS_DIR, modelId);
  if (existsSync(fullPath) && fullPath.endsWith('.gguf')) {
    console.log(`[resolveModel] DEPRECATION WARNING: Using file path "${modelId}" directly. Consider creating a preset for this model.`);
    addLog('models', `DEPRECATION: Direct file path "${modelId}" used. Create a preset for better configuration.`);
    return { type: 'file', path: fullPath, relativePath: modelId };
  }

  // 3. Check if a preset references this model path (reverse lookup)
  if (config.presets) {
    for (const preset of Object.values(config.presets)) {
      const presetModelPath = preset.modelPath ? basename(preset.modelPath) : null;
      if (presetModelPath && (modelId === presetModelPath || modelId.endsWith(presetModelPath))) {
        console.log(`[resolveModel] Resolved file path "${modelId}" to preset: ${preset.id}`);
        return { type: 'preset', preset };
      }
    }
  }

  console.log(`[resolveModel] Model "${modelId}" not found`);
  return null;
}

/**
 * Get the model path to use for llama.cpp from a resolved model.
 * For presets with hfRepo, returns the expected download path.
 * For presets with modelPath, returns the relative path.
 * For file paths, returns as-is.
 * 
 * @param {object} resolved - Result from resolveModel()
 * @returns {string|null} - The model path for llama.cpp
 */
function resolveModelPath(resolved) {
  if (!resolved) return null;

  if (resolved.type === 'file') {
    // For file-based resolution, return just the folder name as the model ID
    // llama.cpp router mode uses folder names as model IDs
    const relativePath = resolved.relativePath;
    const folderName = relativePath.split('/')[0];
    return folderName;
  }

  if (resolved.type === 'preset') {
    const preset = resolved.preset;
    
    // If preset has a direct model path, extract the folder name for llama.cpp
    if (preset.modelPath) {
      let relativePath;
      if (preset.modelPath.startsWith(MODELS_DIR)) {
        relativePath = preset.modelPath.replace(MODELS_DIR + '/', '');
      } else {
        relativePath = preset.modelPath;
      }
      // Return just the folder name as the model ID for llama.cpp router mode
      const folderName = relativePath.split('/')[0];
      return folderName;
    }

    // If preset uses hfRepo, return the hfRepo as the model ID
    // llama.cpp router mode can load directly from HuggingFace
    if (preset.hfRepo) {
      return preset.hfRepo;
    }

    return null;
  }

  return null;
}

/**
 * Check if a preset's model is currently loaded in llama.cpp.
 * 
 * @param {object} preset - The preset configuration
 * @param {Array} serverModels - Array of models from llama.cpp /models endpoint
 * @returns {string} - 'loaded', 'loading', or 'available'
 */
function getPresetStatus(preset, serverModels) {
  if (!preset || !serverModels || serverModels.length === 0) {
    return 'available';
  }

  // Check if this preset is the currently active one
  if (currentPreset === preset.id) {
    return 'loaded';  // This preset is specifically active
  }

  // Get the model path that would be used for this preset
  const resolved = { type: 'preset', preset };
  const modelPath = resolveModelPath(resolved);
  
  if (!modelPath) {
    // Model not downloaded yet
    return 'not_downloaded';
  }

  // Check if the preset would need a server restart
  const compat = isCompatible(preset);
  
  // Check if any loaded model matches this path
  for (const model of serverModels) {
    const modelId = model.id || '';
    const status = model.status?.value || 'unknown';
    
    // Match by path (could be full path or relative)
    if (modelId === modelPath || 
        modelId.endsWith(modelPath) || 
        modelPath.endsWith(modelId) ||
        basename(modelId) === basename(modelPath)) {
      if (status === 'loaded') {
        // Model is loaded, but is this preset compatible with current config?
        if (compat.compatible) {
          return 'loaded';  // Can use immediately
        } else {
          return 'available';  // Would need restart, show as available
        }
      }
      if (status === 'loading') return 'loading';
    }
  }

  return 'available';
}

/**
 * Apply preset configuration to a request body.
 * Injects sampling parameters, chat_template_kwargs, etc.
 * 
 * @param {object} body - The original request body
 * @param {object} preset - The preset configuration
 * @returns {object} - Modified request body with preset params applied
 */
function applyPresetToRequest(body, preset) {
  if (!preset || !preset.config) return body;

  const result = { ...body };

  // Apply sampling parameters if not already set in request
  if (preset.config.temp !== undefined && result.temperature === undefined) {
    result.temperature = preset.config.temp;
  }
  if (preset.config.topP !== undefined && result.top_p === undefined) {
    result.top_p = preset.config.topP;
  }
  if (preset.config.topK !== undefined && result.top_k === undefined) {
    result.top_k = preset.config.topK;
  }
  if (preset.config.minP !== undefined && result.min_p === undefined) {
    result.min_p = preset.config.minP;
  }

  // Apply chat_template_kwargs if preset has them configured
  if (preset.config.chatTemplateKwargs) {
    try {
      const presetKwargs = typeof preset.config.chatTemplateKwargs === 'string' 
        ? JSON.parse(preset.config.chatTemplateKwargs)
        : preset.config.chatTemplateKwargs;
      
      result.chat_template_kwargs = {
        ...presetKwargs,
        ...result.chat_template_kwargs  // Request values take precedence
      };
    } catch (e) {
      console.error(`[applyPresetToRequest] Failed to parse chatTemplateKwargs: ${e.message}`);
    }
  }

  return result;
}

/**
 * Resolve model ID and prepare request body for proxying to llama.cpp.
 * This is the main helper function used by all proxy endpoints.
 * 
 * @param {object} body - The original request body
 * @returns {object} - { body: modifiedBody, resolved: resolvedModel, modelPath: string }
 */
function prepareProxyRequest(body) {
  const modelId = body.model;
  const resolved = resolveModel(modelId);
  
  if (!resolved) {
    // Model not found, return as-is and let llama.cpp handle the error
    return { body, resolved: null, modelPath: modelId };
  }

  let modifiedBody = { ...body };
  let modelPath = modelId;

  if (resolved.type === 'preset') {
    // Resolve the actual model path for llama.cpp
    modelPath = resolveModelPath(resolved);
    if (modelPath) {
      modifiedBody.model = modelPath;
    }

    // Apply preset configuration to request
    modifiedBody = applyPresetToRequest(modifiedBody, resolved.preset);

    console.log(`[prepareProxyRequest] Preset "${resolved.preset.id}" -> model "${modelPath}"`);
  } else if (resolved.type === 'file') {
    modelPath = resolved.relativePath;
    modifiedBody.model = modelPath;
  }

  return { body: modifiedBody, resolved, modelPath };
}

// ============================================================================
// Server Compatibility and Smart Restart
// ============================================================================

/**
 * Check if a preset can be served with the current llama-server configuration.
 * Returns true if the preset is compatible (no restart needed), false otherwise.
 * 
 * @param {object} preset - The preset configuration
 * @returns {object} - { compatible: boolean, reasons: string[] }
 */
function isCompatible(preset) {
  const reasons = [];
  
  if (!preset) {
    // No preset means it can use defaults - compatible
    return { compatible: true, reasons: [] };
  }
  
  const presetConfig = preset.config || {};
  
  // Context: requires server restart to change
  // If preset specifies a context (non-zero), it must match current context
  // Context 0 means "use default/current" so it's always compatible
  if (preset.context && preset.context !== serverConfig.context) {
    reasons.push(`Context ${preset.context} != current ${serverConfig.context}`);
  }
  
  // GPU layers: must match if specified (affects VRAM allocation)
  if (presetConfig.gpuLayers !== undefined && 
      presetConfig.gpuLayers !== serverConfig.gpuLayers) {
    reasons.push(`GPU layers ${presetConfig.gpuLayers} != current ${serverConfig.gpuLayers}`);
  }
  
  // Flash attention: must match if server was started with/without it
  if (presetConfig.flashAttn !== undefined && 
      presetConfig.flashAttn !== serverConfig.flashAttn) {
    reasons.push(`Flash attention ${presetConfig.flashAttn} != current ${serverConfig.flashAttn}`);
  }
  
  // Reasoning format: requires restart if different
  if (presetConfig.reasoningFormat && 
      presetConfig.reasoningFormat !== serverConfig.reasoningFormat) {
    reasons.push(`Reasoning format "${presetConfig.reasoningFormat}" != current "${serverConfig.reasoningFormat || 'none'}"`);
  }
  
  // Note: temperature, top_p, top_k, min_p are NOT checked here
  // because they can be passed per-request to the llama.cpp API
  
  return {
    compatible: reasons.length === 0,
    reasons
  };
}

/**
 * Wait for llama-server to become healthy after restart.
 * 
 * @param {number} timeoutMs - Maximum time to wait in milliseconds
 * @returns {Promise<boolean>} - true if server is healthy, false if timeout
 */
async function waitForServerHealth(timeoutMs = 30000) {
  const startTime = Date.now();
  const checkInterval = 500;
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`${LLAMA_SERVER_URL}/health`);
      if (response.ok) {
        const data = await response.json();
        if (data.status === 'ok' || data.status === 'no slot available') {
          return true;
        }
      }
    } catch {
      // Server not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
  
  return false;
}

/**
 * Restart llama-server with new configuration for a preset.
 * Uses a mutex to prevent concurrent restarts.
 * 
 * @param {object} preset - The preset requiring the restart
 * @returns {Promise<object>} - { success: boolean, error?: string }
 */
async function restartForPreset(preset) {
  // Check mutex
  if (serverRestartLock) {
    console.log('[restartForPreset] Restart already in progress, waiting...');
    // Wait for current restart to complete (poll every 500ms, max 60s)
    const waitStart = Date.now();
    while (serverRestartLock && Date.now() - waitStart < 60000) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (serverRestartLock) {
      return { success: false, error: 'Timeout waiting for concurrent restart' };
    }
    // Restart completed, check if we're now compatible
    const compat = isCompatible(preset);
    if (compat.compatible) {
      return { success: true };
    }
  }
  
  // Acquire mutex
  serverRestartLock = true;
  
  try {
    const presetConfig = preset.config || {};
    console.log(`[restartForPreset] Restarting server for preset "${preset.id}"`);
    addLog('server', `Restarting llama-server for preset "${preset.id}"`);
    
    // Stop current server
    if (llamaProcess) {
      console.log('[restartForPreset] Stopping current llama-server...');
      llamaProcess.kill('SIGTERM');
      
      // Wait for process to exit (max 10 seconds)
      const stopStart = Date.now();
      while (llamaProcess && Date.now() - stopStart < 10000) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      if (llamaProcess) {
        console.log('[restartForPreset] Force killing llama-server...');
        llamaProcess.kill('SIGKILL');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Calculate new values (but don't update serverConfig yet - wait for success)
    // Note: context is stored at preset level, not inside config
    const newContext = preset.context || config.defaultContext || 8192;
    const newGpuLayers = presetConfig.gpuLayers !== undefined ? presetConfig.gpuLayers : (config.gpuLayers || 99);
    const newFlashAttn = presetConfig.flashAttn !== undefined ? presetConfig.flashAttn : (config.flashAttn || false);
    const newReasoningFormat = presetConfig.reasoningFormat || null;
    
    // Save old values to restore on failure
    const oldServerConfig = { ...serverConfig };
    const oldMode = currentMode;
    const oldPreset = currentPreset;
    
    // Build extra switches - start with preset's extraSwitches, ensure --jinja is included
    let extraSwitches = presetConfig.extraSwitches || '--jinja';
    // Ensure --jinja is always present
    if (!extraSwitches.includes('--jinja')) {
      extraSwitches = '--jinja ' + extraSwitches;
    }
    if (newFlashAttn && !extraSwitches.includes('--flash-attn')) {
      extraSwitches += ' --flash-attn';
    }
    if (newReasoningFormat && !extraSwitches.includes('--reasoning-format')) {
      extraSwitches += ` --reasoning-format ${newReasoningFormat}`;
    }
    
    // Use start-preset.sh with environment variables (same as /api/presets/:presetId/activate)
    const startScript = join(PROJECT_ROOT, 'start-preset.sh');
    const env = {
      ...process.env,
      PORT: String(LLAMA_PORT),
      MODELS_DIR,
      // Use HF_REPO if available, otherwise MODEL_PATH
      HF_REPO: preset.hfRepo || '',
      MODEL_PATH: preset.hfRepo ? '' : (preset.modelPath || ''),
      CONTEXT: String(newContext),
      TEMP: String(presetConfig.temp ?? 0.7),
      TOP_P: String(presetConfig.topP ?? 1.0),
      TOP_K: String(presetConfig.topK ?? 20),
      MIN_P: String(presetConfig.minP ?? 0),
      CHAT_TEMPLATE_KWARGS: presetConfig.chatTemplateKwargs || '',
      EXTRA_SWITCHES: extraSwitches
    };
    
    currentMode = 'single';
    currentPreset = preset.id;
    
    const modelInfo = preset.hfRepo || preset.modelPath;
    console.log(`[restartForPreset] Starting server for preset "${preset.id}" with model ${modelInfo}`);
    console.log(`[restartForPreset] Context: ${newContext}, Extra switches: ${extraSwitches}`);
    addLog('server', `Restarting for preset "${preset.id}" with context=${newContext}`);
    
    // Start the server using start-preset.sh
    const { spawn } = await import('child_process');
    llamaProcess = spawn('bash', [startScript], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
    
    llamaProcess.stdout.on('data', (data) => {
      addLog('llama', data);
    });
    
    llamaProcess.stderr.on('data', (data) => {
      addLog('llama', data);
    });
    
    llamaProcess.on('exit', (code, signal) => {
      console.log(`[restartForPreset] llama-server exited with code ${code}, signal ${signal}`);
      addLog('system', `llama-server exited with code ${code}`);
      llamaProcess = null;
    });
    
    // Wait for server to be healthy
    console.log('[restartForPreset] Waiting for server to become healthy...');
    const healthy = await waitForServerHealth(60000);
    
    if (!healthy) {
      console.error('[restartForPreset] Server failed to become healthy');
      addLog('server', 'Server restart failed: health check timeout');
      // Restore old config values since restart failed
      Object.assign(serverConfig, oldServerConfig);
      currentMode = oldMode;
      currentPreset = oldPreset;
      return { success: false, error: 'Server health check timeout' };
    }
    
    // Success! Now commit the new config values
    serverConfig.context = newContext;
    serverConfig.gpuLayers = newGpuLayers;
    serverConfig.flashAttn = newFlashAttn;
    serverConfig.reasoningFormat = newReasoningFormat;
    
    console.log(`[restartForPreset] Server restarted successfully for preset "${preset.id}"`);
    addLog('server', `Server restarted successfully for preset "${preset.id}"`);
    
    return { success: true };
    
  } catch (err) {
    console.error(`[restartForPreset] Error: ${err.message}`);
    addLog('server', `Server restart error: ${err.message}`);
    // Restore old config values on error
    Object.assign(serverConfig, oldServerConfig);
    currentMode = oldMode;
    currentPreset = oldPreset;
    return { success: false, error: err.message };
    
  } finally {
    // Release mutex
    serverRestartLock = false;
  }
}

// ============================================================================
// Auto-Preset Creation: Generate presets for downloaded models
// ============================================================================

/**
 * Common quantization suffixes to strip from model names.
 * Order matters - longer/more specific patterns first.
 */
const QUANTIZATION_PATTERNS = [
  // IQ patterns (importance quantization)
  /-IQ\d_[A-Z]+$/i,
  /-IQ\d[A-Z]+$/i,
  // Q patterns with size indicators
  /-Q\d_K_[A-Z]+$/i,
  /-Q\d_K$/i,
  /-Q\d_[A-Z]+$/i,
  /-Q\d[A-Z]+$/i,
  /-Q\d$/i,
  // F patterns (float)
  /-F\d\d$/i,
  /-F\d$/i,
  /-FP\d\d$/i,
  // BF16
  /-BF16$/i,
  // Common suffixes
  /-GGUF$/i,
  /-gguf$/i,
];

/**
 * Generate a human-readable preset ID from a model filename or HuggingFace repo.
 * 
 * Examples:
 * - "Qwen2.5-Coder-32B-Instruct-Q5_K_M.gguf" -> "qwen2.5-coder-32b-instruct"
 * - "Unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q5_K_M" -> "qwen3-coder-30b-a3b-instruct"
 * 
 * @param {string} input - Model filename or HuggingFace repo string
 * @returns {string} - A clean, lowercase preset ID
 */
function generatePresetId(input) {
  let name = input;
  
  // Handle HuggingFace repo format: "org/repo:quant" or "org/repo"
  if (input.includes('/')) {
    // Extract repo name (after /)
    const parts = input.split('/');
    name = parts[parts.length - 1];
    // Remove quantization after colon
    if (name.includes(':')) {
      name = name.split(':')[0];
    }
  }
  
  // Strip .gguf extension
  name = name.replace(/\.gguf$/i, '');
  
  // Strip quantization suffixes
  for (const pattern of QUANTIZATION_PATTERNS) {
    name = name.replace(pattern, '');
  }
  
  // Strip trailing numbers that might be part numbers (e.g., "-00001-of-00004")
  name = name.replace(/-\d{5}-of-\d{5}$/i, '');
  
  // Convert to lowercase
  name = name.toLowerCase();
  
  // Replace underscores and spaces with hyphens
  name = name.replace(/[_\s]+/g, '-');
  
  // Remove any double hyphens
  name = name.replace(/--+/g, '-');
  
  // Remove trailing hyphens
  name = name.replace(/-+$/, '');
  
  return name;
}

/**
 * Extract a human-readable display name from a model filename or repo.
 * 
 * @param {string} input - Model filename or HuggingFace repo string
 * @returns {string} - A human-readable name (preserves case, removes extension)
 */
function extractModelName(input, { includeQuantization = false } = {}) {
  let name = input;
  let quantSuffix = '';
  
  // Handle HuggingFace repo format
  if (input.includes('/')) {
    const parts = input.split('/');
    name = parts[parts.length - 1];
    if (name.includes(':')) {
      name = name.split(':')[0];
    }
  }
  
  // Strip .gguf extension
  name = name.replace(/\.gguf$/i, '');
  
  // Strip quantization suffixes (preserve case) but optionally capture them
  for (const pattern of QUANTIZATION_PATTERNS) {
    const match = name.match(pattern);
    if (match) {
      if (includeQuantization && !quantSuffix) {
        // Capture the first quantization pattern found (cleaned up)
        quantSuffix = match[0].replace(/^-/, ' ');
      }
      name = name.replace(pattern, '');
    }
  }
  
  // Strip part numbers
  name = name.replace(/-\d{5}-of-\d{5}$/i, '');
  
  // Replace underscores with spaces for readability
  name = name.replace(/_/g, ' ');
  
  // Remove trailing hyphens
  name = name.replace(/-+$/, '');
  
  // Append quantization if requested
  if (includeQuantization && quantSuffix) {
    name = name + quantSuffix;
  }
  
  return name;
}

/**
 * Ensure a preset ID is unique by appending a numeric suffix if needed.
 * 
 * @param {string} baseId - The base preset ID
 * @returns {string} - A unique preset ID
 */
function ensureUniquePresetId(baseId) {
  if (!config.presets || !config.presets[baseId]) {
    return baseId;
  }
  
  // Find the next available suffix
  let suffix = 2;
  while (config.presets[`${baseId}-${suffix}`]) {
    suffix++;
  }
  
  return `${baseId}-${suffix}`;
}

/**
 * Create a default preset for a model.
 * 
 * @param {object} options - Configuration options
 * @param {string} options.modelPath - Full path to the model file (optional)
 * @param {string} options.hfRepo - HuggingFace repo string (optional)
 * @param {string} options.filename - Model filename (for generating ID/name)
 * @returns {object} - A preset object ready to save
 */
function createDefaultPreset({ modelPath, hfRepo, filename }) {
  const source = hfRepo || filename || basename(modelPath || '');
  const baseId = generatePresetId(source);
  const id = ensureUniquePresetId(baseId);
  // Include quantization in the display name so users can distinguish variants
  const name = extractModelName(source, { includeQuantization: true });
  const baseName = extractModelName(source);  // Without quantization for description
  
  const preset = {
    id,
    name,
    description: `Auto-generated preset for ${baseName}`,
    modelPath: modelPath || null,
    hfRepo: hfRepo || null,
    context: 0,  // 0 means use server default
    config: {
      chatTemplateKwargs: '',
      reasoningFormat: '',
      temp: 0.7,
      topP: 1.0,
      topK: 20,
      minP: 0,
      extraSwitches: '--jinja'
    },
    autoGenerated: true,
    createdAt: new Date().toISOString()
  };
  
  return preset;
}

/**
 * Auto-create a preset for a model file if one doesn't already exist.
 * 
 * @param {object} options - Configuration options
 * @param {string} options.modelPath - Full path to the model file
 * @param {string} options.hfRepo - HuggingFace repo string (optional)
 * @param {string} options.filename - Model filename
 * @returns {object|null} - The created preset, or null if already exists
 */
function autoCreatePreset({ modelPath, hfRepo, filename }) {
  // Check if a preset already exists for this model
  if (config.presets) {
    for (const preset of Object.values(config.presets)) {
      // Match by model path
      if (modelPath && preset.modelPath === modelPath) {
        console.log(`[presets] Preset already exists for ${filename}: ${preset.id}`);
        return null;
      }
      // Match by hfRepo
      if (hfRepo && preset.hfRepo === hfRepo) {
        console.log(`[presets] Preset already exists for ${hfRepo}: ${preset.id}`);
        return null;
      }
    }
  }
  
  // Create new preset
  const preset = createDefaultPreset({ modelPath, hfRepo, filename });
  
  // Save to config
  if (!config.presets) {
    config.presets = {};
  }
  config.presets[preset.id] = preset;
  saveConfig(config);
  
  console.log(`[presets] Auto-created preset "${preset.id}" for ${filename}`);
  addLog('presets', `Auto-created preset: ${preset.name} (${preset.id})`);
  
  return preset;
}

/**
 * Migrate existing models to presets on server startup.
 * Creates presets for any .gguf files that don't have one.
 */
function migrateExistingModels() {
  const localModels = scanLocalModels();
  let created = 0;
  
  for (const model of localModels) {
    if (model.incomplete) continue;  // Skip incomplete split models
    
    // Skip mmproj (multimodal projection) files - these are auxiliary files, not chat models
    const filename = basename(model.path);
    if (filename.toLowerCase().startsWith('mmproj-') || filename.toLowerCase().startsWith('mmproj_')) {
      console.log(`[presets] Skipping mmproj file: ${model.name}`);
      continue;
    }
    
    const preset = autoCreatePreset({
      modelPath: model.path,
      filename: model.name
    });
    
    if (preset) {
      created++;
    }
  }
  
  if (created > 0) {
    console.log(`[presets] Migration complete: created ${created} preset(s) for existing models`);
    addLog('presets', `Migration: created ${created} preset(s) for existing models`);
  }
}

// ============================================================================
// API Routes
// ============================================================================

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
      defaultReasoningEffort: config.defaultReasoningEffort || null,
      modelReasoningEffort: config.modelReasoningEffort || {},
      fullscreenInterval: config.fullscreenInterval || 30000
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
  const { contextSize, modelsMax, autoStart, noWarmup, flashAttn, gpuLayers, requestLogging, defaultReasoningEffort, modelReasoningEffort, fullscreenInterval } = req.body;

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
      )
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
// Returns presets as the primary model list, with status information
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

    // Build presets list with status information
    // This is the primary model list for unified model configuration
    const presets = config.presets ? Object.values(config.presets).map(preset => {
      const status = getPresetStatus(preset, serverModels);
      const modelPath = resolveModelPath({ type: 'preset', preset });
      
      return {
        id: preset.id,
        name: preset.name,
        description: preset.description || '',
        modelPath: preset.modelPath || null,
        hfRepo: preset.hfRepo || null,
        context: preset.context || 0,
        config: preset.config || {},
        status,  // 'loaded' | 'loading' | 'available' | 'not_downloaded'
        resolvedPath: modelPath  // The actual path used for llama.cpp
      };
    }) : [];

    res.json({
      // Primary model list: presets with status
      models: presets,
      // Keep for backward compatibility during transition
      serverModels,
      localModels,
      modelsDir: MODELS_DIR,
      // Current mode info
      mode: currentMode,
      currentPreset: currentPreset
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Load a model in llama-server (router mode)
// In router mode, models are loaded on-demand when chat completions are requested.
// This endpoint pre-loads a model by making a minimal completion request.
// Accepts both preset IDs and file paths (backward compatible)
app.post('/api/models/load', async (req, res) => {
  const { model } = req.body;

  if (!model) {
    return res.status(400).json({ error: 'Missing model parameter' });
  }

  console.log(`[models/load] Attempting to load model: ${model}`);

  // Use unified model resolution
  const resolved = resolveModel(model);
  let modelPathForLlama = model;
  let displayName = model;

  if (resolved) {
    if (resolved.type === 'preset') {
      const presetModelPath = resolveModelPath(resolved);
      if (!presetModelPath) {
        // Model not downloaded yet
        return res.status(404).json({ 
          error: `Preset "${model}" references a model that is not downloaded yet.`,
          preset: resolved.preset.id,
          hfRepo: resolved.preset.hfRepo
        });
      }
      modelPathForLlama = presetModelPath;
      displayName = resolved.preset.name;
      console.log(`[models/load] Resolved preset "${model}" to path: ${modelPathForLlama}`);
      addLog('models', `Loading preset: ${resolved.preset.name} (${modelPathForLlama})`);
    } else if (resolved.type === 'file') {
      modelPathForLlama = resolved.relativePath;
      console.log(`[models/load] Using file path: ${modelPathForLlama}`);
      addLog('models', `Loading model file: ${modelPathForLlama}`);
    }
  } else {
    // Not found in presets, try as direct file path (backward compat)
    const fullPath = join(MODELS_DIR, model);
    if (!existsSync(fullPath)) {
      console.error(`[models/load] Model not found: ${model}`);
      addLog('models', `Model not found: ${model}`);
      return res.status(404).json({ error: `Model not found: ${model}. Check preset ID or file path.` });
    }
    console.log(`[models/load] Using direct file path: ${model}`);
    addLog('models', `Loading model: ${model}`);
  }

  try {
    // In router mode, trigger model loading by making a minimal completion request
    // llama.cpp will load the model on-demand
    const response = await fetch(`http://localhost:${LLAMA_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelPathForLlama,
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

    console.log(`[models/load] Model loaded successfully: ${displayName}`);
    addLog('models', `Model loaded: ${displayName}`);
    res.json({ 
      success: true, 
      model: modelPathForLlama,
      preset: resolved?.type === 'preset' ? resolved.preset.id : null,
      displayName
    });
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
    
    // Check if file exists directly
    if (!existsSync(fullModelPath)) {
      // Check if this is a split model (name without part suffix)
      // Try to find first part: model.gguf -> model-00001-of-*.gguf
      const basePath = fullModelPath.replace(/\.gguf$/i, '');
      const dirPath = dirname(fullModelPath);
      let foundSplitModel = false;
      
      if (existsSync(dirPath)) {
        const files = readdirSync(dirPath);
        const splitFirstPart = files.find(f => 
          f.startsWith(basename(basePath)) && 
          /-00001-of-\d{5}\.gguf$/i.test(f)
        );
        if (splitFirstPart) {
          fullModelPath = join(dirPath, splitFirstPart);
          foundSplitModel = true;
        }
      }
      
      if (!foundSplitModel) {
        return res.status(404).json({ error: `Model file not found: ${modelPath}` });
      }
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

  // Log the update request for debugging
  const existingPreset = config.presets?.[presetId];
  if (existingPreset) {
    console.log(`[presets] PUT ${presetId} - incoming changes:`);
    if (updates.context !== undefined && updates.context !== existingPreset.context) {
      console.log(`  context: ${existingPreset.context} -> ${updates.context}`);
    }
    if (updates.config?.extraSwitches !== undefined && updates.config?.extraSwitches !== existingPreset.config?.extraSwitches) {
      console.log(`  extraSwitches: "${existingPreset.config?.extraSwitches}" -> "${updates.config?.extraSwitches}"`);
    }
  }

  if (!config.presets || !config.presets[presetId]) {
    return res.status(404).json({ error: `Preset '${presetId}' not found` });
  }

  // If modelPath is being updated, convert relative path to full path
  if (updates.modelPath) {
    const modelPath = updates.modelPath;
    let fullModelPath = modelPath.startsWith('/') ? modelPath : join(MODELS_DIR, modelPath);
    
    // Check if file exists directly
    if (!existsSync(fullModelPath)) {
      // Check if this is a split model (name without part suffix)
      // Try to find first part: model.gguf -> model-00001-of-*.gguf
      const basePath = fullModelPath.replace(/\.gguf$/i, '');
      const dirPath = dirname(fullModelPath);
      let foundSplitModel = false;
      
      if (existsSync(dirPath)) {
        const files = readdirSync(dirPath);
        const splitFirstPart = files.find(f => 
          f.startsWith(basename(basePath)) && 
          /-00001-of-\d{5}\.gguf$/i.test(f)
        );
        if (splitFirstPart) {
          fullModelPath = join(dirPath, splitFirstPart);
          foundSplitModel = true;
        }
      }
      
      if (!foundSplitModel) {
        return res.status(404).json({ error: `Model file not found: ${modelPath}` });
      }
    }
    updates.modelPath = fullModelPath;
  }

  // Check if ID is being changed
  const newId = updates.id;
  if (newId && newId !== presetId) {
    // Validate new ID format
    if (!/^[a-z0-9-]+$/.test(newId)) {
      return res.status(400).json({ error: 'ID must contain only lowercase letters, numbers, and hyphens' });
    }
    // Check for conflicts
    if (config.presets[newId]) {
      return res.status(409).json({ error: `Preset '${newId}' already exists` });
    }
    // Rename: create with new ID, delete old
    config.presets[newId] = {
      ...config.presets[presetId],
      ...updates,
      id: newId
    };
    delete config.presets[presetId];
    saveConfig(config);
    console.log(`[presets] Renamed preset: ${presetId} -> ${newId}`);
    res.json({ success: true, preset: config.presets[newId], renamed: true, oldId: presetId });
  } else {
    // Update in place
    config.presets[presetId] = {
      ...config.presets[presetId],
      ...updates,
      id: presetId
    };
    saveConfig(config);
    console.log(`[presets] Updated preset: ${presetId}`);
    res.json({ success: true, preset: config.presets[presetId] });
  }
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

// Start llama server in router mode (multi-model)
app.post('/api/server/start', async (req, res) => {
  await stopLlamaServer();

  try {
    currentMode = 'router';
    currentPreset = null;

    const startScript = join(PROJECT_ROOT, 'start-llama.sh');
    const contextSize = config.contextSize || 8192;
    const gpuLayers = config.gpuLayers || 99;
    const flashAttn = config.flashAttn || false;
    const modelsMax = config.modelsMax || 2;
    
    const env = {
      ...process.env,
      MODELS_DIR,
      MODELS_MAX: String(modelsMax),
      CONTEXT: String(contextSize),
      PORT: String(LLAMA_PORT),
      NO_WARMUP: config.noWarmup ? '1' : '',
      FLASH_ATTN: flashAttn ? '1' : '',
      GPU_LAYERS: String(gpuLayers),
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

    llamaProcess.on('exit', (code) => {
      addLog('system', `llama-server exited with code ${code}`);
    });

    // Record server configuration for compatibility checks
    serverConfig.context = contextSize;
    serverConfig.gpuLayers = gpuLayers;
    serverConfig.flashAttn = flashAttn;
    serverConfig.modelsMax = modelsMax;
    serverConfig.reasoningFormat = null;
    serverConfig.extraSwitches = '--jinja';
    console.log(`[server/start] Router mode: context=${contextSize}, gpuLayers=${gpuLayers}, flashAttn=${flashAttn}`);

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

    llamaProcess.on('exit', (code) => {
      addLog('system', `llama-server exited with code ${code}`);
      if (code !== 0) {
        currentMode = 'router';
        currentPreset = null;
      }
    });

    // Record server configuration for compatibility checks
    const presetContext = preset.context || config.contextSize || 8192;
    const presetGpuLayers = preset.config?.gpuLayers !== undefined ? preset.config.gpuLayers : (config.gpuLayers || 99);
    const presetFlashAttn = preset.config?.flashAttn !== undefined ? preset.config.flashAttn : (config.flashAttn || false);
    const presetReasoningFormat = preset.config?.reasoningFormat || null;
    const presetExtraSwitches = preset.config?.extraSwitches || '--jinja';
    
    serverConfig.context = presetContext;
    serverConfig.gpuLayers = presetGpuLayers;
    serverConfig.flashAttn = presetFlashAttn;
    serverConfig.modelsMax = 1; // Single model mode
    serverConfig.reasoningFormat = presetReasoningFormat;
    serverConfig.extraSwitches = presetExtraSwitches;
    console.log(`[presets/activate] Preset mode: context=${presetContext}, gpuLayers=${presetGpuLayers}, flashAttn=${presetFlashAttn}`);

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
        
        // Auto-create presets for downloaded GGUF files
        try {
          const ggufFiles = readdirSync(targetDir).filter(f => f.endsWith('.gguf'));
          for (const ggufFile of ggufFiles) {
            const relativePath = join(basename(targetDir), ggufFile);
            const preset = autoCreatePreset(relativePath);
            if (preset) {
              addLog('download', `Auto-created preset "${preset.id}" for ${ggufFile}`);
            }
          }
        } catch (presetErr) {
          console.error(`[download] Failed to auto-create presets: ${presetErr.message}`);
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
    tokenStats: {
      totalPromptTokens: tokenStats.totalPromptTokens,
      totalCompletionTokens: tokenStats.totalCompletionTokens,
      totalRequests: tokenStats.totalRequests,
      averageTokensPerSecond: tokenStats.recentRequests.length > 0
        ? tokenStats.recentRequests.reduce((sum, r) => sum + r.tokensPerSecond, 0) / tokenStats.recentRequests.length
        : 0
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

      // Merge status codes across bucket
      const mergedSc = {};
      for (const item of items) {
        for (const [code, count] of Object.entries(item.sc || {})) {
          mergedSc[code] = (mergedSc[code] || 0) + count;
        }
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
        sc: mergedSc,
        tp: sum('tp'),
        tcc: sum('tcc')
      });
    }
    points.sort((a, b) => a.ts - b.ts);
  }

  // Compute summary
  const totalRequests = points.reduce((s, p) => s + (p.rT || 0), 0);
  const totalErrors = points.reduce((s, p) => s + (p.rErr || 0), 0);
  const tpsPoints = points.filter(p => p.tps > 0);
  const avgTps = tpsPoints.length > 0 ? tpsPoints.reduce((s, p) => s + p.tps, 0) / tpsPoints.length : 0;
  const allStatusCodes = {};
  for (const p of points) {
    for (const [code, count] of Object.entries(p.sc || {})) {
      allStatusCodes[code] = (allStatusCodes[code] || 0) + count;
    }
  }

  res.json({
    points,
    summary: {
      totalRequests,
      totalErrors,
      avgTps: Math.round(avgTps * 10) / 10,
      statusCodes: allStatusCodes
    }
  });
});

// OpenAI-compatible models endpoint - returns presets as the primary model list
// Presets are the unified model abstraction; clients use preset IDs as model identifiers
app.get('/api/v1/models', async (req, res) => {
  try {
    // Get loaded models from llama.cpp for status info
    let loadedModels = {};
    try {
      const response = await fetch(`http://localhost:${LLAMA_PORT}/models`);
      if (response.ok) {
        const llamaModels = await response.json();
        // Build a map of model path -> status for quick lookup
        for (const m of (llamaModels.data || [])) {
          loadedModels[m.id] = m.status?.value || 'available';
        }
      }
    } catch (e) {
      // llama.cpp not running, all models will show as 'available'
    }

    // Return presets as the model list
    const presets = config.presets || {};
    const presetList = Object.values(presets);

    // Helper to determine if a preset's model is loaded
    const getPresetStatus = (preset) => {
      // Check by model path (relative or absolute)
      const modelPath = preset.modelPath || '';
      const relativePath = modelPath.replace(MODELS_DIR + '/', '').replace(MODELS_DIR, '');
      
      // Check if this model is loaded in llama.cpp
      for (const [id, status] of Object.entries(loadedModels)) {
        if (id === relativePath || id === modelPath || modelPath.endsWith('/' + id)) {
          return status === 'loaded' ? 'loaded' : 'available';
        }
      }
      return 'available';
    };

    const data = {
      object: 'list',
      data: presetList.map(preset => ({
        // Preset ID is the model identifier for API requests
        id: preset.id,
        object: 'model',
        created: preset.createdAt ? Math.floor(new Date(preset.createdAt).getTime() / 1000) : Math.floor(Date.now() / 1000),
        owned_by: 'llama-manager',
        // Preset metadata
        meta: {
          name: preset.name,
          description: preset.description,
          modelPath: preset.modelPath,
          hfRepo: preset.hfRepo,
          context: preset.context,
          autoGenerated: preset.autoGenerated
        },
        n_ctx: preset.context || config.contextSize || 8192,
        // Display info
        displayName: preset.name || preset.id,
        status: getPresetStatus(preset),
        // For backward compat
        alias: preset.name !== preset.id ? preset.name : null
      }))
    };
    res.json(data);
  } catch (error) {
    console.error('[v1/models] Error building preset list:', error.message);
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

// Retry fetch with backoff for transient connection failures (e.g. model switching in router mode)
async function fetchWithRetry(url, options, { retries = 3, baseDelay = 1000, label = 'proxy' } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`[${label}] Connection failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
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
// Supports preset IDs and file paths as model identifiers
app.post('/api/v1/chat/completions', async (req, res) => {
  const startTime = Date.now();
  const isStreaming = req.body.stream === true;
  const requestedModel = req.body.model || 'default';

  console.log(`[chat/completions] Request for model: ${requestedModel}`);

  // Resolve preset ID to model path and apply preset configuration
  const { body: resolvedBody, resolved, modelPath } = prepareProxyRequest(req.body);
  
  // Check if preset requires server restart due to incompatible config
  if (resolved?.type === 'preset') {
    const compat = isCompatible(resolved.preset);
    if (!compat.compatible) {
      console.log(`[chat/completions] Preset "${resolved.preset.id}" incompatible: ${compat.reasons.join(', ')}`);
      addLog('chat', `Restarting server for preset "${resolved.preset.id}": ${compat.reasons.join(', ')}`);
      
      const restartResult = await restartForPreset(resolved.preset);
      if (!restartResult.success) {
        console.error(`[chat/completions] Server restart failed: ${restartResult.error}`);
        return res.status(503).json({
          error: {
            message: `Server restart failed: ${restartResult.error}`,
            type: 'server_error',
            code: 'restart_failed'
          }
        });
      }
    }
  }
  
  // Inject reasoning_effort if configured (after preset resolution)
  const proxyBody = injectReasoningEffort(resolvedBody);

  // Log preset resolution for debugging
  if (resolved?.type === 'preset') {
    console.log(`[chat/completions] Preset "${resolved.preset.id}" resolved to "${modelPath}"`);
    addLog('chat', `Using preset: ${resolved.preset.name}`);
  }

  async function doFetch(body) {
    return fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, { label: 'chat/completions' });
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
              addLlmLog({
                endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
                status: response.status, duration: Date.now() - startTime,
                promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
                messages: req.body.messages || null, prompt: null, response: null, error: retryError,
                requestBody: req.body
              });
              return res.status(response.status).send(retryError);
            }
          }
        } else {
          // Couldn't unload, return original error
          console.error(`[chat/completions] Error ${response.status} for model ${requestedModel}: ${errorText}`);
          addLog('chat', `Chat completion failed for model ${requestedModel}: ${errorText}`);
          addLlmLog({
            endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
            status: response.status, duration: Date.now() - startTime,
            promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
            messages: req.body.messages || null, prompt: null, response: null, error: errorText,
            requestBody: req.body
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
        addLlmLog({
          endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
          status: response.status, duration: Date.now() - startTime,
          promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
          messages: req.body.messages || null, prompt: null, response: null, error: errorText,
          requestBody: req.body
        });
        return res.status(response.status).send(errorText);
      }
    }

    if (!response.ok) {
      const error = await response.text();
      console.error(`[chat/completions] Error ${response.status} for model ${requestedModel}: ${error}`);
      addLog('chat', `Chat completion failed for model ${requestedModel}: ${error}`);
      addLlmLog({
        endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
        status: response.status, duration: Date.now() - startTime,
        promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
        messages: req.body.messages || null, prompt: null, response: null, error,
        requestBody: req.body
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
                  if (data.choices?.[0]?.delta?.content) {
                    completionTokens++;
                    responseText += data.choices[0].delta.content;
                  }
                  if (data.usage) {
                    promptTokens = data.usage.prompt_tokens || promptTokens;
                    completionTokens = data.usage.completion_tokens || completionTokens;
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
          const duration = Date.now() - startTime;
          const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
          recordTokenStats({
            promptTokens,
            completionTokens,
            tokensPerSecond,
            model,
            duration
          });
          addLlmLog({
            endpoint: 'chat/completions', model, stream: true,
            status: 200, duration, promptTokens, completionTokens,
            tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
            messages: req.body.messages || null, prompt: null,
            response: responseText, error: null, requestBody: null
          });
        } catch (e) {
          console.error('[proxy] Stream error:', e);
          res.end();
        }
      };

      processStream();
    } else {
      // Non-streaming response
      const data = await response.json();

      // Extract token stats from response
      const duration = Date.now() - startTime;
      const usage = data.usage || {};
      const promptTokens = usage.prompt_tokens || 0;
      const completionTokens = usage.completion_tokens || 0;
      const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;

      recordTokenStats({
        promptTokens,
        completionTokens,
        tokensPerSecond,
        model: data.model || req.body.model || 'unknown',
        duration
      });

      addLlmLog({
        endpoint: 'chat/completions', model: data.model || req.body.model || 'unknown',
        stream: false, status: 200, duration, promptTokens, completionTokens,
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
        messages: req.body.messages || null, prompt: null,
        response: data.choices?.[0]?.message?.content || null, error: null, requestBody: null
      });

      // Add our tracking info to response
      data._llama_manager = {
        duration,
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10
      };

      res.json(data);
    }
  } catch (error) {
    addLlmLog({
      endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
      status: 502, duration: Date.now() - startTime,
      promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
      messages: req.body.messages || null, prompt: null,
      response: null, error: error.message, requestBody: req.body
    });
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
});

// OpenAI-compatible completions (legacy endpoint)
// Supports preset IDs and file paths as model identifiers
app.post('/api/v1/completions', async (req, res) => {
  const startTime = Date.now();
  const requestedModel = req.body.model || 'unknown';
  const isStreaming = req.body.stream === true;

  // Resolve preset ID to model path and apply preset configuration
  const { body: proxyBody, resolved, modelPath } = prepareProxyRequest(req.body);

  // Check if preset requires server restart due to incompatible config
  if (resolved?.type === 'preset') {
    const compat = isCompatible(resolved.preset);
    if (!compat.compatible) {
      console.log(`[completions] Preset "${resolved.preset.id}" incompatible: ${compat.reasons.join(', ')}`);
      const restartResult = await restartForPreset(resolved.preset);
      if (!restartResult.success) {
        return res.status(503).json({
          error: { message: `Server restart failed: ${restartResult.error}`, type: 'server_error', code: 'restart_failed' }
        });
      }
    }
  }

  // Log preset resolution for debugging
  if (resolved?.type === 'preset') {
    console.log(`[completions] Preset "${resolved.preset.id}" resolved to "${modelPath}"`);
  }

  try {
    const response = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proxyBody)
    }, { label: 'completions' });

    if (!response.ok) {
      const error = await response.text();
      addLlmLog({
        endpoint: 'completions', model: requestedModel, stream: isStreaming,
        status: response.status, duration: Date.now() - startTime,
        promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
        messages: null, prompt: req.body.prompt || null, response: null, error,
        requestBody: req.body
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

            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.choices?.[0]?.text) {
                    responseText += data.choices[0].text;
                  }
                } catch (e) { /* skip */ }
              }
            }
            tokens++;
          }
          res.end();

          const duration = Date.now() - startTime;
          const tokensPerSecond = duration > 0 ? tokens / (duration / 1000) : 0;
          recordTokenStats({
            promptTokens: 0,
            completionTokens: tokens,
            tokensPerSecond,
            model: requestedModel,
            duration
          });
          addLlmLog({
            endpoint: 'completions', model: requestedModel, stream: true,
            status: 200, duration, promptTokens: 0, completionTokens: tokens,
            tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
            messages: null, prompt: req.body.prompt || null,
            response: responseText, error: null, requestBody: null
          });
        } catch (e) {
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

      recordTokenStats({
        promptTokens,
        completionTokens,
        tokensPerSecond,
        model: data.model || requestedModel,
        duration
      });

      addLlmLog({
        endpoint: 'completions', model: data.model || requestedModel,
        stream: false, status: 200, duration, promptTokens, completionTokens,
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
        messages: null, prompt: req.body.prompt || null,
        response: data.choices?.[0]?.text || null, error: null, requestBody: null
      });

      res.json(data);
    }
  } catch (error) {
    addLlmLog({
      endpoint: 'completions', model: requestedModel, stream: isStreaming,
      status: 502, duration: Date.now() - startTime,
      promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
      messages: null, prompt: req.body.prompt || null,
      response: null, error: error.message, requestBody: req.body
    });
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
});

// OpenAI-compatible embeddings endpoint
// Supports preset IDs and file paths as model identifiers
app.post('/api/v1/embeddings', async (req, res) => {
  // Resolve preset ID to model path
  const { body: proxyBody, resolved, modelPath } = prepareProxyRequest(req.body);

  // Check if preset requires server restart due to incompatible config
  if (resolved?.type === 'preset') {
    const compat = isCompatible(resolved.preset);
    if (!compat.compatible) {
      console.log(`[embeddings] Preset "${resolved.preset.id}" incompatible: ${compat.reasons.join(', ')}`);
      const restartResult = await restartForPreset(resolved.preset);
      if (!restartResult.success) {
        return res.status(503).json({
          error: { message: `Server restart failed: ${restartResult.error}`, type: 'server_error', code: 'restart_failed' }
        });
      }
    }
  }

  // Log preset resolution for debugging
  if (resolved?.type === 'preset') {
    console.log(`[embeddings] Preset "${resolved.preset.id}" resolved to "${modelPath}"`);
  }

  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proxyBody)
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
// Supports preset IDs and file paths as model identifiers
app.post('/api/v1/responses', async (req, res) => {
  const startTime = Date.now();
  const isStreaming = req.body.stream === true;
  const requestedModel = req.body.model || 'default';

  console.log(`[responses] Request for model: ${requestedModel}`);

  // Resolve preset ID to model path and apply preset configuration
  const { body: resolvedBody, resolved, modelPath } = prepareProxyRequest(req.body);

  // Check if preset requires server restart due to incompatible config
  if (resolved?.type === 'preset') {
    const compat = isCompatible(resolved.preset);
    if (!compat.compatible) {
      console.log(`[responses] Preset "${resolved.preset.id}" incompatible: ${compat.reasons.join(', ')}`);
      addLog('responses', `Restarting server for preset "${resolved.preset.id}": ${compat.reasons.join(', ')}`);
      
      const restartResult = await restartForPreset(resolved.preset);
      if (!restartResult.success) {
        return res.status(503).json({
          error: { message: `Server restart failed: ${restartResult.error}`, type: 'server_error', code: 'restart_failed' }
        });
      }
    }
  }

  // Log preset resolution for debugging
  if (resolved?.type === 'preset') {
    console.log(`[responses] Preset "${resolved.preset.id}" resolved to "${modelPath}"`);
    addLog('responses', `Using preset: ${resolved.preset.name}`);
  }

  // Inject reasoning_effort if configured (after preset resolution)
  const proxyBody = injectReasoningEffort(resolvedBody);

  try {
    let response = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proxyBody)
    }, { label: 'responses' });

    // If model failed to load, unload others and retry
    if (!response.ok) {
      const error = await response.text();
      if (isModelLoadFailure(response.status, error)) {
        console.log(`[responses] Model load failure for ${requestedModel}, attempting to free memory`);
        const unloaded = await unloadOtherModels(requestedModel);
        if (unloaded) {
          response = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/responses`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(proxyBody)
          }, { label: 'responses' });
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
          prompt: null, response: null, error: retryError, requestBody: req.body
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
            prompt: null, response: responseText, error: null, requestBody: null
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
        prompt: null, response: respText, error: null, requestBody: null
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
      prompt: null, response: null, error: error.message, requestBody: req.body
    });
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
});

// Anthropic Messages API compatibility (proxied to llama.cpp)
// Supports preset IDs and file paths as model identifiers
app.post('/api/v1/messages', async (req, res) => {
  const startTime = Date.now();
  const isStreaming = req.body.stream === true;
  const requestedModel = req.body.model || 'default';

  console.log(`[messages] Request for model: ${requestedModel}`);

  // Resolve preset ID to model path and apply preset configuration
  const { body: resolvedBody, resolved, modelPath } = prepareProxyRequest(req.body);

  // Check if preset requires server restart due to incompatible config
  if (resolved?.type === 'preset') {
    const compat = isCompatible(resolved.preset);
    if (!compat.compatible) {
      console.log(`[messages] Preset "${resolved.preset.id}" incompatible: ${compat.reasons.join(', ')}`);
      addLog('messages', `Restarting server for preset "${resolved.preset.id}": ${compat.reasons.join(', ')}`);
      
      const restartResult = await restartForPreset(resolved.preset);
      if (!restartResult.success) {
        return res.status(503).json({
          error: { message: `Server restart failed: ${restartResult.error}`, type: 'server_error', code: 'restart_failed' }
        });
      }
    }
  }

  // Log preset resolution for debugging
  if (resolved?.type === 'preset') {
    console.log(`[messages] Preset "${resolved.preset.id}" resolved to "${modelPath}"`);
    addLog('messages', `Using preset: ${resolved.preset.name}`);
  }

  // Inject reasoning_effort if configured (after preset resolution)
  const proxyBody = injectReasoningEffort(resolvedBody);

  try {
    let response = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proxyBody)
    }, { label: 'messages' });

    // If model failed to load, unload others and retry
    if (!response.ok) {
      const error = await response.text();
      if (isModelLoadFailure(response.status, error)) {
        console.log(`[messages] Model load failure for ${requestedModel}, attempting to free memory`);
        const unloaded = await unloadOtherModels(requestedModel);
        if (unloaded) {
          response = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(proxyBody)
          }, { label: 'messages' });
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
          requestBody: req.body
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
            response: responseText, error: null, requestBody: null
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
        response: data.content?.[0]?.text || null, error: null, requestBody: null
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
      response: null, error: error.message, requestBody: req.body
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

  // Auto-create presets for any existing models that don't have one
  migrateExistingModels();

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
