// Llama Manager — preset management page.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Lists, creates, edits, deletes, and activates llama.cpp and DS4 presets.

import React, { useState, useEffect, useCallback } from 'react';
import { API_BASE, formatBytes, formatModelName } from '../api.js';
import { SearchableSelect } from '../components/SearchableSelect.jsx';

// Presets Page
// A fresh, empty preset draft. `engine` selects which field set the create form
// shows: 'llama' (sampling knobs) vs 'ds4' (ctx / power / KV-disk / switches).
const EMPTY_PRESET = {
  id: '',
  name: '',
  description: '',
  engine: 'llama',
  modelPath: '',
  context: 0,
  config: {
    temp: 0.7,
    topP: 1.0,
    topK: 20,
    minP: 0,
    chatTemplateKwargs: '',
    extraSwitches: '--jinja'
  },
  // ds4-only launch knobs (flat body fields consumed by validatePresetEngineFields).
  ds4: {
    power: 100,
    kvDiskDir: '',
    kvDiskSpaceMb: 0,
    extraSwitches: '--rocm --cors'
  }
};

function PresetsPage({ stats }) {
  const [presets, setPresets] = useState([]);
  const [localModels, setLocalModels] = useState([]);
  const [ds4Models, setDs4Models] = useState([]);
  const [ds4GgufDir, setDs4GgufDir] = useState('');
  const [loading, setLoading] = useState({});
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingPreset, setEditingPreset] = useState(null);
  const [newPreset, setNewPreset] = useState(EMPTY_PRESET);

  // Active engine/preset (from the shared stats poll) for badging.
  const activeEngine = stats?.engine || 'llama';
  const activePresetId = stats?.preset?.id || null;

  const fetchPresets = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/presets`);
      const data = await res.json();
      setPresets(data.presets || []);
    } catch (err) {
      console.error('Failed to fetch presets:', err);
    }
  }, []);

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/models`);
      const data = await res.json();
      setLocalModels(data.localModels || []);
    } catch (err) {
      console.error('Failed to fetch models:', err);
    }
  }, []);

  // ds4 GGUFs live in a dedicated dir (never ~/models) — separate endpoint.
  const fetchDs4Models = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/ds4/models`);
      const data = await res.json();
      setDs4Models(data.models || []);
      setDs4GgufDir(data.ggufDir || '');
    } catch (err) {
      console.error('Failed to fetch ds4 models:', err);
    }
  }, []);

  useEffect(() => {
    fetchPresets();
    fetchModels();
    fetchDs4Models();
  }, [fetchPresets, fetchModels, fetchDs4Models]);

  const createPreset = async () => {
    if (!newPreset.id || !newPreset.name || !newPreset.modelPath) {
      alert('Please fill in ID, Name, and select a model');
      return;
    }
    setLoading(l => ({ ...l, create: true }));
    try {
      // ds4 presets POST a FLAT body (engine + ds4 launch knobs) that the
      // backend's validatePresetEngineFields understands; llama presets keep
      // their nested config as before.
      const body = newPreset.engine === 'ds4'
        ? {
            id: newPreset.id,
            name: newPreset.name,
            description: newPreset.description,
            engine: 'ds4',
            modelPath: newPreset.modelPath,
            context: newPreset.context,
            power: newPreset.ds4.power,
            kvDiskDir: newPreset.ds4.kvDiskDir,
            kvDiskSpaceMb: newPreset.ds4.kvDiskSpaceMb,
            extraSwitches: newPreset.ds4.extraSwitches
          }
        : { ...newPreset, engine: 'llama', ds4: undefined };
      const res = await fetch(`${API_BASE}/presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        await fetchPresets();
        setShowCreateForm(false);
        setNewPreset(EMPTY_PRESET);
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to create preset');
      }
    } catch (err) {
      console.error('Failed to create preset:', err);
    }
    setLoading(l => ({ ...l, create: false }));
  };

  const deletePreset = async (presetId) => {
    if (!confirm(`Delete preset "${presetId}"?`)) return;
    try {
      await fetch(`${API_BASE}/presets/${presetId}`, { method: 'DELETE' });
      await fetchPresets();
    } catch (err) {
      console.error('Failed to delete preset:', err);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>Presets</h2>
        <div className="page-header-actions">
          <button className="btn-primary" onClick={() => setShowCreateForm(!showCreateForm)}>
            {showCreateForm ? 'Cancel' : '+ Create Preset'}
          </button>
        </div>
      </div>

      <p className="page-description">
        Pre-configured models with specific settings for different use cases.
      </p>

      {/* Create Preset Form */}
      {showCreateForm && (
        <div className="create-preset-form">
          <h3>Create Preset</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>Preset ID</label>
              <input
                type="text"
                placeholder="my-preset"
                value={newPreset.id}
                onChange={(e) => setNewPreset(p => ({ ...p, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') }))}
              />
            </div>
            <div className="form-group">
              <label>Name</label>
              <input
                type="text"
                placeholder="My Custom Preset"
                value={newPreset.name}
                onChange={(e) => setNewPreset(p => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div className="form-group full-width">
              <label>Description</label>
              <input
                type="text"
                placeholder="Optional description"
                value={newPreset.description}
                onChange={(e) => setNewPreset(p => ({ ...p, description: e.target.value }))}
              />
            </div>
            <div className="form-group full-width">
              <label>Engine</label>
              <select
                value={newPreset.engine}
                onChange={(e) => setNewPreset(p => ({ ...p, engine: e.target.value, modelPath: '' }))}
              >
                <option value="llama">llama.cpp (router / presets)</option>
                <option value="ds4">DS4 · DeepSeek V4 (exclusive)</option>
              </select>
              {newPreset.engine === 'ds4' && (
                <span className="hint">
                  DS4 runs in exclusive mode — activating it evicts llama models and offloads other
                  requests to backends. Models load only from the ds4 GGUF dir{ds4GgufDir ? ` (${ds4GgufDir})` : ''}.
                </span>
              )}
            </div>
            <div className="form-group full-width">
              <label>Model</label>
              {newPreset.engine === 'ds4' ? (
                <SearchableSelect
                  value={newPreset.modelPath}
                  onChange={(val) => setNewPreset(p => ({ ...p, modelPath: val }))}
                  options={ds4Models.map(m => ({ value: m.name, label: `${m.name}${m.sizeBytes ? ` — ${formatBytes(m.sizeBytes)}` : ''}` }))}
                  placeholder={ds4Models.length ? 'Select a ds4 GGUF...' : 'No ds4 GGUFs found — download one from the Download tab'}
                  storageKey="lastDs4PresetModel"
                />
              ) : (
                <SearchableSelect
                  value={newPreset.modelPath}
                  onChange={(val) => setNewPreset(p => ({ ...p, modelPath: val }))}
                  options={localModels.map(m => ({ value: m.name, label: formatModelName(m) }))}
                  placeholder="Select a local model..."
                  storageKey="lastPresetModel"
                />
              )}
            </div>
            <div className="form-group">
              <label>{newPreset.engine === 'ds4' ? 'Context (--ctx, 0 = default)' : 'Context Size (0 = default)'}</label>
              <input
                type="number"
                value={newPreset.context}
                onChange={(e) => setNewPreset(p => ({ ...p, context: parseInt(e.target.value) || 0 }))}
              />
            </div>

            {/* ── llama-only sampling knobs ─────────────────────────────── */}
            {newPreset.engine === 'llama' && (
              <>
                <div className="form-group">
                  <label>Temperature</label>
                  <input
                    type="number"
                    step="0.1"
                    value={newPreset.config.temp}
                    onChange={(e) => setNewPreset(p => ({ ...p, config: { ...p.config, temp: parseFloat(e.target.value) || 0.7 } }))}
                  />
                </div>
                <div className="form-group">
                  <label>Top P</label>
                  <input
                    type="number"
                    step="0.1"
                    value={newPreset.config.topP}
                    onChange={(e) => setNewPreset(p => ({ ...p, config: { ...p.config, topP: parseFloat(e.target.value) || 1.0 } }))}
                  />
                </div>
                <div className="form-group">
                  <label>Top K</label>
                  <input
                    type="number"
                    value={newPreset.config.topK}
                    onChange={(e) => setNewPreset(p => ({ ...p, config: { ...p.config, topK: parseInt(e.target.value) || 0 } }))}
                  />
                </div>
                <div className="form-group full-width">
                  <label>Extra Switches</label>
                  <input
                    type="text"
                    placeholder="--jinja"
                    value={newPreset.config.extraSwitches}
                    onChange={(e) => setNewPreset(p => ({ ...p, config: { ...p.config, extraSwitches: e.target.value } }))}
                  />
                </div>
                <div className="form-group full-width">
                  <label>Chat Template Kwargs (JSON)</label>
                  <input
                    type="text"
                    placeholder='{"reasoning_effort": "high"}'
                    value={newPreset.config.chatTemplateKwargs}
                    onChange={(e) => setNewPreset(p => ({ ...p, config: { ...p.config, chatTemplateKwargs: e.target.value } }))}
                  />
                </div>
              </>
            )}

            {/* ── ds4-only launch knobs ─────────────────────────────────── */}
            {newPreset.engine === 'ds4' && (
              <>
                <div className="form-group">
                  <label>Power (%)</label>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={newPreset.ds4.power}
                    onChange={(e) => setNewPreset(p => ({ ...p, ds4: { ...p.ds4, power: parseInt(e.target.value) || 100 } }))}
                  />
                </div>
                <div className="form-group">
                  <label>KV Disk Cache Size (MB, 0 = off)</label>
                  <input
                    type="number"
                    min="0"
                    value={newPreset.ds4.kvDiskSpaceMb}
                    onChange={(e) => setNewPreset(p => ({ ...p, ds4: { ...p.ds4, kvDiskSpaceMb: parseInt(e.target.value) || 0 } }))}
                  />
                </div>
                <div className="form-group full-width">
                  <label>KV Disk Cache Dir</label>
                  <input
                    type="text"
                    placeholder="/path/to/kv-cache (optional)"
                    value={newPreset.ds4.kvDiskDir}
                    onChange={(e) => setNewPreset(p => ({ ...p, ds4: { ...p.ds4, kvDiskDir: e.target.value } }))}
                  />
                </div>
                <div className="form-group full-width">
                  <label>Extra Switches</label>
                  <input
                    type="text"
                    placeholder="--rocm --cors"
                    value={newPreset.ds4.extraSwitches}
                    onChange={(e) => setNewPreset(p => ({ ...p, ds4: { ...p.ds4, extraSwitches: e.target.value } }))}
                  />
                </div>
              </>
            )}
          </div>
          <div className="form-actions">
            <button className="btn-secondary" onClick={() => setShowCreateForm(false)}>Cancel</button>
            <button className="btn-primary" onClick={createPreset} disabled={loading.create}>
              {loading.create ? 'Creating...' : 'Create Preset'}
            </button>
          </div>
        </div>
      )}

      {/* Presets Section */}
      <section className="page-section">
        <h3>Presets</h3>
        <div className="presets-grid">
          {presets.map((preset) => {
            // Determine display values - support both hfRepo format and legacy repo/quantization
            const modelDisplay = preset.hfRepo ||
              (preset.repo ? `${preset.repo}:${preset.quantization || 'Q5_K_M'}` : null) ||
              preset.modelPath?.split('/').pop() ||
              'Unknown';
            const isDs4 = preset.engine === 'ds4';
            const isActiveDs4 = isDs4 && activeEngine === 'ds4' && activePresetId === preset.id;

            return (
              <div key={preset.id} className={`preset-card${isActiveDs4 ? ' active-ds4' : ''}`}>
                <div className="preset-header">
                  <h3>{preset.name}</h3>
                  {isDs4 && (
                    <span className="engine-badge ds4" title="DeepSeek V4 engine — runs in exclusive mode">
                      {isActiveDs4 ? 'DS4 · exclusive' : 'DS4'}
                    </span>
                  )}
                </div>

                {isActiveDs4 && (
                  <p className="preset-active-note">
                    Active in exclusive mode — llama models are evicted and other requests offload to backends.
                  </p>
                )}

                <p className="preset-description">{preset.description}</p>

                <div className="preset-details">
                  <div className="detail-row">
                    <span className="detail-label">Model</span>
                    <span className="detail-value">{modelDisplay}</span>
                  </div>
                  {preset.context > 0 && (
                    <div className="detail-row">
                      <span className="detail-label">Context</span>
                      <span className="detail-value">{preset.context.toLocaleString()}</span>
                    </div>
                  )}
                </div>

                <div className="preset-actions">
                  <button
                    className="btn-danger"
                    onClick={() => deletePreset(preset.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export default PresetsPage;
