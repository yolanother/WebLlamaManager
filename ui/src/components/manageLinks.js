// Llama Manager — chat-first shell "Manage" navigation model.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Pure, DOM-free ordered list of the admin routes (plus the external
// llama.cpp UI link) rendered inside the chat-first shell's collapsible
// "Manage" group (`ChatSidebar.jsx`). Kept separate from the JSX so the
// navigation model itself is covered by `node --test` without a JSX
// transform.

/**
 * One "Manage" group entry.
 * @typedef {object} ManageLink
 * @property {string} key - Stable identifier; also the icon lookup key.
 * @property {string|null} to - Route path, or `null` for the external entry.
 * @property {string} label - Visible link text.
 * @property {boolean} [external] - True for the llama.cpp UI link, whose
 *   `href` is computed at render time from live stats rather than `to`.
 */

/** @type {ManageLink[]} Ordered "Manage" group entries. */
export const MANAGE_LINKS = [
  { key: 'dashboard', to: '/dashboard', label: 'Dashboard' },
  { key: 'models', to: '/models', label: 'Models' },
  { key: 'presets', to: '/presets', label: 'Presets' },
  { key: 'download', to: '/download', label: 'Download' },
  { key: 'logs', to: '/logs', label: 'Logs' },
  { key: 'queue', to: '/queue', label: 'Queue' },
  { key: 'processes', to: '/processes', label: 'Processes' },
  { key: 'docs', to: '/docs', label: 'Docs' },
  { key: 'api-docs', to: '/api-docs', label: 'API Docs' },
  { key: 'llama-cpp', to: null, label: 'llama.cpp UI', external: true },
];
