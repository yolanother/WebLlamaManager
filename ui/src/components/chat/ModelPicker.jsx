// Llama Manager — in-composer model picker.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Provides a searchable, keyboard-accessible model dropdown with first-class
// automatic small-brain routing. Models are collapsed into families showing the
// best available build, each expandable to pick a specific quantization.

import { useEffect, useMemo, useRef, useState } from 'react';

import { formatModelName } from '../../api.js';
import { groupModelsByFamily } from './modelFamilies.js';

/**
 * Searchable model picker designed to live inside the chat composer.
 */
function ModelPicker({ value = 'auto', models, onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const autoOption = { value: 'auto', label: 'Auto — small brain routes' };
  const options = useMemo(() => [
    autoOption,
    ...models.map((model) => ({
      value: model.id,
      label: formatModelName(model),
    })),
  ], [models]);
  const selected = options.find((option) => option.value === value) || options[0];
  const filtered = options.filter((option) => (
    `${option.label} ${option.value}`.toLowerCase().includes(query.toLowerCase())
  ));
  // groupModelsByFamily keys off `id`; the option list carries `value`.
  const groups = useMemo(
    () => groupModelsByFamily(models.map((model) => ({
      id: model.id,
      value: model.id,
      label: formatModelName(model),
    }))),
    [models],
  );

  const toggleFamily = (family) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(family)) next.delete(family); else next.add(family);
    return next;
  });

  const choose = (next) => {
    onChange(next);
    setOpen(false);
    setQuery('');
  };

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
            {/* Searching flattens the families: a specific quantization is
                exactly what someone types a query to reach, so hiding it
                behind a fold-out would defeat the search. */}
            {query ? (
              <>
                {filtered.map((option) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    className="chat-model-option"
                    key={option.value}
                    onClick={() => choose(option.value)}
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
              </>
            ) : (
              <>
                <button
                  type="button"
                  role="option"
                  aria-selected={value === 'auto'}
                  className="chat-model-option"
                  onClick={() => choose('auto')}
                >
                  <span>{autoOption.label}</span>
                  {value === 'auto' && (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                  )}
                </button>
                {groups.map(({ family, best, members }) => {
                  const isOpen = expanded.has(family);
                  const activeMember = members.find((member) => member.value === value);
                  const single = members.length === 1;
                  return (
                    <div className="chat-model-family" key={family}>
                      <div className="chat-model-family-row">
                        <button
                          type="button"
                          role="option"
                          aria-selected={Boolean(activeMember)}
                          className="chat-model-option chat-model-option--family"
                          onClick={() => choose((activeMember || best).value)}
                          title={(activeMember || best).label}
                        >
                          <span>{family}</span>
                          {/* Name the build only when it is not the obvious one,
                              so the common case stays a clean family name. */}
                          {activeMember && activeMember.value !== best.value && (
                            <span className="chat-model-variant">{activeMember.label}</span>
                          )}
                          {activeMember && (
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="m5 12 4 4L19 6" />
                            </svg>
                          )}
                        </button>
                        {!single && (
                          <button
                            type="button"
                            className="chat-model-family-toggle"
                            aria-expanded={isOpen}
                            aria-label={`${isOpen ? 'Hide' : 'Show'} ${members.length} builds of ${family}`}
                            onClick={() => toggleFamily(family)}
                          >
                            <span>{members.length}</span>
                            <svg viewBox="0 0 24 24" aria-hidden="true" className="chat-model-chevron">
                              <path d="m8 10 4 4 4-4" />
                            </svg>
                          </button>
                        )}
                      </div>
                      {isOpen && !single && members.map((member) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={member.value === value}
                          className="chat-model-option chat-model-option--member"
                          key={member.value}
                          onClick={() => choose(member.value)}
                        >
                          <span>{member.label}</span>
                          {member.value === value && (
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="m5 12 4 4L19 6" />
                            </svg>
                          )}
                        </button>
                      ))}
                    </div>
                  );
                })}
                {groups.length === 0 && (
                  <p className="chat-model-empty">No models available</p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export { ModelPicker };
