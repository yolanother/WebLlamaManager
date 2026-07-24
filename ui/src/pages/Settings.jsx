// Llama Manager — settings page.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Provides appearance, general configuration, model mappings, remote backends,
// and llama.cpp update controls in glass-aligned settings panels.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { API_BASE } from '../api.js';
import { resolveLlamaUpdateView } from '../llama-update-policy.js';
import { DEFAULT_THEME_ID } from '../theme/manifest.js';
import {
  getColorScheme,
  rerunEffectsProbe,
  selectSiteTheme,
  setColorScheme,
  setEffectsMode,
  useEffectsMode,
  useSiteTheme,
} from '../theme/siteTheme.js';
import '../styles/pages.css';

/**
 * Settings section that lets the user select a host-architecture "site theme"
 * for previewing/testing platform branding. Lists "Default" plus every theme
 * discovered in the runtime manifest; renders nothing until the manifest has
 * loaded and only when at least one theme is available. Selecting a theme
 * applies it instantly and persists it (localStorage `siteTheme`).
 * @returns {(JSX.Element|null)} The site-theme field, or `null` when no themes exist.
 */
function SiteThemeSection() {
  const { themes, selectedId, ready } = useSiteTheme();

  if (!ready || themes.length === 0) return null;

  return (
    <div className="appearance-site-theme">
      <h3>Site Theme</h3>
      <div className="settings-grid">
        <div className="setting-item">
          <label htmlFor="siteTheme">Site theme</label>
          <p className="setting-hint">
            Preview a platform-branded appearance. Themes are supplied by the host build;
            "Default" is always available. Applied instantly and remembered on this device.
          </p>
          <select
            id="siteTheme"
            className="glass-input"
            value={selectedId}
            onChange={(e) => selectSiteTheme(e.target.value)}
          >
            <option value={DEFAULT_THEME_ID}>Default</option>
            {themes.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

function AppearanceSection() {
  const [scheme, setScheme] = useState(() => getColorScheme());
  const effects = useEffectsMode();
  const schemeOptions = [
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
    { value: 'system', label: 'System' },
  ];
  const effectsOptions = [
    { value: 'auto', label: 'Auto' },
    { value: 'glass', label: 'Glass' },
    { value: 'simple', label: 'Simple' },
  ];

  const selectScheme = (value) => {
    setColorScheme(value);
    setScheme(value);
  };

  const effectsHint = effects.preference === 'auto'
    ? `Auto — ${effects.resolved} (${
      effects.reason === 'checking'
        ? 'checking performance…'
        : effects.reason === 'reduced-transparency'
          ? 'reduced transparency'
          : effects.reason === 'unsupported'
            ? 'backdrop filter unavailable'
            : 'measured'
    })`
    : `${effects.preference === 'glass' ? 'Glass' : 'Simple'} — manually selected`;

  return (
    <section className="page-section glass-panel appearance-section">
      <div className="appearance-section__header">
        <h3>Appearance</h3>
        <p>Choose the interface color scheme, effects, and optional host-provided site theme.</p>
      </div>
      <div className="scheme-setting">
        <span id="color-scheme-label">Color scheme</span>
        <div
          className="scheme-segmented"
          role="group"
          aria-labelledby="color-scheme-label"
        >
          {schemeOptions.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`glass-btn scheme-option ${scheme === value ? 'active' : ''}`}
              aria-pressed={scheme === value}
              onClick={() => selectScheme(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="setting-hint">
          System follows your operating system preference and updates automatically.
        </p>
      </div>
      <div className="scheme-setting">
        <span id="effects-mode-label">Effects</span>
        <div
          className="scheme-segmented"
          role="group"
          aria-labelledby="effects-mode-label"
        >
          {effectsOptions.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`glass-btn scheme-option ${effects.preference === value ? 'active' : ''}`}
              aria-pressed={effects.preference === value}
              onClick={() => setEffectsMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="setting-hint" aria-live="polite">{effectsHint}</p>
        <div>
          <button
            type="button"
            className="btn-secondary btn-small glass-btn"
            disabled={effects.preference !== 'auto'}
            title={
              effects.preference === 'auto'
                ? 'Clear the cached result and measure visible frame performance again'
                : 'Select Auto to run the performance check'
            }
            onClick={rerunEffectsProbe}
          >
            Re-run performance check
          </button>
        </div>
      </div>
      <SiteThemeSection />
    </section>
  );
}

// Settings Page
function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [activeTab, setActiveTab] = useState('general'); // 'general' | 'hosts' | 'mapping'
  // Real model ids for the default-big/default-small target dropdowns (the synthetic
  // alias entries are excluded so an alias can't be pointed at itself).
  const [modelOptions, setModelOptions] = useState([]);

  useEffect(() => {
    fetch(`${API_BASE}/v1/models`)
      .then(r => r.json())
      .then(d => setModelOptions((d.data || []).filter(m => m.status !== 'alias').map(m => m.id)))
      .catch(() => {});
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/settings`);
      const data = await res.json();
      setSettings(data.settings);
      setDefaults(data.defaults);
    } catch (err) {
      console.error('Failed to fetch settings:', err);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const saveSettings = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      const data = await res.json();
      if (data.success) {
        setMessage({ type: 'success', text: data.message });
        // Refresh so the masked HF-token status updates and the input clears.
        fetchSettings();
      } else {
        setMessage({ type: 'error', text: data.error });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to save settings' });
    }
    setSaving(false);
  };

  const restartServer = async () => {
    setMessage({ type: 'info', text: 'Restarting server...' });
    try {
      await fetch(`${API_BASE}/server/stop`, { method: 'POST' });
      await new Promise(r => setTimeout(r, 2000));
      await fetch(`${API_BASE}/server/start`, { method: 'POST' });
      setMessage({ type: 'success', text: 'Server restarted with new settings' });
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to restart server' });
    }
  };

  const updateSetting = (key, value) => {
    setSettings(s => ({ ...s, [key]: value }));
  };

  if (loading) {
    return (
      <div className="page">
        <div className="page-header">
          <h2>Settings</h2>
        </div>
        <div className="empty-state">
          <p>Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page settings-page">
      <div className="page-header">
        <h2>Settings</h2>
        <div className="header-actions">
          {activeTab === 'general' && (
            <>
              <button className="btn-secondary glass-btn" onClick={restartServer}>
                Restart Server
              </button>
              <button className="btn-primary glass-btn" onClick={saveSettings} disabled={saving}>
                {saving ? 'Saving...' : 'Save Settings'}
              </button>
            </>
          )}
        </div>
      </div>

      {message && (
        <div className={`settings-message ${message.type}`}>
          {message.text}
        </div>
      )}

      <div className="settings-tabs">
        <button className={`tab-btn glass-btn ${activeTab === 'general' ? 'active' : ''}`} onClick={() => setActiveTab('general')}>General</button>
        <button className={`tab-btn glass-btn ${activeTab === 'hosts' ? 'active' : ''}`} onClick={() => setActiveTab('hosts')}>Remote Hosts</button>
        <button className={`tab-btn glass-btn ${activeTab === 'mapping' ? 'active' : ''}`} onClick={() => setActiveTab('mapping')}>Model Mapping</button>
      </div>

      {activeTab === 'general' && (
        <>
      <AppearanceSection />

      <section className="page-section glass-panel">
        <h3>HuggingFace</h3>
        <div className="settings-grid">
          <div className="setting-item">
            <label htmlFor="hfToken">HuggingFace Token</label>
            <p className="setting-hint">
              Used to download gated or private models (e.g. <code>google/gemma-*</code>).
              Stored in config and preferred over the <code>HF_TOKEN</code> environment variable.
              {settings?.hasHfToken
                ? ` Currently set${settings?.hfTokenMask ? ` (${settings.hfTokenMask})` : ''}${settings?.hfTokenSource ? ` via ${settings.hfTokenSource}` : ''}.`
                : ' Not set.'}
            </p>
            <input
              type="password"
              id="hfToken"
              className="glass-input"
              autoComplete="off"
              placeholder={settings?.hasHfToken ? 'Enter a new token to replace the current one' : 'hf_...'}
              value={settings?.hfToken || ''}
              onChange={(e) => updateSetting('hfToken', e.target.value)}
            />
          </div>
        </div>
      </section>

      <section className="page-section glass-panel">
        <h3>Model Loading</h3>
        <div className="settings-grid">
          <div className="setting-item">
            <label htmlFor="contextSize">Context Size</label>
            <p className="setting-hint">
              Maximum context window size. Larger values use more VRAM and take longer to warm up.
              Default: {defaults?.contextSize?.toLocaleString() || '8192'}
            </p>
            <select
              id="contextSize"
              className="glass-input"
              value={settings?.contextSize || 8192}
              onChange={(e) => updateSetting('contextSize', parseInt(e.target.value))}
            >
              <option value={2048}>2,048 (Fast)</option>
              <option value={4096}>4,096</option>
              <option value={8192}>8,192</option>
              <option value={16384}>16,384</option>
              <option value={32768}>32,768</option>
              <option value={65536}>65,536</option>
              <option value={131072}>131,072 (Slow warmup)</option>
              <option value={262144}>262,144 (Very slow)</option>
            </select>
          </div>

          <div className="setting-item">
            <label htmlFor="modelsMax">Max Loaded Models</label>
            <p className="setting-hint">
              Maximum number of models to keep loaded simultaneously in router mode.
            </p>
            <select
              id="modelsMax"
              className="glass-input"
              value={settings?.modelsMax || 2}
              onChange={(e) => updateSetting('modelsMax', parseInt(e.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>

          <div className="setting-item">
            <label htmlFor="gpuLayers">GPU Layers</label>
            <p className="setting-hint">
              Number of layers to offload to GPU. Use 99 for full GPU offload.
            </p>
            <input
              type="number"
              id="gpuLayers"
              className="glass-input"
              value={settings?.gpuLayers || 99}
              onChange={(e) => updateSetting('gpuLayers', parseInt(e.target.value))}
              min={0}
              max={999}
            />
          </div>
        </div>
      </section>

      <section className="page-section glass-panel">
        <h3>Performance Options</h3>
        <div className="settings-grid">
          <div className="setting-item checkbox">
            <label>
              <input
                type="checkbox"
                checked={settings?.noWarmup || false}
                onChange={(e) => updateSetting('noWarmup', e.target.checked)}
              />
              <span>Skip Warmup</span>
            </label>
            <p className="setting-hint">
              Skip model warmup on load. Faster startup but first inference may be slower.
            </p>
          </div>

          <div className="setting-item checkbox">
            <label>
              <input
                type="checkbox"
                checked={settings?.flashAttn || false}
                onChange={(e) => updateSetting('flashAttn', e.target.checked)}
              />
              <span>Flash Attention</span>
            </label>
            <p className="setting-hint">
              Enable flash attention for faster inference (requires compatible GPU).
            </p>
          </div>

          <div className="setting-item checkbox">
            <label>
              <input
                type="checkbox"
                checked={settings?.autoStart || false}
                onChange={(e) => updateSetting('autoStart', e.target.checked)}
              />
              <span>Auto-Start Server</span>
            </label>
            <p className="setting-hint">
              Automatically start the llama server when the manager starts.
            </p>
          </div>
        </div>
      </section>

      <section className="page-section glass-panel">
        <h3>Inference Defaults</h3>
        <div className="settings-grid">
          <div className="setting-item">
            <label htmlFor="defaultReasoningEffort">Default Reasoning Effort</label>
            <p className="setting-hint">
              Inject reasoning_effort into chat_template_kwargs for models that support it. Client-set values always take priority.
            </p>
            <select
              id="defaultReasoningEffort"
              className="glass-input"
              value={settings?.defaultReasoningEffort || ''}
              onChange={(e) => updateSetting('defaultReasoningEffort', e.target.value || null)}
            >
              <option value="">Disabled</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>

          <div className="setting-item">
            <label htmlFor="defaultBigModel">Default Big Model</label>
            <p className="setting-hint">
              Target for the <code>default-big</code> model alias. Clients can request
              <code>default-big</code> instead of a concrete name to avoid unnecessary model shifts.
            </p>
            <select
              id="defaultBigModel"
              className="glass-input"
              value={settings?.defaultBigModel || ''}
              onChange={(e) => updateSetting('defaultBigModel', e.target.value || null)}
            >
              <option value="">— none —</option>
              {[...new Set([settings?.defaultBigModel, ...modelOptions].filter(Boolean))].map(id => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          </div>

          <div className="setting-item">
            <label htmlFor="defaultSmallModel">Default Small Model</label>
            <p className="setting-hint">
              Target for the <code>default-small</code> model alias.
            </p>
            <select
              id="defaultSmallModel"
              className="glass-input"
              value={settings?.defaultSmallModel || ''}
              onChange={(e) => updateSetting('defaultSmallModel', e.target.value || null)}
            >
              <option value="">— none —</option>
              {[...new Set([settings?.defaultSmallModel, ...modelOptions].filter(Boolean))].map(id => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="model-overrides-section">
          <label>Per-Model Overrides</label>
          <p className="setting-hint">
            Override reasoning effort for specific models. Use * as wildcard (e.g. gpt-oss*).
          </p>
          <div className="model-overrides-list">
            {Object.entries(settings?.modelReasoningEffort || {}).map(([pattern, effort]) => (
              <div key={pattern} className="model-override-row">
                <span className="model-override-pattern">{pattern}</span>
                <select
                  className="glass-input"
                  value={effort}
                  onChange={(e) => {
                    const updated = { ...settings.modelReasoningEffort };
                    updated[pattern] = e.target.value;
                    updateSetting('modelReasoningEffort', updated);
                  }}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
                <button
                  className="btn btn-sm btn-danger glass-btn"
                  onClick={() => {
                    const updated = { ...settings.modelReasoningEffort };
                    delete updated[pattern];
                    updateSetting('modelReasoningEffort', updated);
                  }}
                  title="Remove override"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div className="model-override-add">
            <input
              type="text"
              className="glass-input"
              placeholder="Model pattern (e.g. gpt-oss*)"
              id="newOverridePattern"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const pattern = e.target.value.trim();
                  if (pattern && !(settings?.modelReasoningEffort || {})[pattern]) {
                    updateSetting('modelReasoningEffort', { ...settings.modelReasoningEffort, [pattern]: 'high' });
                    e.target.value = '';
                  }
                }
              }}
            />
            <button
              className="btn btn-sm glass-btn"
              onClick={() => {
                const input = document.getElementById('newOverridePattern');
                const pattern = input.value.trim();
                if (pattern && !(settings?.modelReasoningEffort || {})[pattern]) {
                  updateSetting('modelReasoningEffort', { ...settings.modelReasoningEffort, [pattern]: 'high' });
                  input.value = '';
                }
              }}
            >
              Add
            </button>
          </div>
        </div>
      </section>

      <section className="page-section glass-panel">
        <h3>Logging</h3>
        <div className="settings-grid">
          <div className="setting-item checkbox">
            <label>
              <input
                type="checkbox"
                checked={settings?.requestLogging || false}
                onChange={(e) => updateSetting('requestLogging', e.target.checked)}
              />
              <span>Request Logging</span>
            </label>
            <p className="setting-hint">
              Log HTTP requests with method, path, status, and timing. View in the Logs page under Request Logs tab.
            </p>
          </div>
          <div className="setting-item">
            <label htmlFor="maxConcurrentRequests">Max Concurrent Requests</label>
            <p className="setting-hint">
              Maximum number of requests sent to llama.cpp simultaneously. Set to 1 to queue requests (recommended for limited memory).
            </p>
            <input
              type="number"
              id="maxConcurrentRequests"
              className="glass-input"
              min="1"
              max="32"
              value={settings?.maxConcurrentRequests || 1}
              onChange={(e) => updateSetting('maxConcurrentRequests', parseInt(e.target.value))}
            />
          </div>
          <div className="setting-item">
            <label htmlFor="localStallMs">Stall Watchdog (seconds)</label>
            <p className="setting-hint">
              Abort a local request if no token is received for this long. The timer resets on every token, so long generations are safe — only a truly wedged upstream gets killed. Set to 0 to disable.
            </p>
            <input
              type="number"
              id="localStallMs"
              className="glass-input"
              min="0"
              max="3600"
              value={Math.round((settings?.localStallMs ?? 60000) / 1000)}
              onChange={(e) => updateSetting('localStallMs', parseInt(e.target.value) * 1000)}
            />
          </div>
        </div>
      </section>

      <section className="page-section glass-panel">
        <h3>Dashboard</h3>
        <div className="settings-grid">
          <div className="setting-item">
            <label htmlFor="fullscreenInterval">Fullscreen Cycle Interval</label>
            <p className="setting-hint">
              How long each page is displayed in fullscreen dashboard mode (in seconds).
            </p>
            <input
              type="number"
              id="fullscreenInterval"
              className="glass-input"
              value={Math.round((settings?.fullscreenInterval || 30000) / 1000)}
              onChange={(e) => updateSetting('fullscreenInterval', parseInt(e.target.value) * 1000)}
              min={5}
              max={300}
            />
          </div>
        </div>
      </section>

      <LlamaCppUpdateSection />

      <section className="page-section glass-panel">
        <h3>Current Configuration</h3>
        <pre className="settings-preview">
          {JSON.stringify(settings, null, 2)}
        </pre>
      </section>
        </>
      )}

      {activeTab === 'hosts' && (
        <BackendsSection settings={settings} updateSetting={updateSetting} setMessage={setMessage} />
      )}

      {activeTab === 'mapping' && (
        <ModelMappingSection setMessage={setMessage} />
      )}
    </div>
  );
}

// Model Mapping Section — unified table mapping local model ids to a remote host's model.
// Rows are flattened from every backend's modelMapping; saving rebuilds each
// backend's mapping and PUTs it back. Local and remote fields are datalist
// comboboxes (pick a known model or free-type a custom id for models that may not
// be on the local server).
function ModelMappingSection({ setMessage }) {
  const [backends, setBackends] = React.useState([]);
  const [localModels, setLocalModels] = React.useState([]);
  const [remoteByBackend, setRemoteByBackend] = React.useState({}); // backendId -> string[]
  const [rows, setRows] = React.useState([]); // { rowId, backendId, localKey, remoteValue }
  const [saving, setSaving] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const rowIdRef = React.useRef(1);
  // Snapshot of each backend's mapping at load time, so save only rewrites the
  // hosts whose mapping actually changed — existing mappings are never clobbered.
  const originalRef = React.useRef({});

  const loadAll = React.useCallback(async () => {
    let bks = [];
    try { const r = await fetch(`${API_BASE}/backends`); bks = (await r.json()).backends || []; } catch { /* ignore */ }
    setBackends(bks);

    // Flatten existing mappings into editable rows + snapshot the originals.
    const rs = [];
    const orig = {};
    for (const b of bks) {
      orig[b.id] = { ...(b.modelMapping || {}) };
      for (const [k, v] of Object.entries(b.modelMapping || {})) {
        rs.push({ rowId: rowIdRef.current++, backendId: b.id, localKey: k, remoteValue: v });
      }
    }
    originalRef.current = orig;
    setRows(rs);

    // Local model suggestions: /v1/models ids (now includes downloaded models)
    // unioned with any model ids already used as mapping keys.
    let lm = [];
    try { const r = await fetch(`${API_BASE}/v1/models`); lm = ((await r.json()).data || []).map(m => m.id).filter(Boolean); } catch { /* ignore */ }
    const keys = new Set(lm);
    for (const b of bks) for (const k of Object.keys(b.modelMapping || {})) if (k && k !== '*') keys.add(k);
    setLocalModels([...keys].sort());

    // Seed remote-model suggestions per host from the cached /models endpoint.
    const rm = {};
    await Promise.all(bks.map(async b => {
      try { rm[b.id] = (await (await fetch(`${API_BASE}/backends/${b.id}/models`)).json()).models || []; }
      catch { rm[b.id] = []; }
    }));
    setRemoteByBackend(rm);
  }, []);

  React.useEffect(() => { loadAll(); }, [loadAll]);

  const refreshRemote = async () => {
    setRefreshing(true);
    const rm = { ...remoteByBackend };
    await Promise.all(backends.map(async b => {
      try {
        const r = await fetch(`${API_BASE}/backends/${b.id}/refresh-models`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
        });
        const d = await r.json();
        if (d.success) rm[b.id] = d.remoteModels || [];
      } catch { /* leave existing */ }
    }));
    setRemoteByBackend(rm);
    setRefreshing(false);
  };

  const updateRow = (rowId, patch) => setRows(rs => rs.map(r => r.rowId === rowId ? { ...r, ...patch } : r));
  const removeRow = (rowId) => setRows(rs => rs.filter(r => r.rowId !== rowId));
  const addRow = () => setRows(rs => [...rs, { rowId: rowIdRef.current++, backendId: backends[0]?.id || '', localKey: '', remoteValue: '' }]);

  // Stable stringify (sorted keys) so key-order differences don't read as changes.
  const norm = (m) => JSON.stringify(Object.fromEntries(Object.entries(m || {}).sort(([a], [b]) => a.localeCompare(b))));

  const save = async () => {
    if (!backends.length) { setMessage({ type: 'error', text: 'Add a remote host first (Remote Hosts tab).' }); return; }
    setSaving(true);
    // Rebuild each host's mapping from its rows.
    const mapByBackend = {};
    for (const b of backends) mapByBackend[b.id] = {};
    for (const r of rows) {
      if (!r.backendId || !r.localKey) continue;
      (mapByBackend[r.backendId] = mapByBackend[r.backendId] || {})[r.localKey] = r.remoteValue || '';
    }
    // Only PUT hosts whose mapping actually changed — never rewrite untouched ones.
    const changed = backends.filter(b => norm(mapByBackend[b.id]) !== norm(originalRef.current[b.id]));
    if (changed.length === 0) {
      setSaving(false);
      setMessage({ type: 'info', text: 'No mapping changes to save.' });
      return;
    }
    let ok = 0, fail = 0;
    for (const b of changed) {
      try {
        const res = await fetch(`${API_BASE}/backends/${b.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelMapping: mapByBackend[b.id] })
        });
        (await res.json()).success ? ok++ : fail++;
      } catch { fail++; }
    }
    setSaving(false);
    setMessage(fail
      ? { type: 'error', text: `Saved ${ok} host(s); ${fail} failed` }
      : { type: 'success', text: `Model mappings saved (${ok} host${ok === 1 ? '' : 's'} updated)` });
    loadAll();
  };

  return (
    <section className="page-section glass-panel">
      <h3>Model Mapping</h3>
      <p className="setting-hint" style={{ marginBottom: '12px' }}>
        Map a local model id (what clients request) to the model name on a remote host. Pick from the list or
        type a custom id for models that aren&apos;t on the local server. Use <code>*</code> as the local model to
        match all models for that host.
      </p>
      {backends.length === 0 ? (
        <p className="setting-hint">No remote hosts configured. Add one in the <strong>Remote Hosts</strong> tab first.</p>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', gap: '8px' }}>
            <button className="btn-secondary glass-btn" style={{ padding: '4px 12px', fontSize: '0.85em' }} onClick={refreshRemote} disabled={refreshing}>
              {refreshing ? 'Refreshing…' : '↻ Refresh remote models'}
            </button>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn-secondary glass-btn" style={{ padding: '4px 12px', fontSize: '0.85em' }} onClick={addRow}>+ Add Mapping</button>
              <button className="btn-primary glass-btn" style={{ padding: '4px 12px', fontSize: '0.85em' }} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Mappings'}</button>
            </div>
          </div>

          <datalist id="mapping-local-models">
            <option value="*" />
            {localModels.map(m => <option key={m} value={m} />)}
          </datalist>
          {backends.map(b => (
            <datalist key={b.id} id={`mapping-remote-${b.id}`}>
              {(remoteByBackend[b.id] || []).map(m => <option key={m} value={m} />)}
            </datalist>
          ))}

          <div className="model-map-table-wrap">
          <table className="model-map-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: '0.8em' }}>
                <th style={{ padding: '4px 6px', width: '38%' }}>Local model (requested)</th>
                <th style={{ padding: '4px 6px', width: '24%' }}>Remote host</th>
                <th style={{ padding: '4px 6px', width: '34%' }}>Remote model</th>
                <th style={{ width: '4%' }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={4} style={{ padding: '8px 6px', color: 'var(--text-muted)' }}>No mappings yet — click “+ Add Mapping”.</td></tr>
              )}
              {rows.map(r => (
                <tr key={r.rowId}>
                  <td style={{ padding: '4px 6px' }}>
                    <input className="glass-input" list="mapping-local-models" value={r.localKey} placeholder="local model id or *" onChange={e => updateRow(r.rowId, { localKey: e.target.value })} style={{ width: '100%' }} />
                  </td>
                  <td style={{ padding: '4px 6px' }}>
                    <select className="glass-input" value={r.backendId} onChange={e => updateRow(r.rowId, { backendId: e.target.value })} style={{ width: '100%' }}>
                      {backends.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: '4px 6px' }}>
                    <input className="glass-input" list={`mapping-remote-${r.backendId}`} value={r.remoteValue} placeholder="remote model id" onChange={e => updateRow(r.rowId, { remoteValue: e.target.value })} style={{ width: '100%' }} />
                  </td>
                  <td style={{ padding: '4px 6px' }}>
                    <button className="btn-secondary glass-btn" style={{ padding: '2px 8px', fontSize: '0.85em' }} onClick={() => removeRow(r.rowId)} title="Remove mapping">×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
    </section>
  );
}

// Remote Backends Management Section
function BackendsSection({ settings, updateSetting, setMessage }) {
  const [backends, setBackends] = useState([]);
  const [backendsStats, setBackendsStats] = useState({});
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [localModels, setLocalModels] = useState([]);
  const [remoteModels, setRemoteModels] = useState({}); // backendId -> string[]
  const [newBackend, setNewBackend] = useState({
    name: '', url: '', apiKeyEnvVar: '', priority: 10,
    modelMapping: { '*': '' },
    supportedEndpoints: ['chat/completions', 'completions', 'embeddings'],
    costs: { inputTokenCostPer1M: 0, outputTokenCostPer1M: 0, currency: 'USD' },
    sharedResourceWeight: 0, maxConcurrentRequests: 5, timeoutMs: 120000
  });

  const backendsConfig = settings?.backends || {};

  const fetchBackends = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/backends`);
      const data = await res.json();
      setBackends(data.backends || []);
    } catch { /* ignore */ }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/backends/stats`);
      const data = await res.json();
      setBackendsStats(data.stats || {});
    } catch { /* ignore */ }
  }, []);

  const fetchLocalModels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/models`);
      const data = await res.json();
      setLocalModels((data.serverModels || []).map(m => m.id || m.model || '').filter(Boolean));
    } catch { /* ignore */ }
  }, []);

  const fetchRemoteModels = useCallback(async (backendId) => {
    try {
      const res = await fetch(`${API_BASE}/backends/${backendId}/models`);
      const data = await res.json();
      setRemoteModels(prev => ({ ...prev, [backendId]: data.models || [] }));
      return data.models || [];
    } catch { return []; }
  }, []);

  useEffect(() => {
    fetchBackends();
    fetchStats();
    fetchLocalModels();
  }, [fetchBackends, fetchStats, fetchLocalModels]);

  // Fetch remote models for each backend
  useEffect(() => {
    for (const b of backends) {
      if (!remoteModels[b.id]) {
        fetchRemoteModels(b.id);
      }
    }
  }, [backends]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateRouting = async (key, value) => {
    const updated = { ...backendsConfig, [key]: value };
    updateSetting('backends', updated);
    // Auto-persist routing changes to the server
    try {
      await fetch(`${API_BASE}/backends/routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value })
      });
    } catch { /* ignore */ }
  };

  const addBackend = async () => {
    if (!newBackend.name || !newBackend.url) {
      setMessage({ type: 'error', text: 'Backend name and URL are required' });
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/backends`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newBackend)
      });
      const data = await res.json();
      if (data.success) {
        const backendId = data.backend.id;
        setMessage({ type: 'info', text: `Backend "${data.backend.name}" added. Running connectivity test...` });
        setShowAddForm(false);
        setNewBackend({ name: '', url: '', apiKeyEnvVar: '', priority: 10, modelMapping: { '*': '' }, supportedEndpoints: ['chat/completions', 'completions', 'embeddings'], costs: { inputTokenCostPer1M: 0, outputTokenCostPer1M: 0, currency: 'USD' }, sharedResourceWeight: 0, maxConcurrentRequests: 5, timeoutMs: 120000 });
        await fetchBackends();

        // Auto-test after adding
        setTestResults(prev => ({ ...prev, [backendId]: { testing: true } }));
        try {
          const testRes = await fetch(`${API_BASE}/backends/${backendId}/test`, { method: 'POST' });
          const testData = await testRes.json();
          setTestResults(prev => ({ ...prev, [backendId]: testData }));
          await fetchBackends(); // Refresh to pick up tested state
          if (testData.success) {
            setMessage({ type: 'success', text: `Backend "${data.backend.name}" added and tested successfully (${testData.latencyMs}ms)` });
            // Also fetch remote models now that we know the backend works
            fetchRemoteModels(backendId);
          } else {
            setMessage({ type: 'error', text: `Backend added but test failed: ${testData.message}. Backend won't be used for offloading until it passes a test.` });
          }
        } catch (err) {
          setTestResults(prev => ({ ...prev, [backendId]: { success: false, message: err.message } }));
          setMessage({ type: 'error', text: `Backend added but test failed: ${err.message}` });
        }
      } else {
        setMessage({ type: 'error', text: data.error });
      }
    } catch (err) {
      setMessage({ type: 'error', text: `Failed to add backend: ${err.message}` });
    }
  };

  const deleteBackend = async (id, name) => {
    if (!confirm(`Delete backend "${name}"?`)) return;
    try {
      const res = await fetch(`${API_BASE}/backends/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setMessage({ type: 'success', text: `Backend "${name}" removed` });
        fetchBackends();
      }
    } catch (err) {
      setMessage({ type: 'error', text: `Failed to delete: ${err.message}` });
    }
  };

  const toggleBackend = async (id, enabled) => {
    try {
      await fetch(`${API_BASE}/backends/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      fetchBackends();
    } catch { /* ignore */ }
  };

  const testBackend = async (id) => {
    setTestResults(prev => ({ ...prev, [id]: { testing: true } }));
    try {
      const res = await fetch(`${API_BASE}/backends/${id}/test`, { method: 'POST' });
      const data = await res.json();
      setTestResults(prev => ({ ...prev, [id]: data }));
      fetchBackends(); // Refresh tested state
      if (data.remoteModels?.length) {
        setRemoteModels(prev => ({ ...prev, [id]: data.remoteModels }));
      }
    } catch (err) {
      setTestResults(prev => ({ ...prev, [id]: { success: false, message: err.message } }));
    }
  };

  const saveRoutingPolicy = async () => {
    try {
      const res = await fetch(`${API_BASE}/backends/routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: backendsConfig.enabled,
          offloadPolicy: backendsConfig.offloadPolicy,
          offloadThresholdQueueDepth: backendsConfig.offloadThresholdQueueDepth,
          offloadThresholdWaitMs: backendsConfig.offloadThresholdWaitMs,
          offloadPercentage: backendsConfig.offloadPercentage,
          preferLocal: backendsConfig.preferLocal
        })
      });
      const data = await res.json();
      if (data.success) {
        setMessage({ type: 'success', text: 'Routing policy saved' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: `Failed to save routing: ${err.message}` });
    }
  };

  return (
    <section className="page-section glass-panel">
      <h3>Remote Backends</h3>
      <p className="setting-hint" style={{ marginBottom: '16px' }}>
        Configure remote OpenAI-compatible API endpoints for load balancing. When the local server is busy, requests can be offloaded to these backends.
      </p>

      <div className="settings-grid">
        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={backendsConfig.enabled || false}
              onChange={(e) => updateRouting('enabled', e.target.checked)}
            />
            {' '}Enable Remote Backend Offloading
          </label>
        </div>
      </div>

      {backendsConfig.enabled && (
        <>
          <div className="settings-grid" style={{ marginTop: '16px' }}>
            <div className="setting-item">
              <label htmlFor="offloadPolicy">Offload Policy</label>
              <p className="setting-hint">
                When to send requests to remote backends instead of local.
              </p>
              <select
                id="offloadPolicy"
                className="glass-input"
                value={backendsConfig.offloadPolicy || 'overflow'}
                onChange={(e) => updateRouting('offloadPolicy', e.target.value)}
              >
                <option value="overflow">Overflow - Only when local queue is full</option>
                <option value="threshold">Threshold - When queue depth/wait exceeds limits</option>
                <option value="percentage">Percentage - Fixed % of requests go remote</option>
                <option value="manual">Manual - Only via explicit backend prefix</option>
              </select>
            </div>

            {backendsConfig.offloadPolicy === 'threshold' && (
              <>
                <div className="setting-item">
                  <label htmlFor="thresholdQueueDepth">Queue Depth Threshold</label>
                  <p className="setting-hint">Offload when pending queue exceeds this depth.</p>
                  <input
                    type="number"
                    id="thresholdQueueDepth"
                    className="glass-input"
                    value={backendsConfig.offloadThresholdQueueDepth ?? 2}
                    onChange={(e) => updateRouting('offloadThresholdQueueDepth', parseInt(e.target.value))}
                    min={0} max={100}
                  />
                </div>
                <div className="setting-item">
                  <label htmlFor="thresholdWaitMs">Wait Time Threshold (ms)</label>
                  <p className="setting-hint">Offload when estimated wait exceeds this time.</p>
                  <input
                    type="number"
                    id="thresholdWaitMs"
                    className="glass-input"
                    value={backendsConfig.offloadThresholdWaitMs ?? 5000}
                    onChange={(e) => updateRouting('offloadThresholdWaitMs', parseInt(e.target.value))}
                    min={0} max={300000} step={1000}
                  />
                </div>
              </>
            )}

            {backendsConfig.offloadPolicy === 'percentage' && (
              <div className="setting-item">
                <label htmlFor="offloadPercentage">
                  Offload Percentage: {backendsConfig.offloadPercentage || 0}%
                </label>
                <p className="setting-hint">Percentage of requests to send to remote backends.</p>
                <input
                  type="range"
                  id="offloadPercentage"
                  value={backendsConfig.offloadPercentage || 0}
                  onChange={(e) => updateRouting('offloadPercentage', parseInt(e.target.value))}
                  min={0} max={100}
                />
              </div>
            )}

            <div className="setting-item">
              <label>
                <input
                  type="checkbox"
                  checked={backendsConfig.preferLocal !== false}
                  onChange={(e) => updateRouting('preferLocal', e.target.checked)}
                />
                {' '}Prefer Local
              </label>
              <p className="setting-hint">
                When enabled (default), requests run locally until the queue is full, then overflow to remote per the offload policy above.
                When disabled, offloadable requests (those with a remote mapping) always go remote whenever a remote backend has capacity —
                reserving the local slot for non-offloadable models. Useful when local is the slow node and remote backends should handle the bulk of work.
              </p>
            </div>
          </div>

          <div style={{ marginTop: '4px', marginBottom: '16px' }}>
            <span style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>Routing settings save automatically.</span>
          </div>

          {/* Backend Directory */}
          <h4 style={{ marginTop: '24px', marginBottom: '12px' }}>Backend Directory</h4>

          {backends.length === 0 && !showAddForm && (
            <div className="empty-state" style={{ padding: '24px' }}>
              <p>No remote backends configured.</p>
            </div>
          )}

          {backends.map(b => {
            const stats = backendsStats[b.id] || {};
            const test = testResults[b.id];
            const testedBadge = b.tested
              ? { bg: 'var(--success-bg, #1a3a2a)', color: 'var(--success, #4ade80)', text: 'Tested' }
              : { bg: 'var(--error-bg, #3a1a1a)', color: 'var(--error, #f87171)', text: 'Untested' };
            return (
              <div key={b.id} className="backend-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: '1.1em' }}>{b.name}</strong>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.85em' }}>{b.url}</span>
                    <span style={{
                      display: 'inline-block', padding: '2px 8px', borderRadius: '4px', fontSize: '0.75em',
                      background: testedBadge.bg, color: testedBadge.color
                    }}>
                      {testedBadge.text}
                    </span>
                    {b.apiKeyEnvVar && (
                      <span style={{
                        display: 'inline-block', padding: '2px 8px', borderRadius: '4px', fontSize: '0.75em',
                        background: b.apiKeyConfigured ? 'var(--success-bg, #1a3a2a)' : 'var(--warning-bg, #3a2a1a)',
                        color: b.apiKeyConfigured ? 'var(--success, #4ade80)' : 'var(--warning, #fbbf24)'
                      }}>
                        {b.apiKeyConfigured ? 'Key configured' : 'No API key'}
                      </span>
                    )}
                    {!b.tested && (
                      <span style={{ fontSize: '0.75em', color: 'var(--warning, #fbbf24)' }}>
                        (must pass test before offloading)
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <label style={{ fontSize: '0.85em', cursor: 'pointer' }}>
                      <input type="checkbox" checked={b.enabled} onChange={(e) => toggleBackend(b.id, e.target.checked)} />
                      {' '}Enabled
                    </label>
                    <button className="btn-secondary glass-btn" style={{ padding: '4px 12px', fontSize: '0.85em' }} onClick={() => testBackend(b.id)}>
                      {test?.testing ? 'Testing...' : 'Test'}
                    </button>
                    <button className="btn-secondary glass-btn" style={{ padding: '4px 12px', fontSize: '0.85em' }} onClick={() => setEditingId(editingId === b.id ? null : b.id)}>
                      {editingId === b.id ? 'Close' : 'Edit'}
                    </button>
                    <button className="btn-secondary glass-btn destructive-action" style={{ padding: '4px 12px', fontSize: '0.85em', color: 'var(--error, #f87171)' }} onClick={() => deleteBackend(b.id, b.name)}>
                      Delete
                    </button>
                  </div>
                </div>

                {/* Stats row */}
                <div style={{ display: 'flex', gap: '24px', fontSize: '0.85em', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                  <span>Priority: {b.priority}</span>
                  <span>Shared Weight: {b.sharedResourceWeight}</span>
                  <span>Queue: {b.queue?.active || 0}/{b.maxConcurrentRequests || 5}</span>
                  <span>Requests: {stats.totalRequests || 0}</span>
                  <span>Tok/s: {stats.avgTokPerSec ? stats.avgTokPerSec.toFixed(1) : '-'}</span>
                  <span>Cost: ${stats.totalCostUsd ? stats.totalCostUsd.toFixed(4) : '0.00'}</span>
                  <span>Errors: {stats.errorRequests || 0}</span>
                  {b.costs?.inputTokenCostPer1M > 0 && (
                    <span>Rate: ${b.costs.inputTokenCostPer1M}/M in, ${b.costs.outputTokenCostPer1M}/M out</span>
                  )}
                </div>

                {/* Test result */}
                {test && !test.testing && (
                  <div style={{ marginTop: '8px', padding: '8px', borderRadius: '4px', fontSize: '0.85em', background: test.success ? 'var(--success-bg, #1a3a2a)' : 'var(--error-bg, #3a1a1a)', color: test.success ? 'var(--success, #4ade80)' : 'var(--error, #f87171)' }}>
                    {test.message} {test.latencyMs && `(${test.latencyMs}ms)`}
                  </div>
                )}

                {/* Model mappings */}
                {b.modelMapping && Object.keys(b.modelMapping).length > 0 && (
                  <div style={{ marginTop: '8px', fontSize: '0.85em' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Model mapping: </span>
                    {Object.entries(b.modelMapping).map(([k, v]) => (
                      <span key={k} style={{ marginRight: '12px' }}>
                        <code>{k === '*' ? '* (all models)' : k}</code> {'→'} <code>{v || '(not set)'}</code>
                      </span>
                    ))}
                  </div>
                )}

                {/* Edit form */}
                {editingId === b.id && (
                  <BackendEditForm backend={b} localModels={localModels} remoteModels={remoteModels[b.id] || []} onSave={(updates) => {
                    fetch(`${API_BASE}/backends/${b.id}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(updates)
                    }).then(() => { fetchBackends(); setEditingId(null); });
                  }} onCancel={() => setEditingId(null)} />
                )}
              </div>
            );
          })}

          {/* Add Backend */}
          {showAddForm ? (
            <div className="backend-add-form glass-panel">
              <h4 style={{ marginBottom: '12px' }}>Add New Backend</h4>
              <BackendFormFields values={newBackend} onChange={setNewBackend} localModels={localModels} remoteModels={[]} />
              <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                <button className="btn-primary glass-btn" onClick={addBackend}>Add Backend & Test</button>
                <button className="btn-secondary glass-btn" onClick={() => setShowAddForm(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="btn-secondary glass-btn" onClick={() => setShowAddForm(true)} style={{ marginTop: '8px' }}>
              + Add Backend
            </button>
          )}
        </>
      )}
    </section>
  );
}

