// Copyright (c) Llama Manager contributors.
// Use of this source code is governed by the LICENSE file in the repository root.
//
// Browser entry point for the dashboard. Loads the global style foundations,
// initializes runtime site and color themes, and mounts the React application.

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './theme/glass.css';
import { initSiteTheme } from './theme/siteTheme.js';

// Load & apply the persisted site theme before first paint (best-effort; never
// throws — a missing themes manifest leaves the default appearance in place).
initSiteTheme();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
