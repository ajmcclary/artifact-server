import React from 'react';

const TONES = {
  default: 'var(--border-color, #dee2e6)',
  strong: 'var(--border-color-strong, #ced4da)',
  list: 'var(--list-divider, #e9ecef)',
};

/**
 * ArkCase Divider — a 1px hairline separating groups, optionally labelled
 * ("or" between two sign-in routes). The label is the uppercase 11px
 * micro-label in `text-secondary`, centred between two rules, and names the
 * separator for assistive technology. `tone` picks the default hairline, the
 * stronger input rule or the lighter list-row rule.
 */
export function Divider({ label, orientation = 'horizontal', tone = 'default', style, ...rest }) {
  const color = TONES[tone] || TONES.default;
  const vertical = orientation === 'vertical';
  const a11y = {
    role: 'separator',
    'aria-orientation': vertical ? 'vertical' : undefined,
    'aria-label': label || undefined,
  };
  if (vertical) {
    return (
      <div
        {...a11y}
        style={{ alignSelf: 'stretch', flex: 'none', width: 0, minHeight: '1em', borderLeft: `var(--border-width, 1px) solid ${color}`, ...style }}
        {...rest}
      />
    );
  }
  if (!label) {
    return (
      <div
        {...a11y}
        style={{ width: '100%', height: 0, borderTop: `var(--border-width, 1px) solid ${color}`, ...style }}
        {...rest}
      />
    );
  }
  const rule = { flex: '1 1 0', height: 1, background: color };
  return (
    <div
      {...a11y}
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2, 10px)', width: '100%', ...style }}
      {...rest}
    >
      <span aria-hidden="true" style={rule} />
      <span
        aria-hidden="true"
        style={{
          flex: 'none',
          fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
          fontSize: 'var(--font-size-label, 11px)',
          fontWeight: 'var(--bs-font-weight-semibold, 600)',
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: 'var(--text-secondary, #5a6268)',
        }}
      >
        {label}
      </span>
      <span aria-hidden="true" style={rule} />
    </div>
  );
}
