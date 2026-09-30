import React from 'react';

/** A non-interactive keyboard hint. Shortcut handling belongs to the host. */
export function ShortcutKey({ children, label, style, ...rest }) {
  return <kbd aria-label={label} style={{
    display: 'inline-flex', alignItems: 'center', gap: 'var(--space-input-padding-y, 6px)',
    flexShrink: 0, whiteSpace: 'nowrap', fontFamily: 'var(--font-data, monospace)',
    fontSize: 'var(--font-size-xs, 12px)', fontWeight: 'var(--bs-font-weight-normal, 400)',
    color: 'var(--text-data, #495057)', background: 'var(--surface-tertiary, #e9ecef)',
    borderRadius: 'var(--radius-sm, 4px)', padding: 'calc(var(--space-1, 4px) / 4) var(--space-input-padding-y, 6px)',
    ...style,
  }} {...rest}>{children}</kbd>;
}
