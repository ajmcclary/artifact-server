import React from 'react';
import { toneTokens } from '../utilities/tones.jsx';

/* The five pill tints a mark can take; the bg/fg pairs come from the tone registry. */
const MARK_TONES = ['success', 'primary', 'warning', 'danger', 'neutral'];

/**
 * ArkCase StatusMark — the round tinted icon that heads an outcome card
 * ("Signed in", "Link sent", "Access revoked"). A pill tint ground with the
 * matching pill foreground as a tonal glyph. It restates the heading beside
 * it, so it is decorative unless given a `label`.
 */
export function StatusMark({ icon, tone = 'primary', size = 44, label, style, ...rest }) {
  /* Resolve the fallback here: the registry's own unknown-tone fallback is neutral, a mark's is primary. */
  const t = toneTokens(MARK_TONES.includes(tone) ? tone : 'primary');
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : 'true'}
      data-icon-tone="current"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        width: size,
        height: size,
        borderRadius: '50%',
        background: t.pillBg,
        color: t.pillFg,
        ...style,
      }}
      {...rest}
    >
      <i aria-hidden="true" className={`bi ${icon}`} style={{ fontSize: Math.round(size * 0.47) }} />
    </span>
  );
}
