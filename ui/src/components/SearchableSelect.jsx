// Llama Manager — searchable select control.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Provides the reusable searchable model and option picker used throughout the
// management interface. Optionally collapses a model list into one row per
// family (Muse-Glimmer-30B, nomic-embed-text-v1.5, ...) that selects the
// family's highest-fidelity build by default and folds out to let a specific
// quantization be picked deliberately.

import React, { useState, useEffect, useMemo, useRef } from 'react';

import { groupModelsByFamily } from './chat/modelFamilies.js';

/**
 * Read the value an option carries, tolerating the plain-string option form.
 *
 * @param {object|string} opt An option object or a bare value.
 * @returns {string} The option's value.
 */
const optionValue = (opt) => opt.value || opt.id || opt;

// Searchable select component for model dropdowns
function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  disabled = false,
  storageKey = null,
  groupByFamily = false,
  formatOption = (opt) => opt.label || opt.id || opt.value || opt
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  // Load from localStorage on mount if storageKey provided
  useEffect(() => {
    if (storageKey && !value) {
      const saved = localStorage.getItem(storageKey);
      if (saved && options.some(opt => optionValue(opt) === saved)) {
        onChange(saved);
      }
    }
  }, [storageKey, options]);

  // Save to localStorage when value changes
  useEffect(() => {
    if (storageKey && value) {
      localStorage.setItem(storageKey, value);
    }
  }, [storageKey, value]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Filter options based on search
  const filteredOptions = options.filter(opt => {
    const label = formatOption(opt).toLowerCase();
    const val = optionValue(opt).toString().toLowerCase();
    const searchLower = search.toLowerCase();
    return label.includes(searchLower) || val.includes(searchLower);
  });

  // groupModelsByFamily keys off `id`; carry the original option alongside so
  // the rendered rows keep whatever shape the caller passed in.
  const groups = useMemo(() => (
    groupByFamily
      ? groupModelsByFamily(options.map(opt => ({ id: optionValue(opt).toString(), option: opt })))
      : []
  ), [groupByFamily, options]);

  // Get display value
  const selectedOption = options.find(opt => optionValue(opt) === value);
  const displayValue = selectedOption ? formatOption(selectedOption) : placeholder;

  const handleSelect = (opt) => {
    onChange(optionValue(opt));
    setIsOpen(false);
    setSearch('');
  };

  const toggleFamily = (family) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(family)) next.delete(family); else next.add(family);
    return next;
  });

  const renderOption = (opt, extraClass = '') => {
    const val = optionValue(opt);
    const label = formatOption(opt);
    return (
      <div
        key={val}
        className={`searchable-select-option ${extraClass} ${val === value ? 'selected' : ''}`}
        onClick={() => handleSelect(opt)}
        title={label}
      >
        {label}
      </div>
    );
  };

  return (
    <div className={`searchable-select ${disabled ? 'disabled' : ''}`} ref={containerRef}>
      <div
        className={`searchable-select-trigger ${isOpen ? 'open' : ''}`}
        onClick={() => {
          if (!disabled) {
            setIsOpen(!isOpen);
            if (!isOpen) setTimeout(() => inputRef.current?.focus(), 0);
          }
        }}
        title={value ? displayValue : ''}
      >
        <span className={value ? '' : 'placeholder'}>{displayValue}</span>
        <span className="searchable-select-arrow">▼</span>
      </div>
      {isOpen && (
        <div className="searchable-select-dropdown">
          <input
            ref={inputRef}
            type="text"
            className="searchable-select-search"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClick={(e) => e.stopPropagation()}
          />
          <div className="searchable-select-options">
            {filteredOptions.length === 0 ? (
              <div className="searchable-select-no-results">No matches found</div>
            ) : (groupByFamily && !search) ? (
              /* Searching flattens the families: a specific build is exactly
                 what someone types a query to reach, so hiding it behind a
                 fold-out would defeat the search. */
              groups.map(({ family, best, members }) => {
                const isOpen = expanded.has(family);
                const active = members.find((m) => optionValue(m.option) === value);
                const single = members.length === 1;
                const target = (active || best).option;
                return (
                  <div className="searchable-select-family" key={family}>
                    <div className="searchable-select-family-row">
                      <div
                        className={`searchable-select-option ${active ? 'selected' : ''}`}
                        onClick={() => handleSelect(target)}
                        title={formatOption(target)}
                      >
                        <span>{family}</span>
                        {/* Name the build only when it is not the family's
                            default, so the common case stays a clean name. */}
                        {active && optionValue(active.option) !== optionValue(best.option) && (
                          <span className="searchable-select-variant">{formatOption(active.option)}</span>
                        )}
                      </div>
                      {!single && (
                        <button
                          type="button"
                          className="searchable-select-family-toggle"
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? 'Hide' : 'Show'} ${members.length} builds of ${family}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFamily(family);
                          }}
                        >
                          <span>{members.length}</span>
                          <span className="searchable-select-arrow">▼</span>
                        </button>
                      )}
                    </div>
                    {isOpen && !single && members.map((m) => (
                      renderOption(m.option, 'searchable-select-option--member')
                    ))}
                  </div>
                );
              })
            ) : (
              filteredOptions.map((opt) => renderOption(opt))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export { SearchableSelect };
