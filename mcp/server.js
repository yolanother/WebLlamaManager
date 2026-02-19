#!/usr/bin/env node
/**
 * Llama Manager MCP Server
 *
 * Exposes Llama Manager APIs as MCP tools for AI agents.
 *
 * Usage:
 *   node mcp/server.js
 *
 * Or add to Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "llama-manager": {
 *         "command": "node",
 *         "args": ["/path/to/llama-server/mcp/server.js"],
 *         "env": {
 *           "LLAMA_MANAGER_URL": "http://localhost:5250"
 *         }
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const LLAMA_MANAGER_URL = process.env.LLAMA_MANAGER_URL || 'http://localhost:5250';

// Helper to make API calls
async function apiCall(method, path, body = null) {
  const url = `${LLAMA_MANAGER_URL}${path}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();
  return { status: response.status, data };
}

// Define available tools
const tools = [
  {
    name: 'llama_get_status',
    description: 'Get the current status of the Llama Manager and llama.cpp server. Returns whether the server is running, healthy, current mode, and active preset.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'llama_get_stats',
    description: 'Get system resource statistics including CPU usage, memory usage, GPU stats (temperature, power, VRAM), and context usage.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'llama_get_analytics',
    description: 'Get time-series analytics data for temperature, power consumption, memory usage, and token generation speed over the specified time period.',
    inputSchema: {
      type: 'object',
      properties: {
        minutes: {
          type: 'number',
          description: 'Number of minutes of historical data to retrieve (default: 5)'
        }
      },
      required: []
    }
  },
  {
    name: 'llama_list_models',
    description: 'List all available models, both locally stored and currently loaded in the server.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'llama_load_model',
    description: 'Load a model into the llama.cpp server. The model must be available locally.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Model name or path to load'
        }
      },
      required: ['model']
    }
  },
  {
    name: 'llama_unload_model',
    description: 'Unload a model from the llama.cpp server to free up resources.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Model ID to unload'
        }
      },
      required: ['model']
    }
  },
  {
    name: 'llama_start_server',
    description: 'Start the llama.cpp server in router mode (multi-model). This will stop any currently running server first.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'llama_stop_server',
    description: 'Stop the llama.cpp server and all worker processes.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'llama_get_settings',
    description: 'Get current server settings including context size, max models, GPU layers, and performance options.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'llama_update_settings',
    description: 'Update server settings. Changes take effect after server restart.',
    inputSchema: {
      type: 'object',
      properties: {
        contextSize: {
          type: 'number',
          description: 'Context window size (512-262144)'
        },
        modelsMax: {
          type: 'number',
          description: 'Maximum loaded models in router mode (1-10)'
        },
        gpuLayers: {
          type: 'number',
          description: 'Number of layers to offload to GPU (0-999, 99 for full)'
        },
        autoStart: {
          type: 'boolean',
          description: 'Auto-start server when manager starts'
        },
        noWarmup: {
          type: 'boolean',
          description: 'Skip model warmup on load'
        },
        flashAttn: {
          type: 'boolean',
          description: 'Enable flash attention'
        }
      },
      required: []
    }
  },
  {
    name: 'llama_list_presets',
    description: 'List available model presets. Presets are pre-configured models with specific settings.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'llama_activate_preset',
    description: 'Activate a preset. This switches the server to single-model mode with the specified preset configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        presetId: {
          type: 'string',
          description: 'Preset ID to activate'
        }
      },
      required: ['presetId']
    }
  },
  {
    name: 'llama_search_models',
    description: 'Search HuggingFace for GGUF models. Returns model repositories with download counts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g., "qwen coder", "llama 70b")'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'llama_download_model',
    description: 'Download a model from HuggingFace. Can download by quantization, specific filename, or pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'HuggingFace repo ID (e.g., Qwen/Qwen2.5-Coder-32B-Instruct-GGUF)'
        },
        quantization: {
          type: 'string',
          description: 'Quantization to download (e.g., Q5_K_M, Q4_K_M)'
        },
        filename: {
          type: 'string',
          description: 'Specific filename to download'
        },
        pattern: {
          type: 'string',
          description: 'Glob pattern for files to download (e.g., *.gguf)'
        }
      },
      required: ['repo']
    }
  },
  {
    name: 'llama_get_processes',
    description: 'List running llama-server processes with CPU, memory usage, and model information.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'llama_get_logs',
    description: 'Get recent server logs for debugging and monitoring.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of log entries to return (default: 100)'
        }
      },
      required: []
    }
  },
  {
    name: 'llama_chat',
    description: 'Send a chat completion request to the llama server. Uses the OpenAI-compatible API.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Model ID to use for completion'
        },
        messages: {
          type: 'array',
          description: 'Array of message objects with role and content',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['system', 'user', 'assistant'] },
              content: { type: 'string' }
            }
          }
        },
        temperature: {
          type: 'number',
          description: 'Sampling temperature (0-2, default: 0.7)'
        },
        max_tokens: {
          type: 'number',
          description: 'Maximum tokens to generate'
        }
      },
      required: ['model', 'messages']
    }
  }
];

// Tool handlers
async function handleTool(name, args) {
  switch (name) {
    case 'llama_get_status':
      return apiCall('GET', '/api/status');

    case 'llama_get_stats':
      return apiCall('GET', '/api/stats');

    case 'llama_get_analytics': {
      const minutes = args.minutes || 5;
      return apiCall('GET', `/api/analytics?minutes=${minutes}`);
    }

    case 'llama_list_models':
      return apiCall('GET', '/api/models');

    case 'llama_load_model':
      return apiCall('POST', '/api/models/load', { model: args.model });

    case 'llama_unload_model':
      return apiCall('POST', '/api/models/unload', { model: args.model });

    case 'llama_start_server':
      return apiCall('POST', '/api/server/start');

    case 'llama_stop_server':
      return apiCall('POST', '/api/server/stop');

    case 'llama_get_settings':
      return apiCall('GET', '/api/settings');

    case 'llama_update_settings':
      return apiCall('POST', '/api/settings', args);

    case 'llama_list_presets':
      return apiCall('GET', '/api/presets');

    case 'llama_activate_preset':
      return apiCall('POST', `/api/presets/${args.presetId}/activate`);

    case 'llama_search_models':
      return apiCall('GET', `/api/search?query=${encodeURIComponent(args.query)}`);

    case 'llama_download_model': {
      const body = { repo: args.repo };
      if (args.quantization) body.quantization = args.quantization;
      if (args.filename) body.filename = args.filename;
      if (args.pattern) body.pattern = args.pattern;
      return apiCall('POST', '/api/pull', body);
    }

    case 'llama_get_processes':
      return apiCall('GET', '/api/processes');

    case 'llama_get_logs': {
      const limit = args.limit || 100;
      return apiCall('GET', `/api/logs?limit=${limit}`);
    }

    case 'llama_chat': {
      const body = {
        model: args.model,
        messages: args.messages,
        stream: false
      };
      if (args.temperature !== undefined) body.temperature = args.temperature;
      if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;
      return apiCall('POST', '/api/v1/chat/completions', body);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Create and run the MCP server
async function main() {
  const server = new Server(
    {
      name: 'llama-manager',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleTool(name, args || {});
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: error.message }),
          },
        ],
        isError: true,
      };
    }
  });

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Llama Manager MCP server running');
}

main().catch(console.error);
