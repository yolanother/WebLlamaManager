// Llama Manager — settings page.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Provides appearance, general configuration, model alias groups, remote
// backends, and llama.cpp update controls in glass-aligned settings panels.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { API_BASE } from '../api.js';
import { aliasesToRows, rowsToAliases, diffAliases, validateRows } from './alias-editor.js';
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
import { getLook, setLook, useLook, getLayout, setLayout, useLayout } from '../theme/uiPrefs.js';
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
  const look = useLook();
  const layout = useLayout();
  const isProfessional = look === 'professional';
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
  const lookOptions = [
    { value: 'classic', label: 'Classic' },
    { value: 'professional', label: 'Professional' },
  ];
  const layoutOptions = [
    { value: 'dashboard', label: 'Dashboard' },
    { value: 'chat-first', label: 'Chat-first' },
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
        <span id="look-label">Look</span>
        <div
          className="scheme-segmented"
          role="group"
          aria-labelledby="look-label"
        >
          {lookOptions.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`glass-btn scheme-option ${look === value ? 'active' : ''}`}
              aria-pressed={look === value}
              onClick={() => setLook(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="setting-hint">
          Professional flattens surfaces and reserves color for actions and status. Site themes
          still supply the accent.
        </p>
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
              disabled={isProfessional}
              onClick={() => setEffectsMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="setting-hint" aria-live="polite">
          {isProfessional ? 'Not used by the Professional look.' : effectsHint}
        </p>
        <div>
          <button
            type="button"
            className="btn-secondary btn-small glass-btn"
            disabled={isProfessional || effects.preference !== 'auto'}
            title={
              isProfessional
                ? 'Not used by the Professional look'
                : effects.preference === 'auto'
                  ? 'Clear the cached result and measure visible frame performance again'
                  : 'Select Auto to run the performance check'
            }
            onClick={rerunEffectsProbe}
          >
            Re-run performance check
          </button>
        </div>
      </div>
      <div className="scheme-setting">
        <span id="layout-label">Layout</span>
        <div
          className="scheme-segmented"
          role="group"
          aria-labelledby="layout-label"
        >
          {layoutOptions.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`glass-btn scheme-option ${layout === value ? 'active' : ''}`}
              aria-pressed={layout === value}
              onClick={() => setLayout(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="setting-hint">
          Chat-first makes chat the home page with a single conversation sidebar. Admin pages
          live under Manage.
        </p>
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
  const [activeTab, setActiveTab] = useState('general'); // 'general' | 'hosts' | 'aliases'
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
        <button className={`tab-btn glass-btn ${activeTab === 'aliases' ? 'active' : ''}`} onClick={() => setActiveTab('aliases')}>Aliases</button>
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
        <BackendsSection
          settings={settings}
          updateSetting={updateSetting}
          setMessage={setMessage}
          onShowAliases={() => setActiveTab('aliases')}
        />
      )}

      {activeTab === 'aliases' && (
        <AliasesSection setMessage={setMessage} />
      )}
    </div>
  );
}

// Host value meaning "this manager" rather than a remote backend id. Mirrors the
// `local` sentinel the server uses in api/model-aliases.js.
const LOCAL_HOST = 'local';

/**
 * Normalizes the `GET /api/aliases` body into the keyed alias table the editor
 * works with. Accepts both the keyed-object and array-of-entries shapes and
 * ignores envelope fields such as `success`, so the tab keeps working whichever
 * shape the endpoint settles on.
 *
 * @param {object} payload The parsed JSON body of `GET /api/aliases`.
 * @returns {Object<string, {targets: Array<{host: string, model: string}>}>}
 *   The alias table, or `{}` when the payload carries none.
 */
function normalizeAliasPayload(payload) {
  const raw = payload?.aliases ?? {};
  const aliases = {};

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const name = entry?.name ?? entry?.id;
      if (typeof name === 'string' && name) aliases[name] = { targets: entry?.targets || [] };
    }
    return aliases;
  }

  if (raw && typeof raw === 'object') {
    for (const [name, group] of Object.entries(raw)) {
      if (!name || !Array.isArray(group?.targets)) continue;
      aliases[name] = { targets: group.targets };
    }
  }
  return aliases;
}