// Shared form fields for backend add/edit
function BackendFormFields({ values, onChange, localModels = [], remoteModels: remoteModelsProp = [] }) {
  const update = (key, value) => onChange({ ...values, [key]: value });
  const updateCost = (key, value) => onChange({ ...values, costs: { ...values.costs, [key]: value } });
  const fieldPrefix = React.useId();

  // Local copy of remoteModels — initialised from prop, can be refreshed
  // independently of running a full backend test. This breaks the
  // chicken-and-egg where /test needed a model and picking the model
  // needed the list /test returns.
  const [remoteModels, setRemoteModels] = React.useState(remoteModelsProp);
  const [refreshState, setRefreshState] = React.useState({ loading: false, error: null, ts: null });
  React.useEffect(() => { setRemoteModels(remoteModelsProp); }, [remoteModelsProp]);

  const refreshRemoteModels = async () => {
    if (!values.url) {
      setRefreshState({ loading: false, error: 'Set the URL first', ts: Date.now() });
      return;
    }
    setRefreshState({ loading: true, error: null, ts: null });
    try {
      // Prefer the by-id endpoint when we have an id (uses any server-side
      // env-var-resolved API key); fall back to the URL-only endpoint for
      // brand-new backends that haven't been saved yet.
      const path = values.id
        ? `${API_BASE}/backends/${values.id}/refresh-models`
        : `${API_BASE}/backends/refresh-models`;
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: values.url,
          apiKeyEnvVar: values.apiKeyEnvVar || undefined,
          extraHeaders: values.extraHeaders || undefined
        })
      });
      const data = await r.json();
      if (data.success) {
        setRemoteModels(data.remoteModels || []);
        setRefreshState({ loading: false, error: null, ts: Date.now(), count: (data.remoteModels || []).length, latencyMs: data.latencyMs });
      } else {
        setRemoteModels([]);
        setRefreshState({ loading: false, error: data.error || `HTTP ${data.status}`, ts: Date.now() });
      }
    } catch (err) {
      setRefreshState({ loading: false, error: err.message, ts: Date.now() });
    }
  };

  // Model mapping editor
  const mappingEntries = Object.entries(values.modelMapping || { '*': '' });
  const addMapping = () => onChange({ ...values, modelMapping: { ...values.modelMapping, '': '' } });
  const removeMapping = (key) => {
    const m = { ...values.modelMapping };
    delete m[key];
    onChange({ ...values, modelMapping: m });
  };
  const updateMappingKey = (oldKey, newKey) => {
    const m = {};
    for (const [k, v] of Object.entries(values.modelMapping)) {
      m[k === oldKey ? newKey : k] = v;
    }
    onChange({ ...values, modelMapping: m });
  };
  const updateMappingValue = (key, value) => {
    onChange({ ...values, modelMapping: { ...values.modelMapping, [key]: value } });
  };

  return (
    <div className="settings-grid">
      <div className="setting-item">
        <label htmlFor={`${fieldPrefix}-name`}>Name</label>
        <input id={`${fieldPrefix}-name`} className="glass-input" type="text" value={values.name} onChange={(e) => update('name', e.target.value)} placeholder="e.g. OpenRouter" />
      </div>
      <div className="setting-item">
        <label htmlFor={`${fieldPrefix}-url`}>URL</label>
        <input id={`${fieldPrefix}-url`} className="glass-input" type="text" value={values.url} onChange={(e) => update('url', e.target.value)} placeholder="e.g. https://openrouter.ai/api/v1" />
      </div>
      <div className="setting-item">
        <label htmlFor={`${fieldPrefix}-api-key-env`}>API Key Env Variable</label>
        <p className="setting-hint">Name of the environment variable holding the API key (set in .env). Leave blank for unauthenticated backends.</p>
        <input id={`${fieldPrefix}-api-key-env`} className="glass-input" type="text" value={values.apiKeyEnvVar} onChange={(e) => update('apiKeyEnvVar', e.target.value)} placeholder="e.g. BACKEND_OPENROUTER_API_KEY" />
      </div>
      <div className="setting-item">
        <label htmlFor={`${fieldPrefix}-priority`}>Priority (1-100, lower = preferred)</label>
        <input id={`${fieldPrefix}-priority`} className="glass-input" type="number" value={values.priority} onChange={(e) => update('priority', parseInt(e.target.value))} min={1} max={100} />
      </div>
      <div className="setting-item">
        <label htmlFor={`${fieldPrefix}-shared-weight`}>Shared Resource Weight (0-100)</label>
        <p className="setting-hint">0 = dedicated resource, 100 = heavily shared with other users/tasks.</p>
        <input id={`${fieldPrefix}-shared-weight`} type="range" value={values.sharedResourceWeight} onChange={(e) => update('sharedResourceWeight', parseInt(e.target.value))} min={0} max={100} />
        <span style={{ fontSize: '0.85em', color: 'var(--text-muted)' }}>{values.sharedResourceWeight}</span>
      </div>
      <div className="setting-item">
        <label htmlFor={`${fieldPrefix}-max-concurrent`}>Max Concurrent Requests</label>
        <input id={`${fieldPrefix}-max-concurrent`} className="glass-input" type="number" value={values.maxConcurrentRequests} onChange={(e) => update('maxConcurrentRequests', parseInt(e.target.value))} min={1} max={100} />
      </div>
      <div className="setting-item">
        <label htmlFor={`${fieldPrefix}-timeout`}>Timeout (ms)</label>
        <input id={`${fieldPrefix}-timeout`} className="glass-input" type="number" value={values.timeoutMs} onChange={(e) => update('timeoutMs', parseInt(e.target.value))} min={5000} max={600000} step={1000} />
      </div>

      {/* Cost section */}
      <div className="setting-item" style={{ gridColumn: '1 / -1' }}>
        <label>Cost (per 1M tokens)</label>
        <p className="setting-hint">Set to 0 for free/self-hosted backends.</p>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <div>
            <label htmlFor={`${fieldPrefix}-input-cost`} style={{ fontSize: '0.85em' }}>Input</label>
            <input id={`${fieldPrefix}-input-cost`} className="glass-input" type="number" value={values.costs?.inputTokenCostPer1M || 0} onChange={(e) => updateCost('inputTokenCostPer1M', parseFloat(e.target.value))} min={0} step={0.01} style={{ width: '100px' }} />
          </div>
          <div>
            <label htmlFor={`${fieldPrefix}-output-cost`} style={{ fontSize: '0.85em' }}>Output</label>
            <input id={`${fieldPrefix}-output-cost`} className="glass-input" type="number" value={values.costs?.outputTokenCostPer1M || 0} onChange={(e) => updateCost('outputTokenCostPer1M', parseFloat(e.target.value))} min={0} step={0.01} style={{ width: '100px' }} />
          </div>
          <div>
            <label htmlFor={`${fieldPrefix}-currency`} style={{ fontSize: '0.85em' }}>Currency</label>
            <input id={`${fieldPrefix}-currency`} className="glass-input" type="text" value={values.costs?.currency || 'USD'} onChange={(e) => updateCost('currency', e.target.value)} style={{ width: '60px' }} />
          </div>
        </div>
      </div>

      {/* Model mapping is managed in the dedicated "Model Mapping" settings tab. */}
      <div className="setting-item" style={{ gridColumn: '1 / -1' }}>
        <label>Model Mapping</label>
        <p className="setting-hint">
          Model mappings for this host are managed in the <strong>Model Mapping</strong> tab. Existing
          mappings are preserved when you edit a host here.
        </p>
      </div>
    </div>
  );
}

