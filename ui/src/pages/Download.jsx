// Llama Manager — model download page.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Searches and inspects Hugging Face GGUF repositories and starts supported
// model downloads, including the DS4 catalog, in responsive glass panels.

import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { API_BASE, formatBytes } from '../api.js';
import '../styles/pages.css';

// Download Page
// The DS4 / DeepSeek V4 download catalog. Only the antirez/deepseek-v4-gguf repo
// is allowlisted server-side; oversized variants are shown for context but are
// NOT one-click downloadable on this 128GB Strix Halo (they OOM the box).
const DS4_REPO = 'antirez/deepseek-v4-gguf';
// `pattern` is the HF --include glob sent to the allowlisted download endpoint;
// `match` is the substring that identifies an already-present file in the ds4 dir.
const DS4_OPTIONS = [
  { key: 'q2-imatrix', label: 'Q2 (imatrix)', size: '~81GB', pattern: '*imatrix*', match: 'imatrix', fits: true, recommended: true,
    desc: 'Recommended — the best-fitting DeepSeek V4 Flash quant for this 128GB Strix Halo.' },
  { key: 'mtp', label: 'MTP (speculative)', size: '~3.5GB', pattern: '*mtp*', match: 'mtp', fits: true, recommended: false,
    desc: 'Optional multi-token-prediction file for speculative decoding.' },
  { key: 'q2-q4', label: 'Q2-Q4 mix', size: '~98GB', pattern: null, match: null, fits: false, recommended: false,
    desc: 'Does not fit this machine — can cause system OOM.' },
  { key: 'q4', label: 'Q4', size: '~153GB', pattern: null, match: null, fits: false, recommended: false,
    desc: 'Does not fit this machine — can cause system OOM.' },
  { key: 'pro', label: 'Pro variants', size: '≥153GB', pattern: null, match: null, fits: false, recommended: false,
    desc: 'Does not fit this machine — can cause system OOM.' },
];

