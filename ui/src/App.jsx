import React, { useState, useEffect, useCallback } from 'react';
import './App.css';

const API_BASE = '/api';

function App() {
  const [status, setStatus] = useState(null);
  const [models, setModels] = useState({});
  const [currentModel, setCurrentModel] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showAddModel, setShowAddModel] = useState(false);
  const [newModel, setNewModel] = useState({
    id: '',
    name: '',
    repoid: '',
    model: '',
    quantization: 'Q5_K_M',
    context: 0,
    temp: 0.7,
    topP: 1.0,
    topK: 20,
    minP: 0,
    extraSwitches: '--jinja'
  });

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/status`);
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      console.error('Failed to fetch status:', err);
    }
  }, []);

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/models`);
      const data = await res.json();
      setModels(data.models);
      setCurrentModel(data.currentModel);
    } catch (err) {
      console.error('Failed to fetch models:', err);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchModels();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus, fetchModels]);

  const startServer = async (modelId) => {
    setLoading(true);
    try {
      await fetch(`${API_BASE}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId })
      });
      await fetchStatus();
    } catch (err) {
      console.error('Failed to start server:', err);
    }
    setLoading(false);
  };

  const stopServer = async () => {
    setLoading(true);
    try {
      await fetch(`${API_BASE}/stop`, { method: 'POST' });
      await fetchStatus();
    } catch (err) {
      console.error('Failed to stop server:', err);
    }
    setLoading(false);
  };

  const searchModels = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`${API_BASE}/search?query=${encodeURIComponent(searchQuery + ' gguf')}`);
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch (err) {
      console.error('Failed to search:', err);
    }
    setSearching(false);
  };

  const pullModel = async (repoid, model, quantization = 'Q5_K_M') => {
    try {
      await fetch(`${API_BASE}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoid, model, quantization })
      });
      fetchStatus();
    } catch (err) {
      console.error('Failed to pull model:', err);
    }
  };

  const addModel = async () => {
    if (!newModel.id || !newModel.repoid || !newModel.model) return;
    try {
      await fetch(`${API_BASE}/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newModel)
      });
      await fetchModels();
      setShowAddModel(false);
      setNewModel({
        id: '',
        name: '',
        repoid: '',
        model: '',
        quantization: 'Q5_K_M',
        context: 0,
        temp: 0.7,
        topP: 1.0,
        topK: 20,
        minP: 0,
        extraSwitches: '--jinja'
      });
    } catch (err) {
      console.error('Failed to add model:', err);
    }
  };

  const deleteModel = async (modelId) => {
    if (!confirm(`Delete model configuration "${modelId}"?`)) return;
    try {
      await fetch(`${API_BASE}/models/${modelId}`, { method: 'DELETE' });
      await fetchModels();
    } catch (err) {
      console.error('Failed to delete model:', err);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Llama Manager</h1>
        <div className="status-badge">
          <span className={`dot ${status?.llamaHealthy ? 'healthy' : status?.llamaRunning ? 'starting' : 'stopped'}`} />
          {status?.llamaHealthy ? 'Running' : status?.llamaRunning ? 'Starting...' : 'Stopped'}
          {status?.currentModel && ` - ${models[status.currentModel]?.name || status.currentModel}`}
        </div>
      </header>

      <main className="main">
        <section className="section">
          <div className="section-header">
            <h2>Models</h2>
            <button className="btn-primary" onClick={() => setShowAddModel(true)}>
              + Add Model
            </button>
          </div>

          <div className="models-grid">
            {Object.entries(models).map(([id, model]) => (
              <div
                key={id}
                className={`model-card ${status?.currentModel === id ? 'active' : ''}`}
              >
                <div className="model-header">
                  <h3>{model.name || id}</h3>
                  {status?.currentModel === id && (
                    <span className="active-badge">Active</span>
                  )}
                </div>
                <div className="model-info">
                  <p><strong>Repo:</strong> {model.repoid}/{model.model}</p>
                  <p><strong>Quantization:</strong> {model.quantization}</p>
                  <p><strong>Context:</strong> {model.context || 'Default'}</p>
                </div>
                <div className="model-actions">
                  {status?.currentModel === id && status?.llamaRunning ? (
                    <button
                      className="btn-danger"
                      onClick={stopServer}
                      disabled={loading}
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      className="btn-primary"
                      onClick={() => startServer(id)}
                      disabled={loading || status?.llamaRunning}
                    >
                      {status?.llamaRunning ? 'Switch' : 'Start'}
                    </button>
                  )}
                  <button
                    className="btn-ghost"
                    onClick={() => deleteModel(id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        {showAddModel && (
          <section className="section modal-overlay">
            <div className="modal">
              <div className="modal-header">
                <h2>Add Model Configuration</h2>
                <button className="btn-ghost" onClick={() => setShowAddModel(false)}>
                  &times;
                </button>
              </div>
              <div className="form-grid">
                <div className="form-group">
                  <label>ID (unique key)</label>
                  <input
                    type="text"
                    value={newModel.id}
                    onChange={(e) => setNewModel({ ...newModel, id: e.target.value })}
                    placeholder="e.g., llama3"
                  />
                </div>
                <div className="form-group">
                  <label>Display Name</label>
                  <input
                    type="text"
                    value={newModel.name}
                    onChange={(e) => setNewModel({ ...newModel, name: e.target.value })}
                    placeholder="e.g., Llama 3 70B"
                  />
                </div>
                <div className="form-group">
                  <label>HuggingFace Repo ID</label>
                  <input
                    type="text"
                    value={newModel.repoid}
                    onChange={(e) => setNewModel({ ...newModel, repoid: e.target.value })}
                    placeholder="e.g., TheBloke"
                  />
                </div>
                <div className="form-group">
                  <label>Model Name</label>
                  <input
                    type="text"
                    value={newModel.model}
                    onChange={(e) => setNewModel({ ...newModel, model: e.target.value })}
                    placeholder="e.g., Llama-3-70B-Instruct-GGUF"
                  />
                </div>
                <div className="form-group">
                  <label>Quantization</label>
                  <select
                    value={newModel.quantization}
                    onChange={(e) => setNewModel({ ...newModel, quantization: e.target.value })}
                  >
                    <option value="Q4_K_M">Q4_K_M</option>
                    <option value="Q5_K_M">Q5_K_M</option>
                    <option value="Q6_K">Q6_K</option>
                    <option value="Q8_0">Q8_0</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Context Size (0 = default)</label>
                  <input
                    type="number"
                    value={newModel.context}
                    onChange={(e) => setNewModel({ ...newModel, context: parseInt(e.target.value) || 0 })}
                  />
                </div>
                <div className="form-group">
                  <label>Temperature</label>
                  <input
                    type="number"
                    step="0.1"
                    value={newModel.temp}
                    onChange={(e) => setNewModel({ ...newModel, temp: parseFloat(e.target.value) || 0.7 })}
                  />
                </div>
                <div className="form-group">
                  <label>Top P</label>
                  <input
                    type="number"
                    step="0.1"
                    value={newModel.topP}
                    onChange={(e) => setNewModel({ ...newModel, topP: parseFloat(e.target.value) || 1.0 })}
                  />
                </div>
              </div>
              <div className="modal-actions">
                <button className="btn-ghost" onClick={() => setShowAddModel(false)}>
                  Cancel
                </button>
                <button className="btn-primary" onClick={addModel}>
                  Add Model
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="section">
          <h2>Search HuggingFace</h2>
          <div className="search-bar">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search for GGUF models..."
              onKeyDown={(e) => e.key === 'Enter' && searchModels()}
            />
            <button className="btn-primary" onClick={searchModels} disabled={searching}>
              {searching ? 'Searching...' : 'Search'}
            </button>
          </div>

          {searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.map((result) => (
                <div key={result.id} className="search-result">
                  <div className="result-info">
                    <h4>{result.id}</h4>
                    <p>{result.downloads?.toLocaleString()} downloads</p>
                  </div>
                  <button
                    className="btn-secondary"
                    onClick={() => pullModel(result.author, result.modelId)}
                  >
                    Pull
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {status?.downloads && Object.keys(status.downloads).length > 0 && (
          <section className="section">
            <h2>Downloads</h2>
            <div className="downloads-list">
              {Object.entries(status.downloads).map(([id, info]) => (
                <div key={id} className="download-item">
                  <span>{id}</span>
                  <div className="progress-bar">
                    <div
                      className="progress-fill"
                      style={{ width: `${info.progress}%` }}
                    />
                  </div>
                  <span>{info.status} ({info.progress}%)</span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="section">
          <h2>Server Info</h2>
          <div className="info-grid">
            <div className="info-item">
              <span className="info-label">API Status</span>
              <span className={`info-value ${status?.apiRunning ? 'success' : 'error'}`}>
                {status?.apiRunning ? 'Running' : 'Offline'}
              </span>
            </div>
            <div className="info-item">
              <span className="info-label">Llama Server</span>
              <span className={`info-value ${status?.llamaHealthy ? 'success' : 'warning'}`}>
                {status?.llamaHealthy ? 'Healthy' : status?.llamaRunning ? 'Starting' : 'Stopped'}
              </span>
            </div>
            <div className="info-item">
              <span className="info-label">Llama Port</span>
              <span className="info-value">{status?.llamaPort || 8080}</span>
            </div>
            <div className="info-item">
              <span className="info-label">Current Model</span>
              <span className="info-value">{status?.currentModel || 'None'}</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
