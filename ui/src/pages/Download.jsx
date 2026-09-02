// Llama Manager — model download page.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Searches HuggingFace for GGUF repositories, ranks their quantizations by
// whether they fit this machine's memory budget, and starts downloads
// (including the ds4/DeepSeek V4 exclusive-engine catalog) in responsive
// glass panels. Active Downloads is shown first, then a "Recommended models"
// chip row for one-click repo selection, then the search bar and results.
// Per-repo fit/recommendation logic lives in ./download-helpers.js so this
// file stays a thin render layer.

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { API_BASE, formatBytes } from '../api.js';
import { RECOMMENDED_REPOS, partitionQuantizations, downloadRequests } from './download-helpers.js';
import '../styles/pages.css';

/**
 * One quantization/mmproj row in the selected-repo view, rendered via the
 * shared `.ds4-option` styling. `variant` picks the tag/button treatment:
 * 'fit' (plain download row), 'unfit' (greyed, disabled), or 'mmproj'
 * (vision-projector row).
 */
function QuantRow({ entry, variant, downloadingKey, onDownload }) {
  const busy = downloadingKey === entry.quantization;
  return (
    <div className={`ds4-option${variant === 'unfit' ? ' unfit' : ''}`}>
      <div className="ds4-option-info">
        <span className="ds4-option-title">
          {entry.quantization}{' '}
          <span className="ds4-option-size">
            {formatBytes(entry.totalSize)}
            {entry.isSplit && ` (${entry.totalParts || entry.files.length} parts)`}
          </span>
          {variant === 'unfit' && <span className="ds4-tag unfit">does not fit — can OOM</span>}
          {variant === 'mmproj' && <span className="ds4-tag">mmproj (vision)</span>}
          {entry.present && <span className="ds4-tag present">downloaded</span>}
        </span>
      </div>
      {variant === 'unfit' ? (
        <button className="btn-secondary glass-btn" disabled title="Too large for this machine — can OOM">
          Unavailable
        </button>
      ) : (
        <button
          className="btn-secondary glass-btn"
          onClick={() => onDownload(entry)}
          disabled={entry.present || busy}
        >
          {entry.present ? 'Available' : busy ? 'Starting...' : 'Download'}
        </button>
      )}
    </div>
  );
}

function DownloadPage({ stats }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState(null);
  // The raw /repo/:author/:model/files response plus the repo id it was
  // fetched for (the endpoint doesn't echo the repo, downloadRequests needs it).
  const [repoData, setRepoData] = useState(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [repoError, setRepoError] = useState(null);
  const [customPattern, setCustomPattern] = useState('');
  const [downloadingKey, setDownloadingKey] = useState(null);

  const searchModels = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSelectedRepo(null);
    setRepoData(null);
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
    setSearchQuery(repo.id);
    setLoadingFiles(true);
    setRepoError(null);
    setRepoData(null);
    try {
      const [author, model] = repo.id.split('/');
      const res = await fetch(`${API_BASE}/repo/${author}/${model}/files`);
      const data = await res.json();
      if (data.error) {
        setRepoError(data.error);
      } else {
        setRepoData({ ...data, repo: repo.id });
      }
    } catch (err) {
      console.error('Failed to fetch repo files:', err);
      setRepoError(err.message);
    }
    setLoadingFiles(false);
  };

  // Runs the request(s) from downloadRequests() in order (a "recommended"
  // download bundles the mmproj file ahead of the main quant, per contract).
  const runDownload = async (entry) => {
    const key = entry === 'recommended' ? 'recommended' : entry.quantization;
    setDownloadingKey(key);
    try {
      const requests = downloadRequests(repoData, entry);
      for (const req of requests) {
        const res = await fetch(`${API_BASE}${req.url}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body)
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert(err.error || 'Failed to start download');
          break;
        }
      }
    } catch (err) {
      console.error('Failed to start download:', err);
    }
    setDownloadingKey(null);
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

  const partition = repoData
    ? partitionQuantizations(repoData)
    : { recommended: null, fits: [], unfit: [], mmproj: [] };
  const hasQuants = !!repoData && (repoData.quantizations || []).length > 0;

  return (
    <div className="page">
      <div className="page-header">
        <h2>Download Models</h2>
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

      {/* ── Recommended models chip row ────────────────────────────────── */}
      <div id="ds4" />
      <section className="page-section glass-panel">
        <h3>Recommended models</h3>
        <div className="ds4-options-list">
          {RECOMMENDED_REPOS.map((r) => (
            <button
              key={r.id}
              className="btn-secondary glass-btn"
              onClick={() => selectRepo({ id: r.id })}
              title={r.id}
            >
              {r.label}
            </button>
          ))}
        </div>
      </section>

      <div className="search-section">
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

          {repoData?.engine === 'ds4' && (
            <p className="page-description">
              Exclusive engine — loads only in the DS4 engine and downloads into the dedicated ds4 dir
              {repoData.ggufDir ? ` (${repoData.ggufDir})` : ''}, never into <code>~/models</code>.
              <span className="engine-badge ds4">exclusive engine</span>
            </p>
          )}

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
          ) : !hasQuants ? (
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
            <div className="ds4-options-list">
              {partition.recommended && (
                <div className="ds4-option recommended">
                  <div className="ds4-option-info">
                    <span className="ds4-option-title">
                      {partition.recommended.quantization}{' '}
                      <span className="ds4-option-size">{formatBytes(partition.recommended.totalSize)}</span>
                      <span className="ds4-tag rec">RECOMMENDED</span>
                      {partition.recommended.present && <span className="ds4-tag present">downloaded</span>}
                    </span>
                  </div>
                  <button
                    className="btn-primary glass-btn ds4-recommended-btn"
                    onClick={() => runDownload('recommended')}
                    disabled={partition.recommended.present || downloadingKey === 'recommended'}
                  >
                    {partition.recommended.present
                      ? 'Recommended already downloaded'
                      : downloadingKey === 'recommended'
                        ? 'Starting...'
                        : `Download recommended — ${partition.recommended.quantization} (${formatBytes(partition.recommended.totalSize)})`}
                  </button>
                </div>
              )}

              {partition.fits.map((q) => (
                <QuantRow key={q.quantization} entry={q} variant="fit" downloadingKey={downloadingKey} onDownload={runDownload} />
              ))}
              {partition.unfit.map((q) => (
                <QuantRow key={q.quantization} entry={q} variant="unfit" downloadingKey={downloadingKey} onDownload={runDownload} />
              ))}
              {partition.mmproj.map((q) => (
                <QuantRow key={q.quantization} entry={q} variant="mmproj" downloadingKey={downloadingKey} onDownload={runDownload} />
              ))}

              {/* Also offer custom pattern option */}
              <div className="ds4-option">
                <div className="ds4-option-info">
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
