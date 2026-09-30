import React from 'react';
import { VisuallyHidden } from '../utilities/VisuallyHidden.jsx';

const TONES = {
  primary: {
    background: 'var(--tint-primary-selected, rgba(0, 121, 168, 0.10))',
    color: 'var(--text-link-on-tint, #00688f)',
    fontWeight: 'var(--bs-font-weight-semibold, 600)',
  },
  neutral: {
    background: 'var(--surface-canvas, #f1f5f7)',
    color: 'var(--text-data, #495057)',
    fontWeight: 'var(--bs-font-weight-normal, 400)',
  },
};

/**
 * ArkCase CountBadge — the small tinted count that trails a rail tab, a panel
 * title or a list row ("3", "12 unresolved"). `primary` is the 10% primary
 * tint with on-tint link ink for counts that ask for attention; `neutral` is
 * the canvas tint with data ink for plain totals. With a `label`, the visible
 * count is hidden from assistive technology and the label is spoken instead.
 */
export function CountBadge({ count, tone = 'neutral', label, mono = true, style, ...rest }) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        minWidth: 16,
        boxSizing: 'border-box',
        padding: '0 6px',
        borderRadius: 'var(--radius-pill, 10px)',
        background: t.background,
        color: t.color,
        fontWeight: t.fontWeight,
        fontFamily: mono
          ? 'var(--font-data, "Source Code Pro", ui-monospace, monospace)'
          : 'var(--font-body, "Public Sans", system-ui, sans-serif)',
        fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)',
        fontSize: 'var(--font-size-label, 11px)',
        lineHeight: '16px',
        whiteSpace: 'nowrap',
        ...style,
      }}
      {...rest}
    >
      {label ? (
        <>
          <span aria-hidden="true">{count}</span>
          <VisuallyHidden>{label}</VisuallyHidden>
        </>
      ) : count}
    </span>
  );
}
