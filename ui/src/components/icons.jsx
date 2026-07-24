// Llama Manager — shared interface iconography.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Provides lightweight, Lucide-style SVG icons that inherit the surrounding
// text color and can be sized by each consuming component.

import React from 'react';

/**
 * Render the common accessible-by-default SVG shell used by navigation icons.
 * Consumers should add a label to the surrounding control; icons are decorative.
 */
function SvgIcon({ children, ...props }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Dashboard gauge icon. */
export function DashboardIcon(props) {
  return (
    <SvgIcon {...props}>
      <path d="M4.9 19a9 9 0 1 1 14.2 0" />
      <path d="M12 13l3.5-3.5" />
      <path d="M6.6 16h.01M12 7v.01M17.4 16h.01" />
    </SvgIcon>
  );
}

/** Chat message icon. */
export function ChatIcon(props) {
  return (
    <SvgIcon {...props}>
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
    </SvgIcon>
  );
}

/** Models package icon. */
export function ModelsIcon(props) {
  return (
    <SvgIcon {...props}>
      <path d="m21 8-9 5-9-5 9-5z" />
      <path d="m3 8 9 5 9-5v8l-9 5-9-5z" />
      <path d="M12 13v8" />
    </SvgIcon>
  );
}

/** Preset controls icon. */
export function PresetsIcon(props) {
  return (
    <SvgIcon {...props}>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
      <path d="M1 14h6M9 8h6M17 16h6" />
    </SvgIcon>
  );
}

/** Download arrow icon. */
export function DownloadIcon(props) {
  return (
    <SvgIcon {...props}>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </SvgIcon>
  );
}

/** Log scroll icon. */
export function LogsIcon(props) {
  return (
    <SvgIcon {...props}>
      <path d="M6 3h12v15a3 3 0 0 1-3 3H6a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3z" />
      <path d="M6 3a3 3 0 0 0-3 3v1h6V6a3 3 0 0 0-3-3zM12 8h3M12 12h3" />
    </SvgIcon>
  );
}

/** Queue list icon. */
export function QueueIcon(props) {
  return (
    <SvgIcon {...props}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </SvgIcon>
  );
}

/** Process CPU icon. */
export function ProcessesIcon(props) {
  return (
    <SvgIcon {...props}>
      <rect width="14" height="14" x="5" y="5" rx="2" />
      <path d="M9 9h6v6H9zM9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" />
    </SvgIcon>
  );
}

/** Documentation book icon. */
export function DocsIcon(props) {
  return (
    <SvgIcon {...props}>
      <path d="M2 4h6a4 4 0 0 1 4 4v13a4 4 0 0 0-4-4H2z" />
      <path d="M22 4h-6a4 4 0 0 0-4 4v13a4 4 0 0 1 4-4h6z" />
    </SvgIcon>
  );
}

/** API code icon. */
export function ApiDocsIcon(props) {
  return (
    <SvgIcon {...props}>
      <path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" />
    </SvgIcon>
  );
}

/** Settings gear icon. */
export function SettingsIcon(props) {
  return (
    <SvgIcon {...props}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </SvgIcon>
  );
}

/** External-link indicator icon. */
export function ExternalLinkIcon(props) {
  return (
    <SvgIcon {...props}>
      <path d="M15 3h6v6M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </SvgIcon>
  );
}

/** llama.cpp terminal icon. */
export function LlamaCppIcon(props) {
  return (
    <SvgIcon {...props}>
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m6 9 3 3-3 3M12 15h6" />
    </SvgIcon>
  );
}
