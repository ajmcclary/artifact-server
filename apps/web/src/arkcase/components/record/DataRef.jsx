import React from 'react';

/**
 * ArkCase DataRef — a coded value inline in prose. 'plain' is the data role
 * itself; 'strong' is the record's own identifier; 'route' is the pale pill a
 * screen wears to name the URL it is; 'absent' is a value the record does not
 * carry, drawn in italic sans so it can never be mistaken for one that does.
 */
export function DataRef({ variant = 'plain', children, style, ...rest }) {
  if (variant === 'absent') {
    return (
      <span style={{ fontStyle: 'italic', fontFamily: 'var(--font-sans, "Public Sans", system-ui, sans-serif)', fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5a6268)', ...style }} {...rest}>
        {children || 'not recorded by this run'}
      </span>
    );
  }
  const base = { fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)', fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)' };
  const skins = {
    plain: { fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-data, #495057)' },
    strong: { fontSize: 'var(--font-size-dense, 13px)', fontWeight: 600, color: 'var(--text-navy, #073652)' },
    route: { fontSize: 'var(--font-size-label, 11px)', color: 'var(--text-link-hover, #005a7d)', background: 'var(--tint-primary-selected, rgba(0,121,168,.10))', padding: '2px 8px', borderRadius: 'var(--radius-pill, 10px)', whiteSpace: 'nowrap' },
  };
  return <span style={{ ...base, ...(skins[variant] || skins.plain), ...style }} {...rest}>{children}</span>;
}
