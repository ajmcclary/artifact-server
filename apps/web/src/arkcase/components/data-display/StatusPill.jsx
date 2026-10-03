import React from 'react';
import { TONES, toneTokens } from '../utilities/tones.jsx';

const MAP = {
  active: 'success', closed: 'danger', archived: 'primary',
  inactive: 'secondary', pending: 'warning', critical: 'critical',
  success: 'success', danger: 'danger', warning: 'warning',
  primary: 'primary', secondary: 'secondary', neutral: 'neutral',
};
/* Every tone is the registry's --pill-*-bg / --pill-*-fg pair (utilities/tones.jsx), so a pill
   can never drift from the Alert, Toast, GroupBand or StateRow of the same tone. Critical is the
   one solid fill in the system. Text-on-tint ratios at 11px/600:
   success 4.57 · warning 6.37 · danger 6.80 · primary 5.17 · secondary 7.39 · neutral 7.00 ·
   critical (white on the solid fill) 4.74 — all clear AA. */

/* Size steps. `md` is the application pill and the default. `xs` is the worksheet-cell pill of
   the Excel specimens (their 9px, raised to the 10px copy floor); `slide` is the same pill at
   slide scale — 14pt authored at pt×4/3 px on a 1280×720 slide (PowerPoint Templates `.mark`).
   Both are specimen geometry, so their px values stay literal here. */
const SIZES = {
  xs: { padding: '1px 7px', borderRadius: 9, fontSize: 10, lineHeight: 1.35, letterSpacing: '0.05em', gap: 3, icon: 10 },
  md: { padding: '2px 8px', borderRadius: 'var(--radius-pill, 10px)', fontSize: 'var(--font-size-label, 11px)', lineHeight: 1.45, letterSpacing: '0.02em', gap: 4, icon: 12 },
  slide: { padding: '5px 15px', borderRadius: 16, fontSize: 18.6667, lineHeight: 1.15, letterSpacing: '0.06em', gap: 6, icon: 18.6667 },
};

/**
 * ArkCase StatusPill — THE pill. One geometry for every status, priority,
 * category and type chip in the system: 11px/600 uppercase, 2px 8px, radius 10px,
 * soft tint (pale background + saturated text). Solid fill is reserved for
 * Critical (`tone="critical"`). No radius-4px chips, no 500-weight variants.
 */
export function StatusPill({ status, tone, label, icon, computed = false, size = 'md', wrap = false, style, ...rest }) {
  const z = SIZES[size] || SIZES.md;
  const key = tone || MAP[String(status || '').toLowerCase()];
  /* Resolve the fallback here: the registry's own unknown-tone fallback is neutral, a pill's is secondary. */
  const t = toneTokens(TONES.includes(key) ? key : 'secondary');
  const text = label != null ? label : capitalize(String(status || ''));
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: z.gap,
        padding: z.padding,
        borderRadius: z.borderRadius,
        fontSize: z.fontSize,
        fontWeight: 600,
        lineHeight: z.lineHeight,
        textTransform: 'uppercase',
        letterSpacing: z.letterSpacing,
        backgroundColor: t.pillBg,
        color: t.pillFg,
        whiteSpace: wrap ? 'normal' : 'nowrap',
        ...(wrap ? { alignSelf: 'flex-start', overflowWrap: 'anywhere' } : null),
        ...(computed ? { outline: '1px dashed currentColor', outlineOffset: -1 } : null),
        ...style,
      }}
      {...rest}
    >
      {icon && <i className={`bi ${icon}`} aria-hidden="true" data-icon-tone="current" style={{ fontSize: z.icon, lineHeight: 1, flex: '0 0 auto' }} />}
      {text}
    </span>
  );
}

function capitalize(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
