import React from 'react';

/* Initials are white, so every fill must clear 4.5:1 against white. The chart/accent
   palette does not: #00B532 is 2.74:1, #FF9A15 2.12:1, #FF4D7E 3.17:1, #66B1AE 2.45:1.
   These are the same seven hues taken down to the text-safe step —
   4.88 / 5.02 / 7.09 / 4.80 / 5.01 / 5.63 / 5.45:1. */
const ACCENTS = [
  'var(--bs-primary, #0079a8)',
  // Theme-stable fills: --pill-success-fg / --pill-warning-fg are recut to light
  // text tones in the dark theme, which would drop white initials below 4.5:1.
  // Pin them to their default text-safe steps, like the two literals below.
  '#15803d',
  '#92400e',
  'var(--bs-purple, #9f44e0)',
  'var(--bs-info, #0a7a90)',
  '#c02a5c',
  '#38736f',
];

/* Presence dots are non-text marks: the fills only need 3:1 against the ring that
   separates them from the photo or initials, which the card or header ring provides. */
const PRESENCE = {
  online: { fill: 'var(--bs-success, #00b532)', label: 'Online' },
  away: { fill: 'var(--bs-warning, #ff9a15)', label: 'Away' },
  busy: { fill: 'var(--bs-danger, #d83506)', label: 'Busy' },
  offline: { fill: 'var(--bs-gray-600, #6c757d)', label: 'Offline' },
  /* Assistant states (the Illume mark): ready on the success ink step, working in warning. */
  ready: { fill: 'var(--pill-success-fg, #15803d)', label: 'Ready' },
  working: { fill: 'var(--bs-warning, #ff9a15)', label: 'Working' },
};

/**
 * ArkCase Avatar — circular user marker. Renders a photo if `src` is given,
 * otherwise initials on a deterministic brand-accent background. `status`
 * adds a presence dot (named in the accessible name); `ring` draws a 2px ring
 * so overlapped avatars read on any surface.
 *
 * `icon` is the non-person mark (the Illume assistant): a `bi-*` glyph in `text-secondary` on
 * a `surface-tertiary` tile with a hairline border and a 4px radius (`shape` can make it a
 * circle). Its status dot sits at the top-right corner, 3px out, with a 1px card-coloured
 * border — `ready` and `working` are the assistant's states. Named by `name` (role="img"),
 * or decorative when `name` is empty.
 */
export function Avatar({ src, name = '', initials, icon, shape, size = 36, color, status, statusLabel, ring, style, ...rest }) {
  if (icon && !src) return <IconMark {...{ icon, name, shape, size, status, statusLabel, ring, style, rest }} />;
  const text = initials || deriveInitials(name);
  const bg = color || ACCENTS[hash(name || text) % ACCENTS.length];
  const presence = status ? PRESENCE[status] : null;
  const accessibleName = presence ? [name, statusLabel || presence.label].filter(Boolean).join(', ') : name;
  const ringShadow = ring ? { boxShadow: `0 0 0 2px ${ring}` } : null;
  const common = {
    width: size, height: size, borderRadius: '50%',
    flex: '0 0 auto', objectFit: 'cover', display: 'inline-flex',
    ...(presence ? null : ringShadow),
    ...(presence ? null : style),
  };
  const outer = presence ? null : rest;
  const marker = src
    ? <img src={src} alt={accessibleName} style={common} {...outer} />
    : (
      <span
        aria-label={accessibleName}
        style={{
          ...common,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: bg,
          color: 'var(--text-on-primary, #ffffff)',
          fontWeight: 500,
          fontSize: size * 0.4,
          lineHeight: 1,
          userSelect: 'none',
        }}
        {...outer}
      >
        {text}
      </span>
    );
  if (!presence) return marker;
  const dot = Math.max(8, Math.round(size * 0.3));
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', flex: '0 0 auto', borderRadius: '50%', ...ringShadow, ...style }}
      {...rest}
    >
      {marker}
      <span
        aria-hidden="true"
        data-avatar-status={status}
        style={{
          position: 'absolute', right: -1, bottom: -1, width: dot, height: dot, borderRadius: '50%',
          backgroundColor: presence.fill,
          boxShadow: `0 0 0 2px ${ring || 'var(--surface-card, #fff)'}`,
        }}
      />
    </span>
  );
}

function IconMark({ icon, name, shape = 'square', size, status, statusLabel, ring, style, rest }) {
  const presence = status ? PRESENCE[status] : null;
  /* Unnamed, the mark is decorative — its state belongs to the visible text beside it. */
  const accessibleName = name ? [name, presence ? statusLabel || presence.label : ''].filter(Boolean).join(', ') : '';
  const dot = Math.max(8, Math.round(size * 0.35));
  return (
    <span
      role={accessibleName ? 'img' : undefined}
      aria-label={accessibleName || undefined}
      aria-hidden={accessibleName ? undefined : 'true'}
      data-avatar-icon=""
      style={{
        position: 'relative', width: size, height: size, flex: '0 0 auto', boxSizing: 'border-box',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--surface-tertiary, #e9ecef)', border: '1px solid var(--border-color, #dee2e6)',
        borderRadius: shape === 'circle' ? '50%' : 'var(--radius-sm, 4px)',
        ...(ring ? { boxShadow: `0 0 0 2px ${ring}` } : null),
        ...style,
      }}
      {...rest}
    >
      <i className={`bi ${icon}`} aria-hidden="true" style={{ color: 'var(--text-secondary, #5a6268)', fontSize: size <= 28 ? 'var(--icon-sm, 14px)' : Math.round(size * 0.5) }} />
      {presence && (
        <span
          aria-hidden="true"
          data-avatar-status={status}
          style={{
            position: 'absolute', top: -3, right: -3, width: dot, height: dot, borderRadius: '50%', boxSizing: 'border-box',
            border: `1px solid ${ring || 'var(--surface-card, #fff)'}`, background: presence.fill,
          }}
        />
      )}
    </span>
  );
}

function deriveInitials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
