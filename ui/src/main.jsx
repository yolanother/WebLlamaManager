// Copyright (c) Llama Manager contributors.
// Use of this source code is governed by the LICENSE file in the repository root.
//
// Browser entry point for the dashboard. Loads the global style foundations,
// initializes runtime site and color themes plus the Look/Layout appearance
// preferences, and mounts the React application.

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './theme/glass.css';
import './theme/professional.css';
import { initSiteTheme } from './theme/siteTheme.js';
import { initUiPrefs } from './theme/uiPrefs.js';

// Load & apply the persisted site theme before first paint (best-effort; never
// throws — a missing themes manifest leaves the default appearance in place).
initSiteTheme();

// Apply the persisted (or URL-overridden) Look and Layout preferences before
// first paint — sets `data-look`/`data-layout` on <html>.
initUiPrefs();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
