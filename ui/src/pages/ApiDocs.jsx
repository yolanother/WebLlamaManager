// Llama Manager — spec-driven interactive API documentation page.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Fetches the server's OpenAPI document as the sole endpoint inventory, organizes
// Manager and OpenAI operations in accessible tabs, explains the multimodal
// content-part contract, and provides a live request tester that preserves the
// user's JSON request bytes.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { SearchableSelect } from '../components/SearchableSelect.jsx';
import { CodeBlock } from '../components/CodeBlock.jsx';
import '../styles/pages.css';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const LANGUAGE_ORDER = ['curl', 'python', 'javascript'];

const STANDARD_IMAGE_BODY = {
  model: 'gemma-4',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'Compare these two images.' },
      {
        type: 'image_url',
        image_url: { url: 'https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg' }
      },
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
        }
      }
    ]
  }]
};

const STANDARD_AUDIO_BODY = {
  model: 'gemma-4',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this audio clip.' },
      {
        type: 'input_audio',
        input_audio: {
          data: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=',
          format: 'wav'
        }
      }
    ]
  }]
};

const VIDEO_FILE_BODY = {
  model: 'gemma-4',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'Summarize the events and speech in this video.' },
      {
        type: 'video_url',
        video_url: {
          url: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
          max_frames: 16,
          include_audio: true
        }
      }
    ]
  }]
};

/** Returns the first concrete example value declared for a request body. */
function getRequestExample(contentEntry) {
  const examples = Object.values(contentEntry?.examples || {});
  return examples.find(example => example?.value !== undefined)?.value
    ?? contentEntry?.example
    ?? contentEntry?.schema?.example
    ?? null;
}

/** Converts OpenAPI paths into the compact endpoint model consumed by the page. */
function normalizeEndpoints(spec) {
  return Object.entries(spec?.paths || {}).flatMap(([path, pathItem]) => (
    HTTP_METHODS.flatMap(method => {
      const operation = pathItem?.[method];
      if (!operation) return [];

      const bodyEntries = Object.entries(operation.requestBody?.content || {});
      const [bodyContentType, bodyContent] = bodyEntries.find(([type]) => type === 'application/json')
        || bodyEntries[0]
        || [null, null];

      return [{
        id: `${method}-${path}`,
        method: method.toUpperCase(),
        path,
        summary: operation.summary || path,
        description: operation.description || operation.summary || 'No description provided.',
        tags: operation.tags || [],
        params: (operation.parameters || []).map(parameter => ({
          name: parameter.name,
          type: parameter.in,
          valueType: parameter.schema?.type || 'string',
          required: Boolean(parameter.required),
          description: parameter.description || `${parameter.name} ${parameter.in} parameter.`,
          defaultValue: parameter.example ?? parameter.schema?.default ?? ''
        })),
        bodyContentType,
        bodyRequired: Boolean(operation.requestBody?.required),
        bodyExample: getRequestExample(bodyContent),
        bodySchema: bodyContent?.schema || null,
        codeSamples: operation['x-codeSamples'] || []
      }];
    })
  ));
}

/** Maps OpenAPI language labels to stable tab ids and highlight.js grammars. */
function normalizeLanguage(language) {
  const normalized = String(language || '').toLowerCase();
  if (normalized === 'curl' || normalized === 'shell' || normalized === 'bash') return 'curl';
  if (normalized === 'python') return 'python';
  if (normalized === 'javascript' || normalized === 'js') return 'javascript';
  return normalized;
}

/** Builds all three runnable client examples for guide-only request bodies. */
function generateCodeSamples(path, body) {
  const compactBody = JSON.stringify(body);
  const url = `${window.location.origin}${path}`;
  return [
    {
      lang: 'cURL',
      source: `curl -s -X POST '${url}' -H 'Content-Type: application/json' -d '${compactBody}'`
    },
    {
      lang: 'Python',
      source: `import json\nimport requests\n\npayload = json.loads(r'''${compactBody}''')\nresponse = requests.post('${url}', json=payload)\nprint(response.json())`
    },
    {
      lang: 'JavaScript',
      source: `const response = await fetch('${url}', {\n  method: 'POST',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify(${JSON.stringify(body, null, 2)})\n});\nconsole.log(await response.json());`
    }
  ];
}

