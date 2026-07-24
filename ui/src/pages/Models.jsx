// Llama Manager — model management page.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Manages local model inventory, load state, deletion, and the dedicated
// embedding model selection in responsive glass panels.

import React, { useState, useEffect, useCallback } from 'react';
import { API_BASE, formatBytes } from '../api.js';
import '../styles/pages.css';

/**
 * Embedding model selector — lets the user choose a local GGUF to serve on
 * the dedicated embedding port (used by /api/v1/embeddings). The chosen model
 * is persisted via POST /api/embed/model and the embed server is restarted.
 */
function EmbeddingModelSelector() {
  const [current, setCurrent] = React.useState(null);
  const [models, setModels] = React.useState([]);
  React.useEffect(() => {
    fetch(`${API_BASE}/embed/model`).then(r => r.json()).then(setCurrent).catch(() => {});
    fetch(`${API_BASE}/models`).then(r => r.json()).then(d => setModels(d.localModels || [])).catch(() => {});
  }, []);
  const choose = async (model) => {
    await fetch(`${API_BASE}/embed/model`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, enabled: true }) });
    const r = await fetch(`${API_BASE}/embed/model`); setCurrent(await r.json());
  };
  return (
    <div className="card glass-panel">
      <h3>Embedding model</h3>
      <p className="hint">Served on a dedicated port for <code>/api/v1/embeddings</code>. Current: <strong>{current?.model || 'none'}</strong></p>
      <select className="glass-input" defaultValue="" onChange={e => e.target.value && choose(e.target.value)}>
        <option value="" disabled>Select a downloaded model…</option>
        {models.map(m => { const v = m.path || m.name; return <option key={v} value={v}>{m.alias || m.name}</option>; })}
      </select>
    </div>
  );
}

