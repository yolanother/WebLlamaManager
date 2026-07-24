import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { initSiteTheme } from './theme/siteTheme.js';

// Load & apply the persisted site theme before first paint (best-effort; never
// throws — a missing themes manifest leaves the default appearance in place).
initSiteTheme();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