/** Renders one OpenAPI code-sample set with accessible language tabs. */
function CodeSampleViewer({ samples, activeLanguage, onLanguageChange, label }) {
  const samplesByLanguage = useMemo(() => new Map(
    samples.map(sample => [normalizeLanguage(sample.lang), sample])
  ), [samples]);
  const availableLanguages = LANGUAGE_ORDER.filter(language => samplesByLanguage.has(language));
  const selectedLanguage = availableLanguages.includes(activeLanguage)
    ? activeLanguage
    : availableLanguages[0];
  const sample = samplesByLanguage.get(selectedLanguage);

  if (!sample) {
    return <p className="api-inline-note">No code samples are declared for this operation.</p>;
  }

  return (
    <div className="api-code-samples">
      <div className="code-sample-tabs" role="tablist" aria-label={label}>
        {availableLanguages.map(language => (
          <button
            key={language}
            type="button"
            role="tab"
            aria-selected={selectedLanguage === language}
            className={`code-sample-tab ${selectedLanguage === language ? 'active' : ''}`}
            onClick={() => onLanguageChange(language)}
          >
            {language === 'curl' ? 'curl' : language}
          </button>
        ))}
      </div>
      <CodeBlock
        code={sample.source}
        language={selectedLanguage === 'curl' ? 'bash' : selectedLanguage}
      />
    </div>
  );
}

/** Creates guide examples while sourcing the worked YouTube case from OpenAPI. */
function createGuideExamples(chatEndpoint) {
  if (!chatEndpoint) return [];

  const generated = [
    {
      id: 'images',
      title: 'Images: HTTPS and data URLs',
      description: 'Use the standard image_url part with either an HTTPS URL or a data:image/... URL. These parts are forwarded unchanged.',
      body: STANDARD_IMAGE_BODY
    },
    {
      id: 'audio',
      title: 'Audio: inline input_audio',
      description: 'Use the standard input_audio part with base64 WAV or MP3 bytes. Replace the tiny valid WAV placeholder with your own recording.',
      body: STANDARD_AUDIO_BODY
    },
    {
      id: 'video-file',
      title: 'Video files',
      description: 'Use the Llama Manager video_url extension with a direct media URL. Frames and optional audio are expanded server-side.',
      body: VIDEO_FILE_BODY
    }
  ].map(example => ({
    ...example,
    codeSamples: generateCodeSamples(chatEndpoint.path, example.body)
  }));

  if (chatEndpoint.bodyExample) {
    generated.push({
      id: 'youtube',
      title: 'YouTube links',
      description: 'A YouTube URL is a video_url. This worked body and its client samples come directly from the served OpenAPI document.',
      body: chatEndpoint.bodyExample,
      codeSamples: chatEndpoint.codeSamples
    });
  }

  return generated;
}

/** Returns the model id currently present in the unmodified request text. */
function getBodyModel(requestBodyText) {
  try {
    return JSON.parse(requestBodyText || '{}').model || '';
  } catch {
    return '';
  }
}

/** Formats advertised model modalities for visible dropdown option text. */
function formatModelOption(model) {
  const modalities = Array.isArray(model.modalities) && model.modalities.length > 0
    ? model.modalities.join(', ')
    : 'text';
  return `${model.id} — ${modalities}`;
}

/**
 * Renders spec-driven API reference content and a live same-origin endpoint tester.
 * The component fetches both documentation and model metadata from the running server.
 */
