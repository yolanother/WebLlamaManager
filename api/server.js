import express from 'express';
import cors from 'cors';
import { spawn, exec } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(__dirname);

const app = express();
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

// State
let llamaProcess = null;
let downloadProcesses = new Map();

// Ensure models directory exists
if (!existsSync(MODELS_DIR)) {
  mkdirSync(MODELS_DIR, { recursive: true });
}

// Load or initialize config
function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  }
  const defaultConfig = {
    autoStart: true,
    modelsMax: 2,
    contextSize: 8192
  };
  saveConfig(defaultConfig);
  return defaultConfig;
}

function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let config = loadConfig();

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

// Start llama server
app.post('/api/server/start', async (req, res) => {
  // Stop existing process if running
  if (llamaProcess && !llamaProcess.killed) {
    llamaProcess.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  try {
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
      console.log(`[llama] ${data}`);
    });
    llamaProcess.stderr.on('data', (data) => {
      console.error(`[llama] ${data}`);
    });

    llamaProcess.on('exit', (code) => {
      console.log(`llama-server exited with code ${code}`);
    });

    res.json({ success: true, pid: llamaProcess.pid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stop llama server
app.post('/api/server/stop', async (req, res) => {
  if (!llamaProcess || llamaProcess.killed) {
    return res.json({ success: true, message: 'Server not running' });
  }

  llamaProcess.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 1000));

  if (!llamaProcess.killed) {
    llamaProcess.kill('SIGKILL');
  }

  res.json({ success: true });
});

// Download a model from HuggingFace to ~/models
app.post('/api/pull', async (req, res) => {
  const { repo, filename, quantization } = req.body;

  if (!repo) {
    return res.status(400).json({ error: 'Missing repo parameter' });
  }

  // If filename specified, download that specific file
  // Otherwise, search for a GGUF file matching the quantization
  const downloadId = filename ? `${repo}/${filename}` : `${repo}:${quantization || 'Q5_K_M'}`;

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
    // Build the huggingface-cli command
    // Downloads to ~/models with repo structure
    const targetDir = join(MODELS_DIR, repo.replace('/', '_'));
    mkdirSync(targetDir, { recursive: true });

    let downloadCommand;
    if (filename) {
      // Download specific file
      downloadCommand = `huggingface-cli download "${repo}" "${filename}" --local-dir "${targetDir}" --local-dir-use-symlinks False`;
    } else {
      // Download files matching quantization pattern
      const quant = quantization || 'Q5_K_M';
      downloadCommand = `huggingface-cli download "${repo}" --include "*${quant}*.gguf" --local-dir "${targetDir}" --local-dir-use-symlinks False`;
    }

    console.log(`[download] Starting: ${downloadCommand}`);

    const downloadProcess = spawn('distrobox', [
      'enter', CONTAINER_NAME, '--',
      'bash', '-c',
      `export HF_HUB_ENABLE_HF_TRANSFER=1 && ${downloadCommand} 2>&1`
    ], {
      cwd: PROJECT_ROOT
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
app.get('/api/repo/:author/:model/files', async (req, res) => {
  const { author, model } = req.params;

  try {
    const filesUrl = `https://huggingface.co/api/models/${author}/${model}/tree/main`;
    const response = await fetch(filesUrl);

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch repo files' });
    }

    const files = await response.json();

    // Filter to GGUF files and extract info
    const ggufFiles = files
      .filter(f => f.path && f.path.endsWith('.gguf'))
      .map(f => ({
        path: f.path,
        size: f.size,
        // Extract quantization from filename
        quantization: extractQuantization(f.path)
      }));

    res.json({ files: ggufFiles });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function extractQuantization(filename) {
  const patterns = [
    /[-_](Q\d+_K(?:_[SML])?)/i,
    /[-_](IQ\d+_[A-Z]+)/i,
    /[-_](F16|F32|BF16)/i,
    /[-_](Q\d+_0)/i
  ];

  for (const pattern of patterns) {
    const match = filename.match(pattern);
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

// Catch-all for SPA routing
app.get('*', (req, res) => {
  if (existsSync(join(UI_BUILD_PATH, 'index.html'))) {
    res.sendFile(join(UI_BUILD_PATH, 'index.html'));
  } else {
    res.status(404).json({ error: 'UI not built. Run: cd ui && npm install && npm run build' });
  }
});

// Start the API server
app.listen(API_PORT, '0.0.0.0', () => {
  console.log(`Llama Manager API running on http://0.0.0.0:${API_PORT}`);
  console.log(`Models directory: ${MODELS_DIR}`);
  console.log(`Llama server will run on port ${LLAMA_PORT}`);

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
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  if (llamaProcess && !llamaProcess.killed) {
    llamaProcess.kill('SIGTERM');
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  if (llamaProcess && !llamaProcess.killed) {
    llamaProcess.kill('SIGTERM');
  }
  process.exit(0);
});
