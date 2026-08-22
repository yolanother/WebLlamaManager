// Llama Manager — product documentation page.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Presents setup, integration, API usage, and feature documentation with
// copyable examples in responsive glass navigation and content panels.

import React, { useState, useEffect } from 'react';
import { API_BASE, copyTextToClipboard } from '../api.js';
import '../styles/pages.css';

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
          className={`docs-copy-btn glass-btn ${copiedCode === id ? 'copied' : ''}`}
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
    { id: 'local-cli', title: 'Local CLI' },
    { id: 'mcp-setup', title: 'MCP Setup' },
    { id: 'api-usage', title: 'API Usage' },
    { id: 'features', title: 'Features' },
  ];

  return (
    <div className="page docs-page">
      <div className="docs-layout">
        <nav className="docs-sidebar glass-panel">
          <div className="docs-nav">
            {sections.map(section => (
              <button
                key={section.id}
                className={`docs-nav-item glass-btn ${activeSection === section.id ? 'active' : ''}`}
                onClick={() => setActiveSection(section.id)}
              >
                {section.title}
              </button>
            ))}
          </div>
        </nav>

        <div className="docs-content glass-panel">
          {activeSection === 'overview' && (
            <section className="docs-section">
              <h2>Overview</h2>
              <p>
                Llama Manager is a control plane for local LLM inference on an AMD Strix Halo (gfx1151)
                box. It runs <strong>multiple inference engines</strong> behind one OpenAI-compatible API,
                routes and offloads requests across local and remote backends, and protects a
                thermally- and memory-constrained shared CPU+iGPU box from the failure modes that
                actually happen on this hardware. It provides a web UI, REST API, and MCP server for
                AI agent integration.
              </p>

              <h3>Key Features</h3>
              <ul>
                <li><strong>Multi-engine</strong>: llama.cpp (multi-model router or single preset) and <strong>DS4 / DeepSeek V4 Flash</strong> — a preset picks its engine</li>
                <li><strong>DeepSeek V4 Flash</strong>: an 80&nbsp;GB model upstream llama.cpp can't load, run on the iGPU with adaptive context scaling + SSD expert-streaming that fits it to the box</li>
                <li><strong>Preferred big/small models</strong>: <code>default-big</code> / <code>default-small</code> aliases retarget your whole fleet centrally — migrate clients between models and engines with no client change</li>
                <li><strong>Smart remote offload</strong>: forward to remote OpenAI-compatible backends by queue depth, thermal state, or policy; protect-resident anti-thrash keeps the big model loaded</li>
                <li><strong>Stability guards</strong>: memory watchdog, thermal governor, restart governor, queue admission — each tuned to the shared die and 124&nbsp;GB unified RAM</li>
                <li><strong>OpenAI-compatible API</strong>: drop-in for OpenAI clients (chat/completions, embeddings, responses, Anthropic-shaped messages, rerank)</li>
                <li><strong>MCP Server</strong>: integration with Claude Desktop and other AI agents</li>
                <li><strong>Real-time monitoring</strong>: GPU/CPU/RAM/GTT telemetry, per-request logs, and historical analytics</li>
              </ul>

              <div className="docs-info-box">
                <p>
                  Deep dives: see the <code>docs/features-overview.md</code> feature map and
                  <code>docs/ds4-engine.md</code> for the DeepSeek V4 Flash engine in the repo's
                  <code>/docs</code> folder.
                </p>
              </div>

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

          {activeSection === 'local-cli' && (
            <section className="docs-section">
              <h2>Local CLI</h2>
              <p>
                The dependency-free <code>llm</code> command exposes every MCP workflow and the
                complete Manager HTTP API from a terminal or local agent. A source install links it
                into <code>~/.local/bin</code>; Debian packages install it as <code>/usr/bin/llm</code>.
              </p>
              <CodeBlock
                id="cli-install"
                language="bash"
                code={`# A normal source installation includes the CLI
./install.sh

# Or install only the CLI link
scripts/install-llm-cli.sh install`}
              />

              <h3>Connection and output</h3>
              <CodeBlock
                id="cli-output"
                language="bash"
                code={`# Human-readable output is the default
llm status

# Select another manager for one command or the whole shell
llm --url ${window.location.origin} models list
export LLAMA_MANAGER_URL=${window.location.origin}

# Stable machine projections
llm models list --json
llm models list --get 'localModels.*.name'
llm status --graphql '{ running mode loadedModels { id } }'`}
              />
              <p className="docs-hint">
                <code>--get</code> and <code>--graphql</code> are mutually exclusive. Destructive
                commands such as <code>models delete</code> and <code>downloads cancel</code> require
                explicit <code>--yes</code> and never prompt interactively.
              </p>

              <h3>Complete API access</h3>
              <CodeBlock
                id="cli-api"
                language="bash"
                code={`# Discover operation IDs, then call one with typed request inputs
llm api list --graphql '{ operations { operationId method path summary } }'
llm api call getStatus --json

# Future-safe raw requests, multipart uploads, and binary downloads
llm request GET /api/analytics/request-stats --query window=24h --json
llm api call createMediaArtifact --form file=@./image.png --output ./artifact.bin`}
              />

              <h3>Install Qwen3.8-27B</h3>
              <CodeBlock
                id="cli-qwen-workflow"
                language="bash"
                code={`# Search and inspect exact repository files
llm search 'Qwen3.8 27B' --graphql '{ results { id downloads likes } }'
llm repo files unsloth/Qwen3.8-27B-GGUF --graphql '{ quantizations { name files { name size } } }'

# Start the managed download and poll it
DOWNLOAD_ID=$(llm download unsloth/Qwen3.8-27B-GGUF --quantization UD-Q4_K_XL --get downloadId)
llm downloads status "$DOWNLOAD_ID" --graphql '{ status progress error }'

# Copy the downloaded name from this list, then load and verify it
llm models list --get 'localModels.*.name'
llm models load 'unsloth_Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_XL.gguf'
llm chat 'unsloth_Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_XL.gguf' 'Reply with exactly: Qwen is ready.'`}
              />

              <h3>Agent-readable reference</h3>
              <p>
                Run <code>llm help --json</code> for structured command metadata or
                <code>llm docs --full</code> for the complete generated Markdown reference. Both
                come from the same command catalog used by the parser.
              </p>
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

              <h3>Inference Engines</h3>
              <p>
                Two engines run behind one API. A preset declares which one it uses
                (<code>engine: "llama"</code> or <code>engine: "ds4"</code>); only one serves locally
                at a time.
              </p>
              <ul>
                <li><strong>llama.cpp</strong> — router (many models, on-demand load/unload) or single tuned preset. Supports slots, KV-cache persistence, speculative decoding, embeddings.</li>
                <li><strong>DS4 / DeepSeek V4 Flash</strong> — an 80&nbsp;GB model upstream llama.cpp can't load, served via <a href="https://github.com/antirez/ds4" target="_blank" rel="noopener noreferrer">antirez/ds4</a>. Runs <em>exclusively</em> (evicts everything else) and auto-fits the box with adaptive context + SSD expert-streaming.</li>
              </ul>

              <h3>Router Mode (llama.cpp default)</h3>
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

              <h3>Preferred Big / Small Models (aliases)</h3>
              <p>
                Point the <code>default-big</code> and <code>default-small</code> request-time aliases
                at any model (or a DS4 preset). Clients that always ask for <code>default-big</code>
                get whatever you've chosen — so you can migrate a whole fleet between models, or between
                engines, with <strong>no client change</strong>. Set them on the Settings page or via
                <code>POST /api/settings</code>.
              </p>

              <h3>Remote Offload</h3>
              <p>
                When the box is busy, hot, or running DS4 exclusively, requests for other models are
                forwarded to configured remote OpenAI-compatible backends (e.g. Ollama boxes) instead of
                loading locally. Routing considers queue depth, thermal state, an offload policy, and a
                "protect-resident" rule that keeps the big model loaded rather than evicting it. Manage
                backends on the Settings page.
              </p>

              <h3>Stability Guards</h3>
              <p>
                Tuned to the shared CPU+iGPU die and 124&nbsp;GB unified RAM, each built from a real
                incident:
              </p>
              <ul>
                <li><strong>Memory watchdog</strong> — restarts on genuine RAM pressure, but defers while a request is streaming</li>
                <li><strong>Thermal governor</strong> — pauses dispatch / offloads when the APU is hot (never unloads an idle model)</li>
                <li><strong>Restart governor</strong> — debounce + circuit breaker + 15-min wedged-GPU hold to prevent restart-thrash</li>
                <li><strong>Queue admission</strong> — backpressure without dropping requests</li>
              </ul>

              <h3>Presets</h3>
              <p>
                Presets are pre-configured model settings optimized for specific use cases.
                They specify the engine, model, context size, sampling, chat template, and other
                parameters (including DS4 streaming/context knobs).
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

export default DocsPage;
