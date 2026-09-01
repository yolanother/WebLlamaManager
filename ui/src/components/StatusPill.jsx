// Llama Manager — chat-first shell top-bar status pill.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Renders the health dot, coarse service state, and active model (or
// "Router (Multi)") in the chat-first shell's top bar. Clicking the pill
// toggles the existing `StatsHeader` as a popover strip beneath it; Escape
// and an outside click close the popover.

import { useEffect, useRef, useState } from 'react';

import { StatsHeader } from './StatsHeader.jsx';
import { statusPillLabel } from './statusPillLabel.js';

/**
 * Health/state/model pill that expands into the live stats strip.
 *
 * @param {object} props
 * @param {object} props.stats - The websocket `stats` payload.
 */
function StatusPill({ stats }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const { healthy, state, modelLabel } = statusPillLabel(stats);

  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className="status-pill-wrap" ref={wrapRef}>
      <button
        type="button"
        className="status-pill"
        aria-expanded={open}
        aria-label="Toggle live stats"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`status-pill-dot ${healthy ? 'healthy' : state === 'Starting' ? 'starting' : 'stopped'}`} />
        <span className="status-pill-state">{state}</span>
        <span className="status-pill-model">{modelLabel}</span>
      </button>
      {open && (
        <div className="status-pill-popover">
          <StatsHeader stats={stats} />
        </div>
      )}
    </div>
  );
}

export { StatusPill };
