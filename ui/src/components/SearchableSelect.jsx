// Llama Manager — searchable select control.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Provides the reusable searchable model and option picker used throughout the
// management interface.

import React, { useState, useEffect, useRef } from 'react';

// Searchable select component for model dropdowns
function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  disabled = false,
  storageKey = null,
  formatOption = (opt) => opt.label || opt.id || opt.value || opt
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  // Load from localStorage on mount if storageKey provided
  useEffect(() => {
    if (storageKey && !value) {
      const saved = localStorage.getItem(storageKey);
      if (saved && options.some(opt => (opt.value || opt.id || opt) === saved)) {
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
    const val = (opt.value || opt.id || opt).toString().toLowerCase();
    const searchLower = search.toLowerCase();
    return label.includes(searchLower) || val.includes(searchLower);
  });

  // Get display value
  const selectedOption = options.find(opt => (opt.value || opt.id || opt) === value);
  const displayValue = selectedOption ? formatOption(selectedOption) : placeholder;

  const handleSelect = (opt) => {
    const val = opt.value || opt.id || opt;
    onChange(val);
    setIsOpen(false);
    setSearch('');
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
            ) : (
              filteredOptions.map((opt, idx) => {
                const val = opt.value || opt.id || opt;
                const label = formatOption(opt);
                return (
                  <div
                    key={val || idx}
                    className={`searchable-select-option ${val === value ? 'selected' : ''}`}
                    onClick={() => handleSelect(opt)}
                    title={label}
                  >
                    {label}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export { SearchableSelect };
