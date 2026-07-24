// Llama Manager — in-composer model picker.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Provides a searchable, keyboard-accessible model dropdown with first-class
// automatic small-brain routing.

import { useEffect, useMemo, useRef, useState } from 'react';

import { formatModelName } from '../../api.js';

/**
 * Searchable model picker designed to live inside the chat composer.
 */
function ModelPicker({ value = 'auto', models, onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const options = useMemo(() => [
    { value: 'auto', label: 'Auto — small brain routes' },
    ...models.map((model) => ({
      value: model.id,
      label: formatModelName(model),
    })),
  ], [models]);
  const selected = options.find((option) => option.value === value) || options[0];
  const filtered = options.filter((option) => (
    `${option.label} ${option.value}`.toLowerCase().includes(query.toLowerCase())
  ));

  useEffect(() => {
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  return (
    <div className="chat-model-picker" ref={rootRef}>
      <button
        type="button"
        className="chat-model-trigger"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        title={selected.label}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h16M7 12h10M10 17h4" />
        </svg>
        <span>{selected.label}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true" className="chat-model-chevron">
          <path d="m8 10 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="chat-model-menu glass-panel glass-panel--floating">
          <label className="chat-visually-hidden" htmlFor="chat-model-search">
            Search models
          </label>
          <input
            id="chat-model-search"
            ref={searchRef}
            className="glass-input chat-model-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setOpen(false);
                setQuery('');
              }
            }}
            placeholder="Search models"
          />
          <div className="chat-model-options" role="listbox" aria-label="Chat model">
            {filtered.map((option) => (
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className="chat-model-option"
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  setQuery('');
                }}
              >
                <span>{option.label}</span>
                {option.value === value && (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="chat-model-empty">No matching models</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export { ModelPicker };