// Edit form for existing backend
function BackendEditForm({ backend, localModels, remoteModels, onSave, onCancel }) {
  const [values, setValues] = useState({
    name: backend.name,
    url: backend.url,
    apiKeyEnvVar: backend.apiKeyEnvVar || '',
    priority: backend.priority || 10,
    sharedResourceWeight: backend.sharedResourceWeight || 0,
    maxConcurrentRequests: backend.maxConcurrentRequests || 5,
    timeoutMs: backend.timeoutMs || 120000,
    costs: backend.costs || { inputTokenCostPer1M: 0, outputTokenCostPer1M: 0, currency: 'USD' },
    modelMapping: backend.modelMapping || { '*': '' }
  });

  return (
    <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
      <BackendFormFields values={values} onChange={setValues} localModels={localModels} remoteModels={remoteModels} />
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button className="btn-primary glass-btn" onClick={() => onSave(values)}>Save Changes</button>
        <button className="btn-secondary glass-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// llama.cpp Update Section Component
function LlamaCppUpdateSection() {
  const [updating, setUpdating] = useState(false);
  const [status, setStatus] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [output, setOutput] = useState('');
  const outputRef = useRef(null);
  const updateView = resolveLlamaUpdateView(updateInfo);

  // Check initial status
  useEffect(() => {
    fetch(`${API_BASE}/llama/update/status`)
      .then(res => res.json())
      .then(data => {
        setUpdateInfo(data);
        setStatus(data.status);
        setOutput(data.output || '');
        if (data.status === 'updating') {
          setUpdating(true);
        }
      })
      .catch(err => console.error('Failed to fetch update status:', err));
  }, []);

  // Subscribe to WebSocket updates
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'llama_update') {
          if (msg.data.output) {
            setOutput(prev => prev + msg.data.output);
          }
          if (msg.data.status && msg.data.status !== 'updating') {
            setStatus(msg.data.status);
            setUpdating(false);
          }
        }
      } catch (e) {
        // Ignore non-JSON messages
      }
    };

    return () => ws.close();
  }, []);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const startUpdate = async () => {
    if (!updateView.canSourceUpdate) return;
    setUpdating(true);
    setStatus('updating');
    setOutput('');
    try {
      const res = await fetch(`${API_BASE}/llama/update`, { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        setStatus('failed');
        setOutput(data.error || 'Failed to start update');
        setUpdating(false);
      }
    } catch (err) {
      setStatus('failed');
      setOutput('Failed to start update: ' + err.message);
      setUpdating(false);
    }
  };

  return (
    <section className="page-section glass-panel">
      <h3>llama.cpp Updates</h3>
      <div className="setting-item">
        {updateView.packageManaged ? (
          <>
            <p className="setting-hint">{updateView.guidance}</p>
            {updateView.command && <code>{updateView.command}</code>}
          </>
        ) : (
          <>
            <p className="setting-hint">
              Pull the latest llama.cpp changes from GitHub and rebuild. This will stop any running llama server during the update.
            </p>
            <button
              className={`btn-secondary glass-btn ${updating ? 'disabled' : ''}`}
              onClick={startUpdate}
              disabled={updating}
            >
              {updating ? 'Updating...' : 'Update llama.cpp'}
            </button>
          </>
        )}
        {!updateView.packageManaged && status && status !== 'idle' && (
          <span className={`update-status ${status}`}>
            {status === 'updating' && ' Building...'}
            {status === 'success' && ' Update complete'}
            {status === 'failed' && ' Update failed'}
          </span>
        )}
      </div>
      {output && (
        <pre className="update-output" ref={outputRef}>
          {output}
        </pre>
      )}
    </section>
  );
}

export default SettingsPage;
