import React from 'react';

const SIZES = { label: 'var(--font-size-label, 11px)', xs: 'var(--font-size-xs, 12px)' };
const TONES = {
  secondary: 'var(--text-secondary, #5a6268)',
  navy: 'var(--text-navy, #073652)',
  'on-navy': 'var(--text-on-navy-secondary, rgba(255, 255, 255, 0.72))',
};
const HEADINGS = new Set(['h2', 'h3', 'h4', 'h5', 'h6', 'dt']);

/**
 * ArkCase Eyebrow — the uppercase micro-label that names a panel cap, a
 * section or a field group. Public Sans, 11px, semibold, wide tracking, in
 * `text-secondary` unless a tone says otherwise.
 */
export function Eyebrow({ as = 'span', size = 'label', tone = 'secondary', truncate = false, children, style, ...rest }) {
  const Tag = as;
  return (
    <Tag
      style={{
        display: truncate ? 'block' : undefined,
        margin: HEADINGS.has(as) ? 0 : undefined,
        fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
        fontSize: SIZES[size] || SIZES.label,
        fontWeight: 'var(--bs-font-weight-semibold, 600)',
        letterSpacing: 'var(--letter-spacing-wide, 0.025em)',
        textTransform: 'uppercase',
        color: TONES[tone] || TONES.secondary,
        ...(truncate ? { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : null),
        ...style,
      }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
