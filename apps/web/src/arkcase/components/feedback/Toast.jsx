import { akStyleDocument } from '@/arkcase-style';
import React from 'react';

/* The tones, read through the pill foregrounds so a toast and a status pill of one tone
   can never drift apart. `primary` is Alert's primary; `info` keeps the primary-blue
   treatment it has always drawn here. */
const TONES = {
  primary: { fg: 'var(--pill-primary-fg, #0369a1)', tint: 'var(--pill-primary-bg, #e0f2fe)', accent: 'var(--bs-primary, #0079a8)', icon: 'bi-info-circle-fill' },
  info:    { fg: 'var(--pill-primary-fg, #0369a1)', tint: 'var(--pill-primary-bg, #e0f2fe)', accent: 'var(--bs-primary, #0079a8)', icon: 'bi-info-circle-fill' },
  success: { fg: 'var(--pill-success-fg, #15803d)', tint: 'var(--pill-success-bg, #dcfce7)', accent: 'var(--bs-success, #00b532)', icon: 'bi-check-circle-fill' },
  warning: { fg: 'var(--pill-warning-fg, #92400e)', tint: 'var(--pill-warning-bg, #fef3c7)', accent: 'var(--bs-warning, #ff9a15)', icon: 'bi-exclamation-triangle-fill' },
  danger:  { fg: 'var(--pill-danger-fg, #991b1b)',  tint: 'var(--pill-danger-bg, #fee2e2)',  accent: 'var(--bs-danger, #d83506)',  icon: 'bi-exclamation-octagon-fill' },
};

/* Enter and exit motion lives in a sheet, not inline, so reduced motion can switch it off.
   Short and restrained: 190ms in from the edge the toast sits on, 180ms out. */
function ensureToastKeyframes() {
  if (typeof document === 'undefined' || akStyleDocument.getElementById('ak-toast-kf')) return;
  const s = akStyleDocument.createElement('style');
  s.id = 'ak-toast-kf';
  s.textContent =
    '@keyframes ak-toast-in{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}' +
    '@keyframes ak-toast-in-top{from{opacity:0;transform:translateY(-14px)}to{opacity:1;transform:translateY(0)}}' +
    '@keyframes ak-toast-out{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(10px)}}' +
    '@keyframes ak-toast-out-top{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(-10px)}}' +
    '[data-ak-toast-motion="in"]{animation:ak-toast-in .19s cubic-bezier(.2,.75,.3,1) both}' +
    '[data-ak-toast-motion="in"][data-ak-toast-edge="top"]{animation-name:ak-toast-in-top}' +
    '[data-ak-toast-motion="out"]{animation:ak-toast-out .18s ease both}' +
    '[data-ak-toast-motion="out"][data-ak-toast-edge="top"]{animation-name:ak-toast-out-top}' +
    '@media (prefers-reduced-motion:reduce){[data-ak-toast-motion]{animation:none}}';
  akStyleDocument.head.appendChild(s);
}

/* The outlined follow-up verb a snackbar carries beside its text. */
function TrailingAction({ label, onClick }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 'none', alignSelf: 'center',
        background: hover ? 'var(--tint-primary-selected, rgba(0,121,168,.10))' : 'transparent',
        border: `1px solid ${hover ? 'var(--bs-primary, #0079a8)' : 'var(--bs-gray-500, #adb5bd)'}`,
        borderRadius: 'var(--radius-md, 5px)', padding: '6px 12px',
        font: 'inherit', fontSize: 'var(--font-size-dense, 13px)', fontWeight: 600,
        color: hover ? 'var(--text-link-on-tint, #00688f)' : 'var(--text-link, #0079a8)', cursor: 'pointer', whiteSpace: 'nowrap',
        transition: 'background .15s ease, border-color .15s ease, color .15s ease',
      }}
    >
      {label}
    </button>
  );
}

/* The dismiss control. The card keeps its 16px footprint but the hit area is 24px (the
   negative margin absorbs the difference); the snackbar's is a 34px round target. */
function DismissButton({ label, onClick, snackbar }) {
  const [hover, setHover] = React.useState(false);
  const size = snackbar ? 34 : 24;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={snackbar ? label : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 'none', alignSelf: snackbar ? 'center' : undefined,
        width: size, height: size, margin: snackbar ? 0 : -4, padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: snackbar && hover ? 'var(--tint-primary-selected, rgba(0,121,168,.10))' : 'transparent',
        border: 'none', borderRadius: 'var(--radius-circle, 50%)', cursor: 'pointer', lineHeight: 1,
        color: snackbar && hover ? 'var(--text-body, #212529)' : 'var(--text-secondary, #5a6268)',
        transition: snackbar ? 'background .15s ease, color .15s ease' : undefined,
      }}
    >
      <i className="bi bi-x-lg" aria-hidden="true" style={{ fontSize: snackbar ? 'var(--icon-sm, 14px)' : 12 }} />
    </button>
  );
}

