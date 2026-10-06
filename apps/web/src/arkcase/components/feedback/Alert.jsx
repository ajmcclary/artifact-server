import React from 'react';
import { Button } from '../actions/Button.jsx';

/* Foregrounds are the --pill-*-fg tokens, not hand-mixed darks: an alert and a status
   pill of the same tone now read the same dark, and the 2026 conformance pass retired
   the parallel ramp that grew here. */
const TONES = {
  primary:   { bg: 'var(--tint-primary-selected, rgba(0,121,168,0.10))',  border: 'var(--bs-primary, #0079a8)', fg: 'var(--pill-primary-fg, #0369a1)', icon: 'bi-info-circle-fill' },
  success:   { bg: 'rgba(0,181,50,0.10)',   border: 'var(--bs-success, #00b532)', fg: 'var(--pill-success-fg, #15803d)', icon: 'bi-check-circle-fill' },
  danger:    { bg: 'var(--tint-danger-selected, rgba(216,53,6,0.10))', border: 'var(--bs-danger, #d83506)', fg: 'var(--pill-danger-fg, #991b1b)', icon: 'bi-exclamation-octagon-fill' },
  warning:   { bg: 'rgba(255,154,21,0.12)', border: 'var(--bs-warning, #ff9a15)', fg: 'var(--pill-warning-fg, #92400e)', icon: 'bi-exclamation-triangle-fill' },
  info:      { bg: 'rgba(10,122,144,0.10)', border: 'var(--bs-info, #0a7a90)', fg: 'var(--text-info-on-tint, #005a7d)', icon: 'bi-info-circle-fill' },
  /* No status accent: the secondary surface and a hairline, body ink, and an ordinary
     duotone glyph (no tonal colour) — a note, not a state. */
  neutral:   { bg: 'var(--surface-secondary, #f8f9fa)', border: null, fg: 'var(--text-body, #212529)', icon: 'bi-info-circle' },
};

/* default is the message size; compact is the inline note a panel carries (13px, tighter). */
const ALERT_DENSITY = {
  default: { pad: '0.625rem 0.875rem', gap: '0.625rem', size: '0.9375rem', icon: '1.05rem', radius: 'var(--radius-md, 5px)' },
  compact: { pad: 'var(--space-2, 8px) var(--space-3, 12px)', gap: 'var(--space-2, 8px)', size: 'var(--font-size-dense, 13px)', icon: 'var(--icon-sm, 14px)', radius: 'var(--radius-sm, 4px)' },
};

/* A trailing action given as data: `{ label, onClick, variant, outline, icon, disabled }`. Its
   Button takes the alert's own tone unless it names one — a danger banner offers a danger
   verb — and the quiet note offers a secondary outline one. */
function alertActionNode(action, variant, i) {
  if (action == null || action === false) return null;
  if (React.isValidElement(action) || typeof action !== 'object' || typeof action.label === 'undefined') return action;
  const neutral = variant === 'neutral';
  const tone = action.variant || (neutral ? 'secondary' : variant);
  const outline = action.outline != null ? !!action.outline : neutral && !action.variant;
  return (
    <Button key={i} variant={tone} outline={outline} size="sm" icon={action.icon} disabled={!!action.disabled} onClick={action.onClick}>
      {action.label}
    </Button>
  );
}

/**
 * ArkCase Alert — inline contextual message. Tinted background, left accent
 * rule, leading status icon, optional dismiss. `variant="neutral"` is the quiet
 * note on the secondary surface with no status accent; `density="compact"` is the
 * 13px inline note a panel carries. A static note passes `live="off"`.
 * `layout="banner"` is the full-bleed strip under a page or pane header: square, no
 * accent rule, a bottom hairline in the tone's colour, the title run in before the text
 * and the actions pushed to the row's end.
 */