function ApiDocsPage() {
  const [spec, setSpec] = useState(null);
  const [specLoading, setSpecLoading] = useState(true);
  const [specError, setSpecError] = useState('');
  const [activeEndpoint, setActiveEndpoint] = useState(null);
  const [activeTab, setActiveTab] = useState('manager');
  const [params, setParams] = useState({});
  const [requestBodyText, setRequestBodyText] = useState('');
  const [requestError, setRequestError] = useState('');
  const [response, setResponse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState('');
  const [activeCodeLanguage, setActiveCodeLanguage] = useState('curl');
  const [activeGuideId, setActiveGuideId] = useState('images');
  const [activeGuideLanguage, setActiveGuideLanguage] = useState('curl');

  const fetchSpec = useCallback(async () => {
    setSpecLoading(true);
    setSpecError('');
    try {
      const result = await fetch('/api/openapi.json');
      if (!result.ok) throw new Error(`OpenAPI request failed with ${result.status}`);
      setSpec(await result.json());
    } catch (error) {
      setSpec(null);
      setSpecError(error.message || 'Unable to load the OpenAPI document.');
    } finally {
      setSpecLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSpec();
  }, [fetchSpec]);

  useEffect(() => {
    let cancelled = false;
    async function fetchModels() {
      setModelsLoading(true);
      setModelsError('');
      try {
        const result = await fetch('/v1/models');
        if (!result.ok) throw new Error(`Models request failed with ${result.status}`);
        const data = await result.json();
        if (!cancelled) setModels(data.data || []);
      } catch (error) {
        if (!cancelled) setModelsError(error.message || 'Unable to load model options.');
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    }
    fetchModels();
    return () => { cancelled = true; };
  }, []);

  const allEndpoints = useMemo(() => normalizeEndpoints(spec), [spec]);
  const managerEndpoints = useMemo(
    () => allEndpoints.filter(endpoint => !endpoint.tags.includes('openai')),
    [allEndpoints]
  );
  const openaiEndpoints = useMemo(
    () => allEndpoints.filter(endpoint => endpoint.tags.includes('openai')),
    [allEndpoints]
  );
  const endpoints = activeTab === 'manager' ? managerEndpoints : openaiEndpoints;
  const chatEndpoint = useMemo(
    () => openaiEndpoints.find(endpoint => endpoint.path === '/v1/chat/completions')
      || openaiEndpoints.find(endpoint => endpoint.path === '/api/v1/chat/completions'),
    [openaiEndpoints]
  );
  const guideExamples = useMemo(() => createGuideExamples(chatEndpoint), [chatEndpoint]);
  const activeGuide = guideExamples.find(example => example.id === activeGuideId) || guideExamples[0];

  /** Changes the API group and clears tester state that belongs to the prior group. */
  const selectApiTab = useCallback((tab) => {
    setActiveTab(tab);
    setActiveEndpoint(null);
    setResponse(null);
  }, []);

  /** Implements the standard roving-keyboard behavior for the two API group tabs. */
  function handleApiTabKeyDown(event) {
    let nextTab = null;
    if (event.key === 'ArrowLeft') nextTab = activeTab === 'manager' ? 'openai' : 'manager';
    if (event.key === 'ArrowRight') nextTab = activeTab === 'openai' ? 'manager' : 'openai';
    if (event.key === 'Home') nextTab = 'manager';
    if (event.key === 'End') nextTab = 'openai';
    if (!nextTab) return;

    event.preventDefault();
    selectApiTab(nextTab);
    window.requestAnimationFrame(() => document.getElementById(`api-tab-${nextTab}`)?.focus());
  }

  /** Selects an operation and initializes its path/query fields and example body. */
  const selectEndpoint = useCallback((endpoint, bodyOverride = undefined) => {
    setActiveEndpoint(endpoint);
    setParams(Object.fromEntries(endpoint.params.map(param => [param.name, param.defaultValue])));
    const body = bodyOverride !== undefined ? bodyOverride : endpoint.bodyExample;
    setRequestBodyText(body == null ? '' : JSON.stringify(body, null, 2));
    setRequestError('');
    setResponse(null);
    setActiveCodeLanguage('curl');
  }, []);

  /** Loads a guide request into the live tester without transforming its content parts. */
  const loadGuideInTester = useCallback((example) => {
    if (!chatEndpoint) return;
    setActiveTab('openai');
    selectEndpoint(chatEndpoint, example.body);
    window.setTimeout(() => document.getElementById('api-tester')?.scrollIntoView({ block: 'start' }), 0);
  }, [chatEndpoint, selectEndpoint]);

  /** Updates a path or query parameter while keeping its schema type. */
  const handleParamChange = useCallback((param, value) => {
    let nextValue = value;
    if (param.valueType === 'number' || param.valueType === 'integer') {
      nextValue = value === '' ? '' : Number(value);
    } else if (param.valueType === 'boolean') {
      nextValue = value === '' ? '' : value === 'true';
    }
    setParams(current => ({ ...current, [param.name]: nextValue }));
  }, []);

  /** Replaces only the model field after the user explicitly chooses a model. */
  const handleModelChange = useCallback((model) => {
    try {
      const body = JSON.parse(requestBodyText || '{}');
      setRequestBodyText(JSON.stringify({ ...body, model }, null, 2));
      setRequestError('');
    } catch {
      setRequestError('Fix the JSON request body before selecting a model.');
    }
  }, [requestBodyText]);

  /** Sends the visible body text as-is so standard multimodal bytes are not rewritten. */
  const testEndpoint = useCallback(async () => {
    if (!activeEndpoint) return;
    setRequestError('');
    setResponse(null);

    let url = activeEndpoint.path;
    const query = new URLSearchParams();
    for (const param of activeEndpoint.params) {
      const value = params[param.name];
      if ((value === '' || value === undefined) && param.required) {
        setRequestError(`${param.name} is required.`);
        return;
      }
      if (value === '' || value === undefined) continue;
      if (param.type === 'path') {
        url = url
          .replace(`{${param.name}}`, encodeURIComponent(value))
          .replace(`:${param.name}`, encodeURIComponent(value));
      } else if (param.type === 'query') {
        query.append(param.name, String(value));
      }
    }

    if (query.size > 0) url += `?${query.toString()}`;

    const hasBody = activeEndpoint.method !== 'GET' && requestBodyText.trim() !== '';
    if (activeEndpoint.bodyRequired && !hasBody) {
      setRequestError('A request body is required.');
      return;
    }
    if (hasBody && activeEndpoint.bodyContentType !== 'application/json') {
      setRequestError(`The live tester currently supports JSON bodies; this operation requires ${activeEndpoint.bodyContentType}.`);
      return;
    }
    if (hasBody) {
      try {
        JSON.parse(requestBodyText);
      } catch (error) {
        setRequestError(`Request body is not valid JSON: ${error.message}`);
        return;
      }
    }

    setLoading(true);
    try {
      const startedAt = performance.now();
      const result = await fetch(url, {
        method: activeEndpoint.method,
        headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
        body: hasBody ? requestBodyText : undefined
      });
      const duration = Math.round(performance.now() - startedAt);
      const contentType = result.headers.get('content-type') || '';
      const data = contentType.includes('application/json') ? await result.json() : await result.text();
      setResponse({ status: result.status, statusText: result.statusText, duration, data });
    } catch (error) {
      setResponse({ status: 'Error', statusText: error.message, duration: 0, data: null });
    } finally {
      setLoading(false);
    }
  }, [activeEndpoint, params, requestBodyText]);

  const operationHasModel = Boolean(activeEndpoint?.bodySchema?.properties?.model);
  const selectedModel = getBodyModel(requestBodyText);

  return (
    <div className="page api-docs-page">
      <div className="page-header">
        <h2>API Documentation</h2>
      </div>

      <p className="page-description api-docs-intro">
        Live, spec-driven reference for Llama Manager and its OpenAI-compatible multimodal API.
      </p>

      <nav className="api-resource-links glass-panel" aria-label="Machine-readable API documentation">
        <div>
          <strong>Use the same source as this page</strong>
          <span>Agent-readable references and the complete OpenAPI schema stay in sync with the server.</span>
        </div>
        <div className="api-resource-link-list">
          <a className="docs-resource-link glass-btn" href="/llms.txt">llms.txt</a>
          <a className="docs-resource-link glass-btn" href="/llms-full.txt">llms-full.txt</a>
          <a className="docs-resource-link glass-btn" href="/api/openapi.json">openapi.json</a>
        </div>
      </nav>

      <div className="api-tabs api-primary-tabs" role="tablist" aria-label="API groups">
        <button
          id="api-tab-manager"
          type="button"
          role="tab"
          aria-controls="api-panel-manager"
          aria-selected={activeTab === 'manager'}
          tabIndex={activeTab === 'manager' ? 0 : -1}
          className={`api-tab ${activeTab === 'manager' ? 'active' : ''}`}
          onClick={() => selectApiTab('manager')}
          onKeyDown={handleApiTabKeyDown}
        >
          Manager API ({managerEndpoints.length})
        </button>
        <button
          id="api-tab-openai"
          type="button"
          role="tab"
          aria-controls="api-panel-openai"
          aria-selected={activeTab === 'openai'}
          tabIndex={activeTab === 'openai' ? 0 : -1}
          className={`api-tab ${activeTab === 'openai' ? 'active' : ''}`}
          onClick={() => selectApiTab('openai')}
          onKeyDown={handleApiTabKeyDown}
        >
          OpenAI API ({openaiEndpoints.length})
        </button>
      </div>

      <section
        className="api-tab-panel"
        id={`api-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`api-tab-${activeTab}`}
        tabIndex={0}
      >
        {activeTab === 'openai' && (
          <details className="multimodal-guide-disclosure glass-panel">
            <summary>
              <span>Multimodal request guide</span>
              <span>Images, audio, video, and YouTube</span>
            </summary>
            <section className="multimodal-guide" aria-labelledby="multimodal-guide-heading">
        <div className="multimodal-guide-header">
          <div>
            <p className="api-eyebrow">Content-part guide</p>
            <h3 id="multimodal-guide-heading">Multimodal requests</h3>
            <p>
              Standard image and audio parts pass through unchanged. Llama Manager expands direct video,
              YouTube, and audio URLs before inference.
            </p>
          </div>
          <div className="multimodal-limits" aria-label="Multimodal limits">
            <span><strong>200 MB</strong> JSON body limit</span>
            <span><strong>16</strong> frames per window</span>
            <span><strong>600 s</strong> default window</span>
            <span><strong>720p</strong> YouTube ceiling</span>
          </div>
        </div>

        <div className="guide-example-grid" role="group" aria-label="Multimodal examples">
          {guideExamples.map(example => (
            <button
              key={example.id}
              type="button"
              className={`guide-example-button ${activeGuide?.id === example.id ? 'active' : ''}`}
              aria-pressed={activeGuide?.id === example.id}
              onClick={() => { setActiveGuideId(example.id); setActiveGuideLanguage('curl'); }}
            >
              <strong>{example.title}</strong>
              <span>{example.description}</span>
            </button>
          ))}
        </div>

        {activeGuide && (
          <div className="guide-example-detail">
            <div className="guide-example-detail-header">
              <div>
                <h4>{activeGuide.title}</h4>
                <p>{activeGuide.description}</p>
              </div>
              <button
                type="button"
                className="btn-primary glass-btn"
                onClick={() => loadGuideInTester(activeGuide)}
              >
                Load in tester
              </button>
            </div>
            <CodeSampleViewer
              samples={activeGuide.codeSamples}
              activeLanguage={activeGuideLanguage}
              onLanguageChange={setActiveGuideLanguage}
              label={`${activeGuide.title} languages`}
            />
          </div>
        )}

        <div className="media-digest-note">
          <strong>Long media is not silently truncated.</strong>
          <span>
            Content longer than one window is segmented and summarized. Responses report windows,
            frames used, and digest status in <code>metadata.llama_manager_media</code> for non-streaming
            responses and <code>x-llama-manager-media</code> for streams. WAV and MP3 work with
            <code>input_audio</code>; <code>audio_url</code> supports remote audio.
          </span>
        </div>
            </section>
          </details>
        )}

      {specLoading ? (
        <div className="api-spec-state glass-panel" role="status">
          <span className="api-loading-indicator" aria-hidden="true" />
          Loading <code>/api/openapi.json</code>…
        </div>
      ) : specError ? (
        <div className="api-spec-state api-spec-error glass-panel" role="alert">
          <div>
            <strong>Could not load the API specification.</strong>
            <span>{specError}</span>
          </div>
          <button type="button" className="glass-btn" onClick={fetchSpec}>Retry</button>
        </div>
      ) : (
        <div className="api-docs-layout" id="api-tester">
          <aside className="api-endpoints-list glass-panel" aria-label="Endpoints">
            <h3>{activeTab === 'manager' ? 'Manager endpoints' : 'OpenAI-compatible endpoints'}</h3>
            {activeTab === 'openai' && (
              <p className="api-base-url">Preferred SDK base URL: <code>/v1</code></p>
            )}
            <div className="endpoints-list">
              {endpoints.map(endpoint => (
                <button
                  key={endpoint.id}
                  type="button"
                  className={`endpoint-item ${activeEndpoint?.id === endpoint.id ? 'active' : ''}`}
                  aria-pressed={activeEndpoint?.id === endpoint.id}
                  title={`${endpoint.method} ${endpoint.path}: ${endpoint.summary}`}
                  onClick={() => selectEndpoint(endpoint)}
                >
                  <span className={`method-badge ${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
                  <span className="endpoint-path">{endpoint.path}</span>
                </button>
              ))}
            </div>
          </aside>

          <main className="api-endpoint-detail glass-panel">
            {activeEndpoint ? (
              <>
                <div className="endpoint-header">
                  <span className={`method-badge large ${activeEndpoint.method.toLowerCase()}`}>
                    {activeEndpoint.method}
                  </span>
                  <code className="endpoint-path-large">{activeEndpoint.path}</code>
                </div>
                <h3 className="endpoint-summary">{activeEndpoint.summary}</h3>
                <p className="endpoint-description">{activeEndpoint.description}</p>

                {activeEndpoint.params.length > 0 && (
                  <section className="params-section" aria-labelledby="parameters-heading">
                    <h4 id="parameters-heading">Path and query parameters</h4>
                    <div className="params-form">
                      {activeEndpoint.params.map(param => {
                        const inputId = `api-param-${activeEndpoint.id}-${param.name}`.replace(/[^a-z0-9-_]/gi, '-');
                        return (
                          <div key={param.name} className="param-field">
                            <label htmlFor={inputId}>
                              <span className="param-name">{param.name}</span>
                              {param.required && <span className="param-required">required</span>}
                              <span className="param-type">{param.type}</span>
                            </label>
                            <p className="param-description" id={`${inputId}-description`}>{param.description}</p>
                            {param.valueType === 'boolean' ? (
                              <select
                                id={inputId}
                                className="glass-input"
                                value={params[param.name] ?? ''}
                                aria-describedby={`${inputId}-description`}
                                onChange={event => handleParamChange(param, event.target.value)}
                              >
                                <option value="">Select a value</option>
                                <option value="true">true</option>
                                <option value="false">false</option>
                              </select>
                            ) : (
                              <input
                                id={inputId}
                                className="glass-input"
                                type={param.valueType === 'number' || param.valueType === 'integer' ? 'number' : 'text'}
                                value={params[param.name] ?? ''}
                                aria-describedby={`${inputId}-description`}
                                onChange={event => handleParamChange(param, event.target.value)}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                {activeEndpoint.bodyContentType && (
                  <section className="request-body-section" aria-labelledby="request-body-heading">
                    <div className="request-body-heading-row">
                      <h4 id="request-body-heading">Request body</h4>
                      <code>{activeEndpoint.bodyContentType}</code>
                    </div>
                    {operationHasModel && (
                      <div className="param-field model-field">
                        <span className="model-field-label" id="api-model-label">Model and advertised modalities</span>
                        {modelsLoading ? (
                          <p className="api-inline-note" role="status">Loading models from <code>/v1/models</code>…</p>
                        ) : modelsError ? (
                          <p className="api-inline-error" role="alert">{modelsError}</p>
                        ) : (
                          <div aria-labelledby="api-model-label">
                            <SearchableSelect
                              value={selectedModel}
                              onChange={handleModelChange}
                              options={models.map(model => ({
                                value: model.id,
                                label: formatModelOption(model),
                                modalities: model.modalities
                              }))}
                              placeholder="Select a model"
                              storageKey="lastApiDocsModel"
                            />
                          </div>
                        )}
                      </div>
                    )}
                    <label className="request-body-label" htmlFor="api-request-body">
                      JSON request body {activeEndpoint.bodyRequired ? '(required)' : '(optional)'}
                    </label>
                    <textarea
                      id="api-request-body"
                      className="glass-input request-body-input"
                      value={requestBodyText}
                      spellCheck="false"
                      disabled={activeEndpoint.bodyContentType !== 'application/json'}
                      aria-describedby="request-body-help"
                      onChange={event => { setRequestBodyText(event.target.value); setRequestError(''); }}
                    />
                    <p className="api-inline-note" id="request-body-help">
                      The tester sends these JSON bytes exactly as shown. It does not rewrite standard multimodal parts.
                    </p>
                  </section>
                )}

                {requestError && <p className="api-inline-error" role="alert">{requestError}</p>}

                <section className="test-section" aria-label="Live request tester">
                  <button
                    type="button"
                    className="btn-primary glass-btn"
                    disabled={loading || (activeEndpoint.bodyContentType && activeEndpoint.bodyContentType !== 'application/json')}
                    onClick={testEndpoint}
                  >
                    {loading ? 'Sending request…' : 'Send request'}
                  </button>
                </section>

                {response && (
                  <section className="response-section" aria-live="polite">
                    <h4>Response</h4>
                    <div className={`response-status ${Number(response.status) >= 200 && Number(response.status) < 300 ? 'success' : 'error'}`}>
                      <span className="status-code">{response.status}</span>
                      <span className="status-text">{response.statusText}</span>
                      <span className="response-time">{response.duration} ms</span>
                    </div>
                    <pre className="response-body">
                      {typeof response.data === 'object'
                        ? JSON.stringify(response.data, null, 2)
                        : response.data || 'No response body'}
                    </pre>
                  </section>
                )}

                <section className="endpoint-examples" aria-labelledby="client-examples-heading">
                  <h4 id="client-examples-heading">Client examples from OpenAPI</h4>
                  <CodeSampleViewer
                    samples={activeEndpoint.codeSamples}
                    activeLanguage={activeCodeLanguage}
                    onLanguageChange={setActiveCodeLanguage}
                    label={`${activeEndpoint.summary} client languages`}
                  />
                </section>
              </>
            ) : (
              <div className="no-endpoint-selected">
                <div>
                  <strong>Select an endpoint</strong>
                  <p>View its spec details, copy client examples, or send a live request.</p>
                </div>
              </div>
            )}
          </main>
        </div>
      )}
      </section>
    </div>
  );
}

export default ApiDocsPage;