/**
 * ArkCase Toast — the transient confirmation the applications raise after a write.
 * One at a time, dismissible, and repeats collapse into a count rather than stacking.
 * Distinct from Alert, which stays on the page. `layout="snackbar"` is the fluid row a
 * ToastRegion floats at the viewport edge: the follow-up verb trails the text as an
 * outlined button and the dismiss control is a 34px round target.
 */
export function Toast({
  variant = 'info', title, children, count = 1, actionLabel, onAction, onClose, icon, live,
  dismissLabel = 'Dismiss', layout = 'card', actionPlacement, animated = false, leaving = false,
  edge = 'bottom', style, ...rest
}) {
  const t = TONES[variant] || TONES.info;
  const snackbar = layout === 'snackbar';
  const trailing = (actionPlacement || (snackbar ? 'trailing' : 'below')) === 'trailing';
  const moving = animated || leaving;
  React.useEffect(() => { if (moving) ensureToastKeyframes(); }, [moving]);
  // An explicit `live` wins; otherwise danger and warning are urgent. A toast inside a
  // region that announces for it passes live="off" so nothing is read twice.
  const urgent = live ? live === 'assertive' : variant === 'danger' || variant === 'warning';
  const role = live === 'off' ? undefined : urgent ? 'alert' : 'status';
  const ariaLive = live === 'off' ? undefined : urgent ? 'assertive' : 'polite';
  const hasAction = !!(actionLabel && onAction);
  return (
    <div
      role={role}
      aria-live={ariaLive}
      aria-atomic={role ? 'true' : undefined}
      data-ak-toast-motion={leaving ? 'out' : animated ? 'in' : undefined}
      data-ak-toast-edge={moving && edge === 'top' ? 'top' : undefined}
      style={{
        position: 'relative', display: 'flex', alignItems: 'flex-start', gap: snackbar ? 12 : 10,
        ...(snackbar
          ? { width: 'auto', minWidth: 'min(300px, 100%)', maxWidth: 'min(560px, 100%)', padding: '12px 12px 12px 20px', border: '1px solid var(--border-color-strong, #ced4da)', boxShadow: 'var(--shadow-lg, 0 4px 8px rgba(0,0,0,.06), 0 12px 32px rgba(0,0,0,.14))' }
          : { width: 360, maxWidth: '92vw', padding: '12px 14px 12px 18px', border: '1px solid var(--border-color, #dee2e6)', boxShadow: 'var(--shadow-md, 0 2px 4px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.10))' }),
        boxSizing: snackbar ? 'border-box' : undefined,
        background: 'var(--surface-card, #fff)',
        borderRadius: 'var(--radius-md, 5px)',
        overflow: 'hidden',
        ...style,
      }}
      {...rest}
    >
      <span aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 'var(--border-width-accent, 4px)', background: t.accent }} />
      <span aria-hidden="true" style={{ flex: 'none', alignSelf: 'center', width: 28, height: 28, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: t.tint }}>
        <i className={`bi ${icon || t.icon}`} style={{ fontSize: 'var(--icon-sm, 14px)', lineHeight: 1, color: t.fg }} />
      </span>
      <div style={{ flex: snackbar ? '1 1 auto' : 1, minWidth: 0, display: snackbar ? 'flex' : undefined, flexDirection: snackbar ? 'column' : undefined, gap: snackbar ? 2 : undefined }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: snackbar ? 8 : 6, flexWrap: snackbar ? 'wrap' : undefined }}>
          {title && <span style={{ fontSize: 'var(--font-size-sm, 14px)', fontWeight: 600, letterSpacing: 'var(--letter-spacing-wide, 0.025em)', color: t.fg }}>{title}</span>}
          {count > 1 && (
            <span
              style={snackbar
                ? { fontFamily: 'var(--font-data)', fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)', fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, lineHeight: 1, padding: '4px 6px', borderRadius: 'var(--radius-pill, 10px)', color: 'var(--text-secondary, #5a6268)', background: 'var(--surface-tertiary, #e9ecef)', border: '1px solid var(--border-color, #dee2e6)' }
                : { fontFamily: 'var(--font-data)', fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)', fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, color: 'var(--text-secondary, #5a6268)', border: '1px solid var(--border-color, #dee2e6)', borderRadius: 'var(--radius-sm, 4px)', padding: '0 5px' }}
            >
              {`×${count}`}
            </span>
          )}
        </div>
        {children && (
          <div style={snackbar
            ? { fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.5, color: 'var(--text-body, #212529)', textWrap: 'pretty', overflowWrap: 'anywhere' }
            : { marginTop: title ? 2 : 0, fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.5, color: 'var(--text-data, #495057)' }}
          >
            {children}
          </div>
        )}
        {hasAction && !trailing && (
          <button type="button" onClick={onAction} style={{ marginTop: 6, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 'var(--font-size-dense, 13px)', fontWeight: 600, color: 'var(--text-link, #0079a8)' }}>{actionLabel}</button>
        )}
      </div>
      {hasAction && trailing && <TrailingAction label={actionLabel} onClick={onAction} />}
      {onClose && <DismissButton label={dismissLabel} onClick={onClose} snackbar={snackbar} />}
    </div>
  );
}
