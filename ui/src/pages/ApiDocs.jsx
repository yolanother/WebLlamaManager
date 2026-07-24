// Llama Manager — interactive API documentation page.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Documents manager and OpenAI-compatible endpoints and provides an interactive
// request builder.

import React, { useState, useEffect, useCallback } from 'react';
import { API_BASE, copyTextToClipboard } from '../api.js';
import { SearchableSelect } from '../components/SearchableSelect.jsx';

// API Documentation Page
function ApiDocsPage() {
  const [activeEndpoint, setActiveEndpoint] = useState(null);
  const [params, setParams] = useState({});
  const [response, setResponse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('manager');
  const [openaiModels, setOpenaiModels] = useState([]);
  const [copiedCurl, setCopiedCurl] = useState(false);

  // Fetch models for OpenAI tab
  const fetchOpenaiModels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/v1/models`);
      if (res.ok) {
        const data = await res.json();
        setOpenaiModels(data.data || []);
      }
    } catch (err) {
      console.error('Failed to fetch OpenAI models:', err);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'openai') {
      fetchOpenaiModels();
    }
  }, [activeTab, fetchOpenaiModels]);

  // Generate curl example
  const generateCurlExample = useCallback((endpoint, currentParams) => {
    if (!endpoint) return '';

    const baseUrl = window.location.origin;
    let url = baseUrl + endpoint.path;

    // Handle path params
    for (const param of endpoint.params) {
      if (param.type === 'path' && currentParams[param.name]) {
        url = url.replace(`:${param.name}`, encodeURIComponent(currentParams[param.name]));
      }
    }

    // Handle query params
    const queryParams = endpoint.params
      .filter(p => p.type === 'query' && currentParams[p.name] !== undefined && currentParams[p.name] !== '')
      .map(p => `${p.name}=${encodeURIComponent(currentParams[p.name])}`);
    if (queryParams.length) url += '?' + queryParams.join('&');

    // Build curl command
    let curl = `curl -X ${endpoint.method} "${url}"`;

    if (endpoint.method !== 'GET') {
      curl += ` \\\n  -H "Content-Type: application/json"`;

      const bodyParams = {};
      for (const param of endpoint.params) {
        if (!['path', 'query'].includes(param.type) && currentParams[param.name] !== undefined && currentParams[param.name] !== '') {
          let val = currentParams[param.name];
          if (param.type === 'json' && typeof val === 'string') {
            try { val = JSON.parse(val); } catch { /* use as-is */ }
          }
          bodyParams[param.name] = val;
        }
      }

      if (Object.keys(bodyParams).length) {
        curl += ` \\\n  -d '${JSON.stringify(bodyParams, null, 2).replace(/\n/g, '\n  ')}'`;
      }
    }

    return curl;
  }, []);

  const copyCurl = async () => {
    const curl = generateCurlExample(activeEndpoint, params);
    try {
      await copyTextToClipboard(curl);
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const managerEndpoints = [
    {
      id: 'get-status',
      method: 'GET',
      path: '/api/status',
      description: 'Get server status including llama health, mode, and downloads',
      params: [],
      example: null
    },
    {
      id: 'get-models',
      method: 'GET',
      path: '/api/models',
      description: 'List all local and server-loaded models',
      params: [],
      example: null
    },
    {
      id: 'load-model',
      method: 'POST',
      path: '/api/models/load',
      description: 'Load a model into the llama server',
      params: [
        { name: 'model', type: 'string', required: true, description: 'Model name or path to load' }
      ],
      example: { model: 'Qwen_Qwen2.5-Coder-32B-Instruct-GGUF/qwen2.5-coder-32b-instruct-q5_k_m.gguf' }
    },
    {
      id: 'unload-model',
      method: 'POST',
      path: '/api/models/unload',
      description: 'Unload a model from the llama server',
      params: [
        { name: 'model', type: 'string', required: true, description: 'Model ID to unload' }
      ],
      example: { model: 'model-id' }
    },
    {
      id: 'get-settings',
      method: 'GET',
      path: '/api/settings',
      description: 'Get current server settings',
      params: [],
      example: null
    },
    {
      id: 'update-settings',
      method: 'POST',
      path: '/api/settings',
      description: 'Update server settings',
      params: [
        { name: 'contextSize', type: 'number', required: false, description: 'Context window size (512-262144)' },
        { name: 'modelsMax', type: 'number', required: false, description: 'Max loaded models (1-10)' },
        { name: 'gpuLayers', type: 'number', required: false, description: 'GPU layers (0-999)' },
        { name: 'autoStart', type: 'boolean', required: false, description: 'Auto-start server on manager start' },
        { name: 'noWarmup', type: 'boolean', required: false, description: 'Skip model warmup' },
        { name: 'flashAttn', type: 'boolean', required: false, description: 'Enable flash attention' }
      ],
      example: { contextSize: 8192, modelsMax: 2 }
    },
    {
      id: 'start-server',
      method: 'POST',
      path: '/api/server/start',
      description: 'Start the llama server in router mode',
      params: [],
      example: null
    },
    {
      id: 'stop-server',
      method: 'POST',
      path: '/api/server/stop',
      description: 'Stop the llama server',
      params: [],
      example: null
    },
    {
      id: 'get-presets',
      method: 'GET',
      path: '/api/presets',
      description: 'List available optimized presets',
      params: [],
      example: null
    },
    {
      id: 'activate-preset',
      method: 'POST',
      path: '/api/presets/:presetId/activate',
      description: 'Activate an optimized preset (single-model mode)',
      params: [
        { name: 'presetId', type: 'path', required: true, description: 'Preset ID (e.g., gpt120, qwen3, qwen2.5)' }
      ],
      example: null
    },
    {
      id: 'get-analytics',
      method: 'GET',
      path: '/api/analytics',
      description: 'Get time-series analytics data',
      params: [
        { name: 'minutes', type: 'query', required: false, description: 'Minutes of data to retrieve (default: 5)' }
      ],
      example: null
    },
    {
      id: 'get-processes',
      method: 'GET',
      path: '/api/processes',
      description: 'List running llama-server processes',
      params: [],
      example: null
    },
    {
      id: 'kill-process',
      method: 'POST',
      path: '/api/processes/:pid/kill',
      description: 'Kill a specific process by PID',
      params: [
        { name: 'pid', type: 'path', required: true, description: 'Process ID to kill' }
      ],
      example: null
    },
    {
      id: 'search-models',
      method: 'GET',
      path: '/api/search',
      description: 'Search HuggingFace for GGUF models',
      params: [
        { name: 'query', type: 'query', required: true, description: 'Search query' }
      ],
      example: null
    },
    {
      id: 'pull-model',
      method: 'POST',
      path: '/api/pull',
      description: 'Download a model from HuggingFace',
      params: [
        { name: 'repo', type: 'string', required: true, description: 'HuggingFace repo (e.g., Qwen/Qwen2.5-Coder-32B-Instruct-GGUF)' },
        { name: 'quantization', type: 'string', required: true, description: 'Quantization to download (e.g., Q5_K_M)' }
      ],
      example: { repo: 'Qwen/Qwen2.5-Coder-32B-Instruct-GGUF', quantization: 'Q5_K_M' }
    },
    {
      id: 'get-logs',
      method: 'GET',
      path: '/api/logs',
      description: 'Get server logs',
      params: [
        { name: 'limit', type: 'query', required: false, description: 'Max logs to return (default: 100)' }
      ],
      example: null
    }
  ];

  const openaiEndpoints = [
    {
      id: 'openai-models',
      method: 'GET',
      path: '/api/v1/models',
      description: 'List available models (OpenAI-compatible)',
      params: [],
      example: null
    },
    {
      id: 'openai-chat',
      method: 'POST',
      path: '/api/v1/chat/completions',
      description: 'Create a chat completion (OpenAI-compatible). Supports streaming.',
      params: [
        { name: 'model', type: 'string', required: true, description: 'Model ID to use' },
        { name: 'messages', type: 'json', required: true, description: 'Array of message objects with role and content' },
        { name: 'temperature', type: 'number', required: false, description: 'Sampling temperature (0-2)' },
        { name: 'max_tokens', type: 'number', required: false, description: 'Maximum tokens to generate' },
        { name: 'stream', type: 'boolean', required: false, description: 'Stream the response' },
        { name: 'top_p', type: 'number', required: false, description: 'Nucleus sampling parameter' },
        { name: 'frequency_penalty', type: 'number', required: false, description: 'Frequency penalty (-2 to 2)' },
        { name: 'presence_penalty', type: 'number', required: false, description: 'Presence penalty (-2 to 2)' }
      ],
      example: {
        model: 'model-id',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello!' }
        ],
        temperature: 0.7,
        max_tokens: 500
      }
    },
    {
      id: 'openai-completions',
      method: 'POST',
      path: '/api/v1/completions',
      description: 'Create a text completion (legacy OpenAI-compatible endpoint)',
      params: [
        { name: 'model', type: 'string', required: true, description: 'Model ID to use' },
        { name: 'prompt', type: 'string', required: true, description: 'The prompt to complete' },
        { name: 'max_tokens', type: 'number', required: false, description: 'Maximum tokens to generate' },
        { name: 'temperature', type: 'number', required: false, description: 'Sampling temperature' },
        { name: 'stream', type: 'boolean', required: false, description: 'Stream the response' }
      ],
      example: {
        model: 'model-id',
        prompt: 'Once upon a time',
        max_tokens: 100,
        temperature: 0.7
      }
    },
    {
      id: 'openai-embeddings',
      method: 'POST',
      path: '/api/v1/embeddings',
      description: 'Create embeddings (OpenAI-compatible). Served by a dedicated embedding model; supports batched input. Default model Qwen3-Embedding-0.6B returns 1024-dim vectors.',
      params: [
        { name: 'model', type: 'string', required: true, description: 'Embedding model id (see /v1/models)' },
        { name: 'input', type: 'string | string[]', required: true, description: 'Text or array of texts to embed' }
      ],
      example: {
        model: 'model-id',
        input: 'Hello world'
      }
    }
  ];

  const endpoints = activeTab === 'manager' ? managerEndpoints : openaiEndpoints;

  const handleParamChange = (name, value, type) => {
    let parsedValue = value;
    if (type === 'number' && value !== '') {
      parsedValue = parseFloat(value);
    } else if (type === 'boolean') {
      parsedValue = value === 'true';
    } else if (type === 'json') {
      try {
        parsedValue = JSON.parse(value);
      } catch {
        parsedValue = value;
      }
    }
    setParams(p => ({ ...p, [name]: parsedValue }));
  };

  const testEndpoint = async (endpoint) => {
    setLoading(true);
    setResponse(null);

    try {
      let url = endpoint.path;
      const queryParams = [];
      const bodyParams = {};

      // Process parameters
      for (const param of endpoint.params) {
        const value = params[param.name];
        if (value === undefined || value === '') continue;

        if (param.type === 'path') {
          url = url.replace(`:${param.name}`, encodeURIComponent(value));
        } else if (param.type === 'query') {
          queryParams.push(`${param.name}=${encodeURIComponent(value)}`);
        } else {
          let val = value;
          if (param.type === 'json' && typeof val === 'string') {
            try { val = JSON.parse(val); } catch { /* use as-is */ }
          }
          bodyParams[param.name] = val;
        }
      }

      if (queryParams.length > 0) {
        url += '?' + queryParams.join('&');
      }

      const options = {
        method: endpoint.method,
        headers: { 'Content-Type': 'application/json' }
      };

      if (endpoint.method !== 'GET' && Object.keys(bodyParams).length > 0) {
        options.body = JSON.stringify(bodyParams);
      }

      const startTime = Date.now();
      const res = await fetch(url, options);
      const duration = Date.now() - startTime;

      let data;
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        data = await res.json();
      } else {
        data = await res.text();
      }

      setResponse({
        status: res.status,
        statusText: res.statusText,
        duration,
        data
      });
    } catch (err) {
      setResponse({
        status: 'Error',
        statusText: err.message,
        duration: 0,
        data: null
      });
    }

    setLoading(false);
  };

  const selectEndpoint = (endpoint) => {
    setActiveEndpoint(endpoint);
    setResponse(null);
    // Pre-fill with example if available
    if (endpoint.example) {
      const newParams = {};
      for (const [key, value] of Object.entries(endpoint.example)) {
        newParams[key] = typeof value === 'object' ? JSON.stringify(value, null, 2) : value;
      }
      setParams(newParams);
    } else {
      setParams({});
    }
  };

  return (
    <div className="page api-docs-page">
      <div className="page-header">
        <h2>API Documentation</h2>
      </div>

      <p className="page-description">
        Interactive API documentation for Llama Manager. Test endpoints directly from this page.
      </p>

      <div className="api-tabs">
        <button
          className={`api-tab ${activeTab === 'manager' ? 'active' : ''}`}
          onClick={() => { setActiveTab('manager'); setActiveEndpoint(null); setResponse(null); }}
        >
          Manager API
        </button>
        <button
          className={`api-tab ${activeTab === 'openai' ? 'active' : ''}`}
          onClick={() => { setActiveTab('openai'); setActiveEndpoint(null); setResponse(null); }}
        >
          OpenAI API (v1)
        </button>
      </div>

      <div className="api-docs-layout">
        {/* Endpoints List */}
        <div className="api-endpoints-list">
          <h3>{activeTab === 'manager' ? 'Manager Endpoints' : 'OpenAI-Compatible Endpoints'}</h3>
          {activeTab === 'openai' && (
            <p className="api-base-url">Base URL: <code>/api/v1</code></p>
          )}
          <div className="endpoints-list">
            {endpoints.map(endpoint => (
              <div
                key={endpoint.id}
                className={`endpoint-item ${activeEndpoint?.id === endpoint.id ? 'active' : ''}`}
                onClick={() => selectEndpoint(endpoint)}
              >
                <span className={`method-badge ${endpoint.method.toLowerCase()}`}>
                  {endpoint.method}
                </span>
                <span className="endpoint-path">{endpoint.path}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Endpoint Details & Testing */}
        <div className="api-endpoint-detail">
          {activeEndpoint ? (
            <>
              <div className="endpoint-header">
                <span className={`method-badge large ${activeEndpoint.method.toLowerCase()}`}>
                  {activeEndpoint.method}
                </span>
                <code className="endpoint-path-large">{activeEndpoint.path}</code>
              </div>

              <p className="endpoint-description">{activeEndpoint.description}</p>

              {/* Parameters Form */}
              {activeEndpoint.params.length > 0 && (
                <div className="params-section">
                  <h4>Parameters</h4>
                  <div className="params-form">
                    {activeEndpoint.params.map(param => (
                      <div key={param.name} className="param-field">
                        <label>
                          <span className="param-name">{param.name}</span>
                          {param.required && <span className="param-required">*</span>}
                          <span className="param-type">{param.type}</span>
                        </label>
                        <p className="param-description">{param.description}</p>
                        {param.type === 'boolean' ? (
                          <select
                            value={params[param.name] ?? ''}
                            onChange={(e) => handleParamChange(param.name, e.target.value, 'boolean')}
                          >
                            <option value="">-- Select --</option>
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        ) : param.type === 'json' ? (
                          <textarea
                            value={params[param.name] ?? ''}
                            onChange={(e) => handleParamChange(param.name, e.target.value, 'json')}
                            placeholder={`Enter JSON...`}
                            rows={4}
                          />
                        ) : param.name === 'model' && activeTab === 'openai' && openaiModels.length > 0 ? (
                          <SearchableSelect
                            value={params[param.name] ?? ''}
                            onChange={(val) => handleParamChange(param.name, val, 'string')}
                            options={openaiModels.map(m => ({ value: m.id, label: m.id }))}
                            placeholder="-- Select model --"
                            storageKey="lastApiDocsModel"
                          />
                        ) : (
                          <input
                            type={param.type === 'number' ? 'number' : 'text'}
                            value={params[param.name] ?? ''}
                            onChange={(e) => handleParamChange(param.name, e.target.value, param.type)}
                            placeholder={param.type === 'path' ? `Enter ${param.name}...` : `Enter value...`}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* curl Example */}
              {activeEndpoint && (
                <div className="curl-section">
                  <h4>
                    curl Example
                    <button
                      className={`curl-copy-btn ${copiedCurl ? 'copied' : ''}`}
                      onClick={copyCurl}
                    >
                      {copiedCurl ? 'Copied!' : 'Copy'}
                    </button>
                  </h4>
                  <div className="curl-code-container">
                    <pre className="curl-code">{generateCurlExample(activeEndpoint, params)}</pre>
                  </div>
                </div>
              )}

              {/* Test Button */}
              <div className="test-section">
                <button
                  className="btn-primary"
                  onClick={() => testEndpoint(activeEndpoint)}
                  disabled={loading}
                >
                  {loading ? 'Sending...' : 'Send Request'}
                </button>
              </div>

              {/* Response */}
              {response && (
                <div className="response-section">
                  <h4>Response</h4>
                  <div className={`response-status ${response.status >= 200 && response.status < 300 ? 'success' : 'error'}`}>
                    <span className="status-code">{response.status}</span>
                    <span className="status-text">{response.statusText}</span>
                    <span className="response-time">{response.duration}ms</span>
                  </div>
                  <pre className="response-body">
                    {typeof response.data === 'object'
                      ? JSON.stringify(response.data, null, 2)
                      : response.data || 'No response body'}
                  </pre>
                </div>
              )}

              {/* Example */}
              {activeEndpoint.example && (
                <div className="example-section">
                  <h4>Example Request Body</h4>
                  <pre className="example-code">
                    {JSON.stringify(activeEndpoint.example, null, 2)}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <div className="no-endpoint-selected">
              <p>Select an endpoint from the list to view details and test it.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ApiDocsPage;
