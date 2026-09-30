import React from 'react';

const TONES = {
  success: { bg: 'var(--pill-success-bg, #dcfce7)', fg: 'var(--pill-success-fg, #15803d)' },
  primary: { bg: 'var(--pill-primary-bg, #e0f2fe)', fg: 'var(--pill-primary-fg, #0369a1)' },
  warning: { bg: 'var(--pill-warning-bg, #fef3c7)', fg: 'var(--pill-warning-fg, #92400e)' },
  danger: { bg: 'var(--pill-danger-bg, #fee2e2)', fg: 'var(--pill-danger-fg, #991b1b)' },
  neutral: { bg: 'var(--pill-neutral-bg, #e9ecef)', fg: 'var(--pill-neutral-fg, #495057)' },
};

/**
 * ArkCase StatusMark — the round tinted icon that heads an outcome card
 * ("Signed in", "Link sent", "Access revoked"). A pill tint ground with the
 * matching pill foreground as a tonal glyph. It restates the heading beside
 * it, so it is decorative unless given a `label`.
 */
export function StatusMark({ icon, tone = 'primary', size = 44, label, style, ...rest }) {
  const t = TONES[tone] || TONES.primary;
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
        background: t.bg,
        color: t.fg,
        ...style,
      }}
      {...rest}
    >
      <i aria-hidden="true" className={`bi ${icon}`} style={{ fontSize: Math.round(size * 0.47) }} />
    </span>
  );
}