export function Alert({ variant = 'primary', density = 'default', title, children, icon, onClose, live, action, align: alignProp, layout = 'inline', style, ...rest }) {
  const t = TONES[variant] || TONES.primary;
  const d = ALERT_DENSITY[density] || ALERT_DENSITY.default;
  const neutral = !t.border;
  /* Compact glyphs sit at 14px on the tint, where the raw success and warning fills fall
     under 3:1; they take the tone's text-safe foreground instead, as the pill does. */
  const compact = density === 'compact';
  // WCAG 4.1.3 — status messages must reach assistive tech without moving
  // focus. Errors are urgent (assertive alert); everything else announces
  // politely as a status. `live` overrides the default when needed.
  const urgent = live ? live === 'assertive' : variant === 'danger';
  const role = live === 'off' ? undefined : urgent ? 'alert' : 'status';
  const ariaLive = live === 'off' ? 'off' : urgent ? 'assertive' : 'polite';
  const actions = Array.isArray(action)
    ? action.filter((a) => a != null && a !== false).map((a, i) => <React.Fragment key={i}>{alertActionNode(a, variant, i)}</React.Fragment>)
    : alertActionNode(action, variant, 0);
  const hasAction = Array.isArray(actions) ? actions.length > 0 : actions != null;
  const banner = layout === 'banner';
  /* A banner's message and its buttons share one row, so its glyph centres on that row by default. */
  const align = alignProp || (banner ? 'center' : 'start');
  const centred = align === 'center';
  /* Banner: the title runs in, bold, before the body so the whole message reads as one line. */
  const body = banner && title
    ? <>{<strong data-alert-title="" style={{ fontWeight: 600, color: neutral ? 'var(--text-body, #212529)' : undefined }}>{title}</strong>}{children != null ? ' ' : null}{children}</>
    : children;
  const shell = banner ? {
    padding: 'var(--space-2, 8px) var(--space-4, 16px)',
    border: 0,
    borderBottom: `1px solid ${t.border || 'var(--border-color, #dee2e6)'}`,
    borderRadius: 0,
  } : {
    padding: d.pad,
    border: neutral ? '1px solid var(--border-color, #dee2e6)' : '1px solid transparent',
    borderInlineStart: neutral ? undefined : `4px solid ${t.border}`,
    borderRadius: d.radius,
  };
  return (
    <div
      role={role}
      aria-live={ariaLive}
      aria-atomic="true"
      style={{
        display: 'flex', gap: d.gap, alignItems: centred ? 'center' : 'flex-start',
        ...shell,
        backgroundColor: t.bg,
        color: t.fg,
        ...style,
      }}
      data-density={density === 'compact' ? 'compact' : undefined}
      data-layout={banner ? 'banner' : undefined}
      {...rest}
    >
      <i className={`bi ${icon || t.icon}`} aria-hidden="true" style={{ fontSize: d.icon, lineHeight: 1.4, color: neutral ? undefined : compact ? t.fg : t.border }} />
      <div style={{ flex: 1, minWidth: 0, fontSize: d.size, lineHeight: 1.45, color: neutral ? 'var(--text-secondary, #5a6268)' : undefined }}>
        {title && !banner && <div style={{ fontWeight: 600, marginBottom: children || hasAction ? '0.15rem' : 0, color: neutral ? 'var(--text-body, #212529)' : undefined }}>{title}</div>}
        {hasAction ? (
          /* The body and its verbs share one row, the verbs centred against the text and
             wrapping under it when the column is narrow. */
          <div data-alert-action-row="" style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px', minWidth: 0, textWrap: 'pretty' }}>{body}</div>
            <div data-alert-actions="" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, marginInlineStart: banner ? 'auto' : undefined }}>{actions}</div>
          </div>
        ) : body}
      </div>
      {onClose && (
        <button onClick={onClose} aria-label="Dismiss" style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 'var(--icon-sm, 0.875rem)', opacity: 0.7, padding: 0, lineHeight: 1 }}>
          <i className="bi bi-x-lg" />
        </button>
      )}
    </div>
  );
}
