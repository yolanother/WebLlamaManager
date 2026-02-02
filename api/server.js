import express from 'express';
import cors from 'cors';
import { spawn, exec, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { cpus, totalmem, freemem, loadavg } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(__dirname);

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

app.use(cors());
app.use(express.json());

// Serve static files from the UI build
const UI_BUILD_PATH = join(PROJECT_ROOT, 'ui', 'dist');
if (existsSync(UI_BUILD_PATH)) {
  app.use(express.static(UI_BUILD_PATH));
}

// Configuration
const CONFIG_PATH = join(PROJECT_ROOT, 'config.json');
const MODELS_DIR = process.env.MODELS_DIR || join(process.env.HOME, 'models');
const CONTAINER_NAME = 'llama-rocm-7rc-rocwmma';
const API_PORT = process.env.API_PORT || 3001;
const LLAMA_PORT = process.env.LLAMA_PORT || 8080;
const LLAMA_UI_URL = process.env.LLAMA_UI_URL || null; // Optional override for llama.cpp UI URL

// State
let llamaProcess = null;
let downloadProcesses = new Map();
let currentMode = 'router'; // 'router' or 'single'
let currentPreset = null;

// Log buffer (circular buffer for recent logs)
const MAX_LOG_LINES = 500;
let logBuffer = [];

function addLog(source, message) {
  const timestamp = new Date().toISOString();
  const lines = message.toString().split('\n').filter(l => l.trim());
  for (const line of lines) {
    const logEntry = { timestamp, source, message: line };
    logBuffer.push(logEntry);
    if (logBuffer.length > MAX_LOG_LINES) {
      logBuffer.shift();
    }
    // Broadcast to connected WebSocket clients
    broadcastLog(logEntry);
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

// Optimized single-model presets
// These use specific configurations not supported in router mode
const OPTIMIZED_PRESETS = {
  gpt120: {
    id: 'gpt120',
    name: 'GPT-OSS 120B',
    description: 'Large reasoning model with high effort mode',
    repo: 'Unsloth/gpt-oss-120b-GGUF',
    quantization: 'Q5_K_M',
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
    repo: 'Unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
    quantization: 'Q5_K_M',
    context: 0, // Use model default
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
    repo: 'Qwen/Qwen2.5-Coder-32B-Instruct-GGUF',
    quantization: 'Q5_K_M',
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
  if (existsSync(CONFIG_PATH)) {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  }
  // Use environment variables for defaults
  const defaultConfig = {
    autoStart: process.env.AUTO_START !== 'false',
    modelsMax: parseInt(process.env.MODELS_MAX) || 2,
    contextSize: parseInt(process.env.CONTEXT_SIZE) || 8192
  };
  saveConfig(defaultConfig);
  return defaultConfig;
}

function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let config = loadConfig();

// WebSocket stats broadcasting
const STATS_INTERVAL = parseInt(process.env.STATS_INTERVAL) || 1000; // Default 1 second
let statsInterval = null;
let connectedClients = new Set();

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

  // Get GPU/VRAM stats from rocm-smi inside the container
  let gpuStats = null;
  try {
    gpuStats = await getGpuStats();
  } catch (e) {
    // GPU stats not available
  }

  // Get llama.cpp specific stats if running
  let llamaStats = null;
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/health`);
    if (response.ok) {
      llamaStats = await response.json();
    }
  } catch {
    // Server not running
  }

  return {
    timestamp: Date.now(),
    cpu: {
      usage: Math.round(cpuUsage * 10) / 10,
      cores: cpuCores.length,
      loadAvg: loadavg()
    },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      usage: Math.round(memUsage * 10) / 10
    },
    gpu: gpuStats,
    llama: llamaStats,
    llamaPort: LLAMA_PORT,
    llamaUiUrl: LLAMA_UI_URL,
    mode: currentMode,
    preset: currentPreset ? OPTIMIZED_PRESETS[currentPreset] : null,
    downloads: Object.fromEntries(
      Array.from(downloadProcesses.entries()).map(([id, info]) => [
        id,
        { progress: info.progress, status: info.status, error: info.error }
      ])
    )
  };
}

async function getGpuStats() {
  return new Promise((resolve, reject) => {
    const cmd = spawn('/usr/local/bin/distrobox', [
      'enter', CONTAINER_NAME, '--',
      'bash', '-c',
      'rocm-smi --showmeminfo vram --showuse --showtemp --json 2>/dev/null || echo "{}"'
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
          resolve({
            temperature: parseFloat(card['Temperature (Sensor edge) (C)'] || card.temperature || 0),
            usage: parseFloat(card['GPU use (%)'] || card.gpu_use || 0),
            vram: {
              total: vramTotal,
              used: vramUsed,
              usage: vramUsage
            }
          });
        } else {
          // Try alternative parsing for different rocm-smi versions
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });

    cmd.on('error', () => resolve(null));
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

// Scan local models directory
function scanLocalModels() {
  const models = [];

  function scanDir(dir, prefix = '') {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath, prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.name.endsWith('.gguf')) {
        const stats = statSync(fullPath);
        models.push({
          name: prefix ? `${prefix}/${entry.name}` : entry.name,
          path: fullPath,
          size: stats.size,
          modified: stats.mtime
        });
      }
    }
  }

  scanDir(MODELS_DIR);
  return models;
}

// API Routes

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
      currentPreset: currentPreset ? OPTIMIZED_PRESETS[currentPreset] : null,
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
      currentPreset: currentPreset ? OPTIMIZED_PRESETS[currentPreset] : null,
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
      modelsDir: MODELS_DIR
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Load a model in llama-server
app.post('/api/models/load', async (req, res) => {
  const { model } = req.body;

  if (!model) {
    return res.status(400).json({ error: 'Missing model parameter' });
  }

  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).json({ error });
    }

    const data = await response.json();
    res.json({ success: true, ...data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Unload a model from llama-server
app.post('/api/models/unload', async (req, res) => {
  const { model } = req.body;

  if (!model) {
    return res.status(400).json({ error: 'Missing model parameter' });
  }

  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).json({ error });
    }

    const data = await response.json();
    res.json({ success: true, ...data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get available presets
app.get('/api/presets', (req, res) => {
  res.json({
    presets: Object.values(OPTIMIZED_PRESETS),
    currentPreset: currentPreset,
    mode: currentMode
  });
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

  // Kill any llama-server processes running on our port inside the container
  // This ensures we don't have orphaned processes from previous runs
  console.log(`[stop] Killing llama-server processes on port ${LLAMA_PORT}...`);

  await new Promise((resolve) => {
    const killCommand = `pkill -9 -f "llama-server.*--port[[:space:]]+${LLAMA_PORT}" || pkill -9 -f "llama-server.*--port ${LLAMA_PORT}" || true`;

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
    const env = {
      ...process.env,
      MODELS_DIR,
      MODELS_MAX: String(config.modelsMax || 2),
      CONTEXT: String(config.contextSize || 8192),
      PORT: String(LLAMA_PORT)
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

    res.json({ success: true, mode: 'router', pid: llamaProcess.pid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Activate an optimized preset (single-model mode)
app.post('/api/presets/:presetId/activate', async (req, res) => {
  const { presetId } = req.params;
  const preset = OPTIMIZED_PRESETS[presetId];

  if (!preset) {
    return res.status(404).json({ error: `Preset '${presetId}' not found` });
  }

  await stopLlamaServer();

  try {
    currentMode = 'single';
    currentPreset = presetId;

    // Start single-model server with preset configuration
    const startScript = join(PROJECT_ROOT, 'start-single-model.sh');
    const env = {
      ...process.env,
      PRESET_ID: presetId,
      PORT: String(LLAMA_PORT)
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
      if (code !== 0) {
        currentMode = 'router';
        currentPreset = null;
      }
    });

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

// Download a model from HuggingFace to ~/models
// Automatically downloads all parts for split models
app.post('/api/pull', async (req, res) => {
  const { repo, quantization } = req.body;

  if (!repo) {
    return res.status(400).json({ error: 'Missing repo parameter' });
  }

  if (!quantization) {
    return res.status(400).json({ error: 'Missing quantization parameter' });
  }

  const downloadId = `${repo}:${quantization}`;

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

  const downloadInfo = { progress: 0, status: 'starting', output: '', error: null };
  downloadProcesses.set(downloadId, downloadInfo);

  try {
    // Downloads to ~/models with repo structure
    const targetDir = join(MODELS_DIR, repo.replace('/', '_'));
    mkdirSync(targetDir, { recursive: true });

    // Build pattern to match quantization (case-insensitive via shell)
    // This will match both single files and split files (e.g., *Q5_K_M*.gguf)
    const quant = quantization.toUpperCase();
    // Use case-insensitive pattern by matching both cases
    const quantLower = quantization.toLowerCase();
    const includePattern = `*[${quant[0]}${quant[0].toLowerCase()}]${quant.slice(1)}*.gguf *[${quantLower[0]}${quantLower[0].toUpperCase()}]${quantLower.slice(1)}*.gguf`;

    // Simpler approach: just use the quantization directly, HF CLI handles it
    const downloadCommand = `huggingface-cli download "${repo}" --include "*${quant}*.gguf" "*${quantLower}*.gguf" --local-dir "${targetDir}" --local-dir-use-symlinks False`;

    console.log(`[download] Starting: ${downloadCommand}`);

    const downloadProcess = spawn('/usr/local/bin/distrobox', [
      'enter', CONTAINER_NAME, '--',
      'bash', '-c',
      `export HF_HUB_ENABLE_HF_TRANSFER=1 && ${downloadCommand} 2>&1`
    ], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' }
    });

    downloadProcess.stdout.on('data', (data) => {
      const output = data.toString();
      downloadInfo.output += output;
      downloadInfo.status = 'downloading';

      // Parse progress from huggingface-cli output
      const progressMatch = output.match(/(\d+)%/);
      if (progressMatch) {
        downloadInfo.progress = parseInt(progressMatch[1]);
      }

      // Check for completion indicators
      if (output.includes('Download complete') || output.includes('already exists')) {
        downloadInfo.progress = 100;
      }

      console.log(`[download] ${output}`);
    });

    downloadProcess.stderr.on('data', (data) => {
      const output = data.toString();
      downloadInfo.output += output;
      console.error(`[download] ${output}`);
    });

    downloadProcess.on('exit', (code) => {
      if (code === 0) {
        downloadInfo.status = 'completed';
        downloadInfo.progress = 100;
      } else {
        downloadInfo.status = 'failed';
        downloadInfo.error = `Process exited with code ${code}`;
      }
      // Keep the info for 5 minutes then clean up
      setTimeout(() => downloadProcesses.delete(downloadId), 300000);
    });

    res.json({ success: true, downloadId, status: 'started', targetDir });
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
    error: info.error
  });
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
// Groups multi-part files together
app.get('/api/repo/:author/:model/files', async (req, res) => {
  const { author, model } = req.params;

  try {
    const filesUrl = `https://huggingface.co/api/models/${author}/${model}/tree/main`;
    const response = await fetch(filesUrl);

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch repo files' });
    }

    const files = await response.json();

    // Filter to GGUF files
    const ggufFiles = files.filter(f => f.path && f.path.endsWith('.gguf'));

    // Group files by quantization (handling multi-part files)
    const quantizations = new Map();

    for (const file of ggufFiles) {
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
    const result = Array.from(quantizations.values())
      .sort((a, b) => a.quantization.localeCompare(b.quantization));

    res.json({ quantizations: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

// Get server logs
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = logBuffer.slice(-limit);
  res.json({ logs });
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

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down...');
  await stopLlamaServer();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down...');
  await stopLlamaServer();
  process.exit(0);
});