function DownloadPage({ stats }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [repoQuantizations, setRepoQuantizations] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [repoError, setRepoError] = useState(null);
  const [customPattern, setCustomPattern] = useState('');
  const [ds4Models, setDs4Models] = useState([]);
  const [ds4GgufDir, setDs4GgufDir] = useState('');
  const [ds4Downloading, setDs4Downloading] = useState(null);

  // Poll which ds4 GGUFs are already present so the section can show them as available.
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
    fetchDs4Models();
    const t = setInterval(fetchDs4Models, 10000);
    return () => clearInterval(t);
  }, [fetchDs4Models]);

  // LIVE VERIFICATION PENDING: the DS4 preset editor + Downloads-tab DS4 section
  // compile and are wired to /api/ds4/models and /api/ds4/download; the actual
  // browser click-through (create a ds4 preset, run the recommended download,
  // confirm progress + present-file listing) is verified by the operator after
  // install.sh deploy — the 81GB model download needs a real memory window.
  // Kick off an allowlisted ds4 download into the dedicated ggufDir (never ~/models).
  const downloadDs4 = async (opt) => {
    if (!opt.fits || !opt.pattern) return;
    setDs4Downloading(opt.key);
    try {
      const res = await fetch(`${API_BASE}/ds4/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: DS4_REPO, pattern: opt.pattern })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || 'Failed to start ds4 download');
      }
    } catch (err) {
      console.error('Failed to start ds4 download:', err);
    }
    setDs4Downloading(null);
  };

  const searchModels = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSelectedRepo(null);
    setRepoQuantizations([]);
    setRepoError(null);
    try {
      const res = await fetch(`${API_BASE}/search?query=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch (err) {
      console.error('Failed to search:', err);
    }
    setSearching(false);
  };

  const selectRepo = async (repo) => {
    setSelectedRepo(repo);
    setLoadingFiles(true);
    setRepoError(null);
    setRepoQuantizations([]);
    try {
      const [author, model] = repo.id.split('/');
      const res = await fetch(`${API_BASE}/repo/${author}/${model}/files`);
      const data = await res.json();
      if (data.error) {
        setRepoError(data.error);
      } else {
        setRepoQuantizations(data.quantizations || []);
      }
    } catch (err) {
      console.error('Failed to fetch repo files:', err);
      setRepoError(err.message);
    }
    setLoadingFiles(false);
  };

  const downloadModel = async (repo, quantization) => {
    try {
      await fetch(`${API_BASE}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, quantization })
      });
    } catch (err) {
      console.error('Failed to start download:', err);
    }
  };

  const downloadAllGguf = async (repo) => {
    try {
      await fetch(`${API_BASE}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo })
      });
    } catch (err) {
      console.error('Failed to start download:', err);
    }
  };

  const downloadWithPattern = async (repo, pattern) => {
    if (!pattern.trim()) return;
    try {
      await fetch(`${API_BASE}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, pattern: pattern.trim() })
      });
      setCustomPattern('');
    } catch (err) {
      console.error('Failed to start download:', err);
    }
  };

  const EMBED_SUGGESTIONS = [
    { repo: 'Qwen/Qwen3-Embedding-0.6B-GGUF', label: 'Qwen3-Embedding-0.6B (1024-dim, recommended)' },
    { repo: 'nomic-ai/nomic-embed-text-v1.5-GGUF', label: 'nomic-embed-text-v1.5 (768-dim)' },
    { repo: 'BAAI/bge-m3-GGUF', label: 'BGE-M3 (1024-dim, multilingual)' }
  ];

  const ds4Names = ds4Models.map(m => m.name.toLowerCase());
  const isDs4OptPresent = (opt) => !!opt.match && ds4Names.some(n => n.includes(opt.match));
  const recommended = DS4_OPTIONS.find(o => o.recommended);

  return (
    <div className="page">
      <div className="page-header">
        <h2>Download Models</h2>
      </div>

      {/* ── DS4 / DeepSeek V4 section ──────────────────────────────────────── */}
      <div id="ds4" />
      <section className="page-section glass-panel ds4-download-section">
        <div className="ds4-section-header">
          <h3>DS4 / DeepSeek V4</h3>
          <span className="engine-badge ds4">exclusive engine</span>
        </div>
        <p className="page-description">
          Special ds4-only GGUFs from <code>{DS4_REPO}</code>. These load only in the DS4 engine and
          download into the dedicated ds4 dir{ds4GgufDir ? ` (${ds4GgufDir})` : ''} — never into <code>~/models</code>.
        </p>
        {recommended && (
          <button
            className="btn-primary glass-btn ds4-recommended-btn"
            onClick={() => downloadDs4(recommended)}
            disabled={ds4Downloading === recommended.key || isDs4OptPresent(recommended)}
            title={`Download ${recommended.label} (${recommended.size}) into the ds4 dir`}
          >
            {isDs4OptPresent(recommended)
              ? `Recommended already downloaded — ${recommended.label}`
              : ds4Downloading === recommended.key
                ? 'Starting...'
                : `Download recommended — ${recommended.label} (${recommended.size})`}
          </button>
        )}
        <div className="ds4-options-list">
          {DS4_OPTIONS.map((opt) => {
            const present = isDs4OptPresent(opt);
            return (
              <div key={opt.key} className={`ds4-option${opt.fits ? '' : ' unfit'}${opt.recommended ? ' recommended' : ''}`}>
                <div className="ds4-option-info">
                  <span className="ds4-option-title">
                    {opt.label} <span className="ds4-option-size">{opt.size}</span>
                    {opt.recommended && <span className="ds4-tag rec">RECOMMENDED</span>}
                    {!opt.fits && <span className="ds4-tag unfit">does not fit — can OOM</span>}
                    {present && <span className="ds4-tag present">downloaded</span>}
                  </span>
                  <span className="ds4-option-desc">{opt.desc}</span>
                </div>
                {opt.fits && opt.pattern ? (
                  <button
                    className="btn-secondary glass-btn"
                    onClick={() => downloadDs4(opt)}
                    disabled={ds4Downloading === opt.key || present}
                  >
                    {present ? 'Available' : ds4Downloading === opt.key ? 'Starting...' : 'Download'}
                  </button>
                ) : (
                  <button className="btn-secondary glass-btn" disabled title="Too large for this machine">Unavailable</button>
                )}
              </div>
            );
          })}
        </div>
        {ds4Models.length > 0 && (
          <div className="ds4-present-list">
            <h4>Present in ds4 dir</h4>
            {ds4Models.map(m => (
              <div key={m.name} className="ds4-present-item">
                <span>{m.name}</span>
                <span className="ds4-option-size">{m.sizeBytes ? formatBytes(m.sizeBytes) : ''}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="search-section">
        <div className="card glass-panel">
          <h3>Recommended embedding models</h3>
          {EMBED_SUGGESTIONS.map(s => (
            <button key={s.repo} className="btn-secondary glass-btn" onClick={() => { setSearchQuery(s.repo); }} title={s.repo}>{s.label}</button>
          ))}
        </div>
        <div className="search-bar">
          <input
            type="text"
            className="glass-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search HuggingFace for GGUF models..."
            onKeyDown={(e) => e.key === 'Enter' && searchModels()}
          />
          <button className="btn-primary glass-btn" onClick={searchModels} disabled={searching}>
            {searching ? 'Searching...' : 'Search'}
          </button>
        </div>
      </div>

      {/* Active Downloads */}
      {stats?.downloads && Object.keys(stats.downloads).length > 0 && (
        <section className="page-section glass-panel">
          <h3>Active Downloads</h3>
          <div className="downloads-list">
            {Object.entries(stats.downloads).map(([id, info]) => (
              <div key={id} className={`download-item ${info.status}`}>
                <div className="download-info">
                  <span className="download-name">{id}</span>
                  <span className="download-status-text">
                    {info.status === 'completed' ? 'Complete' :
                     info.status === 'failed' ? `Failed: ${info.error}` :
                     info.status === 'starting' ? 'Starting...' : 'Downloading...'}
                  </span>
                  {info.status === 'failed' && info.needsHfToken && (
                    <Link className="download-gated-link" to="/settings">
                      Add a HuggingFace token in Settings →
                    </Link>
                  )}
                  {info.status === 'failed' && info.gatedUrl && (
                    <a className="download-gated-link" href={info.gatedUrl} target="_blank" rel="noopener noreferrer">
                      Request access on HuggingFace ↗
                    </a>
                  )}
                </div>
                <div className="download-progress">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${info.progress}%` }} />
                  </div>
                  <span className="download-percent">{info.progress}%</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Search Results */}
      {searchResults.length > 0 && !selectedRepo && (
        <section className="page-section glass-panel">
          <h3>Search Results</h3>
          <div className="search-results">
            {searchResults.map((result) => (
              <div key={result.id} className="search-result" onClick={() => selectRepo(result)}>
                <div className="result-info">
                  <h4>{result.id}</h4>
                  <p>{result.downloads?.toLocaleString()} downloads</p>
                </div>
                <span className="arrow">→</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Selected Repo */}
      {selectedRepo && (
        <section className="page-section glass-panel">
          <div className="repo-header">
            <button className="btn-ghost glass-btn" onClick={() => setSelectedRepo(null)}>
              ← Back
            </button>
            <h3>{selectedRepo.id}</h3>
            <a
              href={`https://huggingface.co/${selectedRepo.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="repo-link"
            >
              View on HuggingFace ↗
            </a>
          </div>

          {loadingFiles ? (
            <div className="loading-state">
              <div className="loading-spinner"></div>
              <p>Scanning repository for GGUF files...</p>
            </div>
          ) : repoError ? (
            <div className="error-state">
              <p>Error loading repository: {repoError}</p>
              <div className="fallback-options">
                <p>You can still try to download using a custom pattern:</p>
                <div className="custom-download-row">
                  <input
                    type="text"
                    className="glass-input"
                    value={customPattern}
                    onChange={(e) => setCustomPattern(e.target.value)}
                    placeholder="e.g., *.gguf or *Q4_K_M*.gguf"
                  />
                  <button
                    className="btn-primary glass-btn"
                    onClick={() => downloadWithPattern(selectedRepo.id, customPattern)}
                    disabled={!customPattern.trim()}
                  >
                    Download
                  </button>
                </div>
              </div>
            </div>
          ) : repoQuantizations.length === 0 ? (
            <div className="no-quants-state">
              <p>No recognized quantizations found in this repository.</p>
              <p className="hint">The repository may use different naming conventions or store files in subdirectories.</p>

              <div className="fallback-options">
                <h4>Download Options</h4>

                <div className="option-card">
                  <div className="option-info">
                    <span className="option-title">Download all GGUF files</span>
                    <span className="option-desc">Downloads any file ending in .gguf</span>
                  </div>
                  <button
                    className="btn-primary glass-btn"
                    onClick={() => downloadAllGguf(selectedRepo.id)}
                  >
                    Download All
                  </button>
                </div>

                <div className="option-card">
                  <div className="option-info">
                    <span className="option-title">Custom pattern</span>
                    <span className="option-desc">Specify a glob pattern (e.g., *Q5_K_M*.gguf)</span>
                  </div>
                  <div className="custom-download-row">
                    <input
                      type="text"
                      className="glass-input"
                      value={customPattern}
                      onChange={(e) => setCustomPattern(e.target.value)}
                      placeholder="*Q4_K_M*.gguf"
                    />
                    <button
                      className="btn-primary glass-btn"
                      onClick={() => downloadWithPattern(selectedRepo.id, customPattern)}
                      disabled={!customPattern.trim()}
                    >
                      Download
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="quant-list">
              {repoQuantizations.map((quant) => (
                <div key={quant.quantization} className="quant-item">
                  <div className="quant-info">
                    <span className="quant-badge">{quant.quantization}</span>
                    <span className="quant-size">
                      {formatBytes(quant.totalSize)}
                      {quant.isSplit && ` (${quant.files.length} parts)`}
                    </span>
                  </div>
                  <button
                    className="btn-primary glass-btn"
                    onClick={() => downloadModel(selectedRepo.id, quant.quantization)}
                  >
                    Download
                  </button>
                </div>
              ))}

              {/* Also offer custom pattern option */}
              <div className="quant-item custom-pattern">
                <div className="quant-info">
                  <span className="quant-badge secondary">Custom</span>
                  <input
                    type="text"
                    value={customPattern}
                    onChange={(e) => setCustomPattern(e.target.value)}
                    placeholder="Custom pattern (e.g., *IQ4*.gguf)"
                    className="inline-input glass-input"
                  />
                </div>
                <button
                  className="btn-secondary glass-btn"
                  onClick={() => downloadWithPattern(selectedRepo.id, customPattern)}
                  disabled={!customPattern.trim()}
                >
                  Download
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export default DownloadPage;