// Models Page
function ModelsPage({ stats }) {
  const [serverModels, setServerModels] = useState([]);
  const [localModels, setLocalModels] = useState([]);
  const [modelsDir, setModelsDir] = useState('');
  const [loading, setLoading] = useState({});
  const [editingAlias, setEditingAlias] = useState(null);
  const [aliasInput, setAliasInput] = useState('');

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/models`);
      const data = await res.json();
      setServerModels(data.serverModels || []);
      setLocalModels(data.localModels || []);
      setModelsDir(data.modelsDir || '');
    } catch (err) {
      console.error('Failed to fetch models:', err);
    }
  }, []);

  useEffect(() => {
    fetchModels();
    const interval = setInterval(fetchModels, 10000);
    return () => clearInterval(interval);
  }, [fetchModels]);

  const loadModel = async (modelName) => {
    setLoading(l => ({ ...l, [modelName]: true }));
    try {
      await fetch(`${API_BASE}/models/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName })
      });
      await fetchModels();
    } catch (err) {
      console.error('Failed to load model:', err);
    }
    setLoading(l => ({ ...l, [modelName]: false }));
  };

  const unloadModel = async (modelName) => {
    setLoading(l => ({ ...l, [modelName]: true }));
    try {
      await fetch(`${API_BASE}/models/unload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName })
      });
      await fetchModels();
    } catch (err) {
      console.error('Failed to unload model:', err);
    }
    setLoading(l => ({ ...l, [modelName]: false }));
  };

  const saveAlias = async (modelName) => {
    try {
      await fetch(`${API_BASE}/models/aliases/${encodeURIComponent(modelName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: aliasInput.trim() || null })
      });
      await fetchModels();
    } catch (err) {
      console.error('Failed to save alias:', err);
    }
    setEditingAlias(null);
    setAliasInput('');
  };

  const startEditAlias = (model) => {
    setEditingAlias(model.name);
    setAliasInput(model.alias || '');
  };

  const getModelStatus = (modelName) => {
    return serverModels.some(m =>
      m.id === modelName || m.model === modelName || (m.id && m.id.includes(modelName))
    ) ? 'loaded' : 'unloaded';
  };

  // Get display name (alias or short name)
  const getDisplayName = (model) => {
    if (model.alias) return model.alias;
    // Extract just the filename from the path
    const parts = model.name.split('/');
    return parts[parts.length - 1];
  };

  // Find alias for a loaded model
  const getAliasForLoadedModel = (modelId) => {
    const localModel = localModels.find(m => m.name === modelId);
    return localModel?.alias || null;
  };

  // Healthy when EITHER the llama server is up OR the ds4 engine is active and
  // serving (in ds4-exclusive mode llama is intentionally stopped, so ds4 health
  // is the real signal — otherwise the chat/status would show "not running").
  const isHealthy = stats?.llama?.status === 'ok' || stats?.ds4?.status === 'ok';
  const isSingleMode = stats?.mode === 'single';

  if (isSingleMode) {
    return (
      <div className="page">
        <div className="page-header">
          <h2>Models</h2>
        </div>
        <div className="empty-state">
          <p>Model management is disabled in single-model mode.</p>
          <p className="hint">Switch to router mode from the Presets page to manage multiple models.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>Models</h2>
        <span className="models-dir">{modelsDir}</span>
      </div>

      {/* Embedding Model Selector */}
      <EmbeddingModelSelector />

      {/* Loaded Models */}
      {serverModels.length > 0 && (
        <section className="page-section glass-panel">
          <h3>Loaded Models</h3>
          <div className="models-grid">
            {serverModels.map((model) => {
              const alias = getAliasForLoadedModel(model.id);
              return (
                <div key={model.id} className="model-card active">
                  <div className="model-header">
                    <h4 title={model.id}>{alias || model.id.split('/').pop()}</h4>
                    <span className="badge success">Loaded</span>
                  </div>
                  {alias && <div className="model-path">{model.id}</div>}
                  <div className="model-actions">
                    <button
                      className="btn-secondary glass-btn"
                      onClick={() => unloadModel(model.id)}
                      disabled={loading[model.id]}
                    >
                      {loading[model.id] ? 'Unloading...' : 'Unload'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Local Models */}
      <section className="page-section glass-panel">
        <h3>Local Models</h3>
        {localModels.length === 0 ? (
          <div className="empty-state">
            <p>No models found in {modelsDir}</p>
            <p className="hint">Download models from the Download page</p>
          </div>
        ) : (
          <div className="models-grid">
            {localModels.map((model) => {
              const status = getModelStatus(model.name);
              const isLoaded = status === 'loaded';
              const isEditing = editingAlias === model.name;

              return (
                <div key={model.path} className={`model-card ${isLoaded ? 'active' : ''} ${model.incomplete ? 'incomplete' : ''}`}>
                  <div className="model-header">
                    {isEditing ? (
                      <div className="alias-edit">
                        <input
                          type="text"
                          className="glass-input"
                          value={aliasInput}
                          onChange={(e) => setAliasInput(e.target.value)}
                          placeholder="Enter alias..."
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveAlias(model.name);
                            if (e.key === 'Escape') { setEditingAlias(null); setAliasInput(''); }
                          }}
                        />
                        <button className="btn-small glass-btn" onClick={() => saveAlias(model.name)}>Save</button>
                        <button className="btn-small btn-secondary glass-btn" onClick={() => { setEditingAlias(null); setAliasInput(''); }}>Cancel</button>
                      </div>
                    ) : (
                      <>
                        <h4 title={model.name}>
                          {getDisplayName(model)}
                          <button
                            className="alias-edit-btn"
                            onClick={() => startEditAlias(model)}
                            title={model.alias ? 'Edit alias' : 'Set alias'}
                          >
                            ✎
                          </button>
                        </h4>
                        {isLoaded && <span className="badge success">Loaded</span>}
                        {model.incomplete && <span className="badge warning">Incomplete</span>}
                        {model.isSplit && !model.incomplete && <span className="badge info">{model.partCount} parts</span>}
                      </>
                    )}
                  </div>
                  {model.alias && !isEditing && (
                    <div className="model-path">{model.name}</div>
                  )}
                  <div className="model-info">
                    <span>{formatBytes(model.size)}</span>
                  </div>
                  <div className="model-actions">
                    {isLoaded ? (
                      <button
                        className="btn-secondary glass-btn"
                        onClick={() => unloadModel(model.name)}
                        disabled={loading[model.name] || !isHealthy}
                      >
                        {loading[model.name] ? 'Unloading...' : 'Unload'}
                      </button>
                    ) : (
                      <button
                        className="btn-primary glass-btn"
                        onClick={() => loadModel(model.name)}
                        disabled={loading[model.name] || !isHealthy || model.incomplete}
                      >
                        {loading[model.name] ? 'Loading...' : 'Load'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

export default ModelsPage;