// Aliases Section — editor for the global alias table (`config.aliases`).
// An alias name maps to an ordered list of targets, each naming a host ("Local"
// or a remote backend id) and a model on it; the router expands the alias and
// prefers whichever target is already warm. Rows are flattened out of the alias
// table by alias-editor.js, edited here, folded back, and saved as one PUT per
// changed alias plus one DELETE per removed alias. The model field is a
// free-text combobox so a glob such as `gemma4:*` can be typed even when the
// host's model list does not offer it.
function AliasesSection({ setMessage }) {
  const [backends, setBackends] = React.useState([]);
  const [localModels, setLocalModels] = React.useState([]); // bare local model ids
  const [presets, setPresets] = React.useState({}); // presetId -> preset
  const [remoteByBackend, setRemoteByBackend] = React.useState({}); // backendId -> string[]
  const [rows, setRows] = React.useState([]); // { rowId, aliasName, host, model }
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const rowIdRef = React.useRef(1);
  // The alias table as loaded, so a save only writes the aliases that actually
  // changed and never rewrites untouched ones.
  const originalRef = React.useRef({});

  const loadAll = React.useCallback(async () => {
    setLoading(true);

    let bks = [];
    try { bks = (await (await fetch(`${API_BASE}/backends`)).json()).backends || []; } catch { /* ignore */ }
    setBackends(bks);

    let aliases = {};
    try { aliases = normalizeAliasPayload(await (await fetch(`${API_BASE}/aliases`)).json()); } catch { /* ignore */ }
    originalRef.current = aliases;
    const rs = aliasesToRows(aliases);
    rowIdRef.current = rs.reduce((max, r) => Math.max(max, r.rowId), 0) + 1;
    setRows(rs);

    // Local suggestions: real model ids only — the synthesized alias rows are
    // excluded so an alias can't be pointed at itself.
    let lm = [];
    try {
      lm = ((await (await fetch(`${API_BASE}/v1/models`)).json()).data || [])
        .filter(m => m.status !== 'alias').map(m => m.id).filter(Boolean);
    } catch { /* ignore */ }
    setLocalModels([...new Set(lm)].sort());

    const ps = {};
    try {
      for (const p of (await (await fetch(`${API_BASE}/presets`)).json()).presets || []) {
        if (p?.id) ps[p.id] = p;
      }
    } catch { /* ignore */ }
    setPresets(ps);

    const rm = {};
    await Promise.all(bks.map(async b => {
      try { rm[b.id] = (await (await fetch(`${API_BASE}/backends/${b.id}/models`)).json()).models || []; }
      catch { rm[b.id] = []; }
    }));
    setRemoteByBackend(rm);

    setLoading(false);
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

  // Alias names in first-appearance order, each with its target rows. Keyed on
  // the first row's id rather than the name so renaming doesn't remount (and
  // unfocus) the name input on every keystroke.
  const groups = React.useMemo(() => {
    const byName = new Map();
    for (const r of rows) {
      if (!byName.has(r.aliasName)) byName.set(r.aliasName, []);
      byName.get(r.aliasName).push(r);
    }
    return [...byName.entries()].map(([name, groupRows]) => ({ key: groupRows[0].rowId, name, rows: groupRows }));
  }, [rows]);

  const issues = React.useMemo(
    () => validateRows(rows, { presets, localModels, backendIds: backends.map(b => b.id) }),
    [rows, presets, localModels, backends]
  );
  const issuesByRow = React.useMemo(() => {
    const byRow = new Map();
    for (const i of issues) {
      if (!byRow.has(i.rowId)) byRow.set(i.rowId, []);
      byRow.get(i.rowId).push(i);
    }
    return byRow;
  }, [issues]);
  const errorCount = issues.filter(i => i.level === 'error').length;

  const updateRow = (rowId, patch) => setRows(rs => rs.map(r => r.rowId === rowId ? { ...r, ...patch } : r));
  const removeRow = (rowId) => setRows(rs => rs.filter(r => r.rowId !== rowId));
  const renameAlias = (oldName, newName) =>
    setRows(rs => rs.map(r => r.aliasName === oldName ? { ...r, aliasName: newName } : r));
  const removeAlias = (name) => setRows(rs => rs.filter(r => r.aliasName !== name));
  const addAlias = () =>
    setRows(rs => [...rs, { rowId: rowIdRef.current++, aliasName: '', host: LOCAL_HOST, model: '' }]);

  // Append a target directly below the alias's last existing target so the
  // authored order stays contiguous in the flat row list.
  const addTarget = (name) => setRows(rs => {
    let last = -1;
    rs.forEach((r, i) => { if (r.aliasName === name) last = i; });
    const next = [...rs];
    next.splice(last < 0 ? next.length : last + 1, 0,
      { rowId: rowIdRef.current++, aliasName: name, host: LOCAL_HOST, model: '' });
    return next;
  });

  // Swap a target with its neighbour inside its own alias. Order is the ranking
  // tiebreak, so this is a real edit, not just presentation.
  const moveTarget = (rowId, delta) => setRows(rs => {
    const row = rs.find(r => r.rowId === rowId);
    if (!row) return rs;
    const positions = rs.reduce((acc, r, i) => { if (r.aliasName === row.aliasName) acc.push(i); return acc; }, []);
    const at = positions.indexOf(rs.indexOf(row));
    const to = at + delta;
    if (to < 0 || to >= positions.length) return rs;
    const next = [...rs];
    const a = positions[at];
    const b = positions[to];
    [next[a], next[b]] = [next[b], next[a]];
    return next;
  });

  const save = async () => {
    if (errorCount > 0) {
      setMessage({ type: 'error', text: 'Fix the highlighted errors before saving.' });
      return;
    }
    const edited = rowsToAliases(rows);
    const { changed, removed } = diffAliases(originalRef.current, edited);
    if (changed.length === 0 && removed.length === 0) {
      setMessage({ type: 'info', text: 'No alias changes to save.' });
      return;
    }

    setSaving(true);
    let ok = 0;
    let fail = 0;
    const notes = [];
    for (const name of changed) {
      try {
        const res = await fetch(`${API_BASE}/aliases/${encodeURIComponent(name)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targets: edited[name].targets })
        });
        const d = await res.json();
        if (d.success) {
          ok++;
          for (const w of d.warnings || []) notes.push(`${name}: ${w}`);
        } else {
          fail++;
          notes.push(`${name}: ${d.error || `HTTP ${res.status}`}`);
        }
      } catch (err) {
        fail++;
        notes.push(`${name}: ${err.message}`);
      }
    }
    for (const name of removed) {
      try {
        const res = await fetch(`${API_BASE}/aliases/${encodeURIComponent(name)}`, { method: 'DELETE' });
        const d = await res.json();
        if (d.success) ok++;
        else { fail++; notes.push(`${name}: ${d.error || `HTTP ${res.status}`}`); }
      } catch (err) {
        fail++;
        notes.push(`${name}: ${err.message}`);
      }
    }
    setSaving(false);

    const suffix = notes.length ? ` — ${notes.join('; ')}` : '';
    setMessage(fail
      ? { type: 'error', text: `Saved ${ok} alias change(s); ${fail} failed${suffix}` }
      : { type: 'success', text: `Aliases saved (${ok} change${ok === 1 ? '' : 's'})${suffix}` });
    loadAll();
  };

  const hostLabel = (host) => {
    if (host === LOCAL_HOST) return 'Local';
    return backends.find(b => b.id === host)?.name || host;
  };

  return (
    <section className="page-section glass-panel">
      <h3>Aliases</h3>
      <p className="setting-hint" style={{ marginBottom: '12px' }}>
        An alias is a name clients can request that resolves to whichever of its targets is
        already warm. Each target names a host — <strong>Local</strong> or a remote host — and a
        model on it. <strong>Target order matters</strong>: it is the tiebreak when several
        targets rank equally, so list them by preference. A model may be a glob such as{' '}
        <code>gemma4:*</code> — pick one from the list or type your own.{' '}
        <code>default-big</code> and <code>default-small</code> appear here as ordinary aliases.
      </p>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', gap: '8px', flexWrap: 'wrap' }}>
        <button className="btn-secondary glass-btn" style={{ padding: '4px 12px', fontSize: '0.85em' }} onClick={refreshRemote} disabled={refreshing || backends.length === 0}>
          {refreshing ? 'Refreshing…' : '↻ Refresh remote models'}
        </button>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn-secondary glass-btn" style={{ padding: '4px 12px', fontSize: '0.85em' }} onClick={addAlias}>+ Add Alias</button>
          <button className="btn-primary glass-btn" style={{ padding: '4px 12px', fontSize: '0.85em' }} onClick={save} disabled={saving || errorCount > 0} title={errorCount > 0 ? 'Fix the errors below first' : undefined}>
            {saving ? 'Saving…' : 'Save Aliases'}
          </button>
        </div>
      </div>

      {errorCount > 0 && (
        <p className="setting-hint" style={{ color: 'var(--error, #f87171)' }}>
          {errorCount} error{errorCount === 1 ? '' : 's'} must be fixed before saving.
        </p>
      )}

      <datalist id="alias-models-local">
        {[...new Set([...localModels, ...Object.keys(presets)])].sort().map(m => <option key={m} value={m} />)}
      </datalist>
      {backends.map(b => (
        <datalist key={b.id} id={`alias-models-${b.id}`}>
          {(remoteByBackend[b.id] || []).map(m => <option key={m} value={m} />)}
        </datalist>
      ))}

      {loading ? (
        <p className="setting-hint">Loading aliases…</p>
      ) : groups.length === 0 ? (
        <p className="setting-hint">No aliases yet — click “+ Add Alias”.</p>
      ) : groups.map(group => {
        // Name issues repeat on every row of the group; show each message once.
        const nameMessages = [];
        const seenNameMessages = new Set();
        for (const groupRow of group.rows) {
          for (const issue of issuesByRow.get(groupRow.rowId) || []) {
            if (issue.field !== 'aliasName' || seenNameMessages.has(issue.message)) continue;
            seenNameMessages.add(issue.message);
            nameMessages.push(issue);
          }
        }

        return (
          <div key={group.key} className="alias-group" style={{ border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-sm)', padding: '10px', marginBottom: '10px' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="glass-input"
                value={group.name}
                placeholder="alias name (e.g. conversational-model)"
                aria-label="Alias name"
                onChange={e => renameAlias(group.name, e.target.value)}
                style={{ flex: '1 1 240px', maxWidth: '360px' }}
              />
              <button className="btn-secondary glass-btn" style={{ padding: '2px 10px', fontSize: '0.85em' }} onClick={() => addTarget(group.name)}>+ Target</button>
              <button className="btn-secondary glass-btn" style={{ padding: '2px 10px', fontSize: '0.85em' }} onClick={() => removeAlias(group.name)}>Remove alias</button>
            </div>

            {nameMessages.map(issue => (
              <p key={issue.message} className="setting-hint" style={{ margin: '4px 0 0', color: issue.level === 'error' ? 'var(--error, #f87171)' : 'var(--warning, #fbbf24)' }}>
                {issue.message}
              </p>
            ))}

            <div className="model-map-table-wrap" style={{ marginTop: '8px' }}>
              <table className="model-map-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: '0.8em' }}>
                    <th style={{ padding: '4px 6px', width: '5%' }}>#</th>
                    <th style={{ padding: '4px 6px', width: '27%' }}>Host</th>
                    <th style={{ padding: '4px 6px', width: '48%' }}>Model (name or glob)</th>
                    <th style={{ padding: '4px 6px', width: '12%' }}>Order</th>
                    <th style={{ width: '8%' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((r, idx) => {
                    const rowIssues = (issuesByRow.get(r.rowId) || []).filter(i => i.field !== 'aliasName');
                    return (
                      <React.Fragment key={r.rowId}>
                        <tr>
                          <td style={{ padding: '4px 6px', color: 'var(--text-muted)' }}>{idx + 1}</td>
                          <td style={{ padding: '4px 6px' }}>
                            <select className="glass-input" value={r.host} aria-label="Target host" onChange={e => updateRow(r.rowId, { host: e.target.value })} style={{ width: '100%' }}>
                              <option value={LOCAL_HOST}>Local</option>
                              {backends.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                              {r.host && r.host !== LOCAL_HOST && !backends.some(b => b.id === r.host) && (
                                <option value={r.host}>{r.host} (unknown host)</option>
                              )}
                            </select>
                          </td>
                          <td style={{ padding: '4px 6px' }}>
                            <input
                              className="glass-input"
                              list={r.host === LOCAL_HOST ? 'alias-models-local' : `alias-models-${r.host}`}
                              value={r.model}
                              aria-label={`Model on ${hostLabel(r.host)}`}
                              placeholder="model id or glob (e.g. gemma4:*)"
                              onChange={e => updateRow(r.rowId, { model: e.target.value })}
                              style={{ width: '100%' }}
                            />
                          </td>
                          <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                            <button className="btn-secondary glass-btn" style={{ padding: '2px 8px', fontSize: '0.85em' }} onClick={() => moveTarget(r.rowId, -1)} disabled={idx === 0} title="Move up">↑</button>{' '}
                            <button className="btn-secondary glass-btn" style={{ padding: '2px 8px', fontSize: '0.85em' }} onClick={() => moveTarget(r.rowId, 1)} disabled={idx === group.rows.length - 1} title="Move down">↓</button>
                          </td>
                          <td style={{ padding: '4px 6px' }}>
                            <button className="btn-secondary glass-btn" style={{ padding: '2px 8px', fontSize: '0.85em' }} onClick={() => removeRow(r.rowId)} title="Remove target">×</button>
                          </td>
                        </tr>
                        {rowIssues.length > 0 && (
                          <tr>
                            <td colSpan={5} style={{ padding: '0 6px 6px' }}>
                              {rowIssues.map(i => (
                                <span key={`${i.field}-${i.message}`} style={{ marginRight: '12px', fontSize: '0.8em', color: i.level === 'error' ? 'var(--error, #f87171)' : 'var(--warning, #fbbf24)' }}>
                                  {i.message}
                                </span>
                              ))}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </section>
  );
}

// Remote Backends Management Section
function BackendsSection({ settings, updateSetting, setMessage, onShowAliases }) {
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

                {/* Model mappings — read-only view synthesized from the alias table */}
                {b.modelMapping && Object.keys(b.modelMapping).length > 0 && (
                  <div style={{ marginTop: '8px', fontSize: '0.85em' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Model mapping: </span>
                    {Object.entries(b.modelMapping).map(([k, v]) => (
                      <span key={k} style={{ marginRight: '12px' }}>
                        <code>{k === '*' ? '* (all models)' : k}</code> {'→'} <code>{v || '(not set)'}</code>
                      </span>
                    ))}
                    <div style={{ color: 'var(--text-muted)', marginTop: '4px' }}>
                      Synthesized from the alias table — edit it on the{' '}
                      <button
                        type="button"
                        onClick={onShowAliases}
                        style={{ padding: 0, border: 'none', background: 'none', font: 'inherit', color: 'var(--accent, #60a5fa)', textDecoration: 'underline', cursor: 'pointer' }}
                      >
                        Aliases
                      </button>{' '}
                      tab.
                    </div>
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
