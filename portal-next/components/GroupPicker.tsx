'use client';

import { useState } from 'react';

const defaultInputStyle: React.CSSProperties = {
  width: '100%',
  background: '#18181b',
  border: '1px solid #3f3f46',
  borderRadius: 6,
  color: '#d4d4d8',
  fontSize: '0.8125rem',
  padding: '7px 10px',
  outline: 'none',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
};

interface GroupPickerProps {
  value: string;
  onChange: (name: string) => void;
  options: string[];
  placeholder?: string;
  style?: React.CSSProperties;
  /** Minimum typed characters before showing matches (default 1). Search variant only. */
  minSearchChars?: number;
  /** Combobox with search (default) or dropdown select from options only. */
  variant?: 'search' | 'select';
}

export function GroupPicker({ value, onChange, options, placeholder, style, minSearchChars = 1, variant = 'search' }: GroupPickerProps) {
  const [open, setOpen] = useState(false);
  const query = value.trim();
  const filtered = query.length >= minSearchChars
    ? options.filter(o => o.toLowerCase().includes(query.toLowerCase())).slice(0, 15)
    : [];

  if (variant === 'select') {
    const selectStyle: React.CSSProperties = {
      ...defaultInputStyle,
      cursor: options.length ? 'pointer' : 'not-allowed',
      ...(style ?? {}),
    };
    return (
      <select
        value={value}
        disabled={options.length === 0}
        onChange={e => onChange(e.target.value)}
        style={selectStyle}
      >
        <option value="">{placeholder ?? 'Select a group…'}</option>
        {options.map(name => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
    );
  }

  return (
    <div style={{
      position: 'relative',
      ...(style ? { flex: (style as React.CSSProperties & { flex?: string }).flex, width: style.width ?? '100%' } : { width: '100%' }),
    }}>
      <input
        style={style ?? defaultInputStyle}
        value={value}
        placeholder={placeholder ?? 'Type to search groups…'}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
          background: '#1c1c1e', border: '1px solid #3f3f46', borderRadius: 6,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)', maxHeight: 220, overflowY: 'auto', marginTop: 2,
        }}>
          {filtered.map(name => (
            <button key={name} type="button"
              style={{
                display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
                border: 'none', color: '#d4d4d8', fontSize: '0.8125rem', padding: '7px 12px',
                cursor: 'pointer', fontFamily: 'inherit',
              }}
              onMouseDown={e => { e.preventDefault(); onChange(name); setOpen(false); }}
              onMouseEnter={e => { e.currentTarget.style.background = '#27272a'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >{name}</button>
          ))}
        </div>
      )}
    </div>
  );
}
