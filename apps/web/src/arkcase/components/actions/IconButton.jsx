import React from 'react';

/**
 * ArkCase IconButton — square/circular icon-only control.
 * Used for the app-bar hamburger, theme toggle, side-nav close, row actions.
 * `badge` overlays a small corner count (an unread bell) in the data face; its
 * meaning joins the accessible name through `badgeLabel`.
 */
export function IconButton({
  icon,
  variant = 'ghost',
  size = 'md',
  shape = 'square',
  ariaLabel,
  disabled = false,
  pressed,
  expanded,
  hasPopup,
  title,
  keyshortcuts,
  count,
  countLabel,
  badge,
  badgeLabel,
  badgeTone = 'critical',
  onClick,
  style,
  ...rest
}) {
  // xs (24px, the --space-5 step) is the dense toolbar size; sm/md/lg are unchanged.
  const dims = { xs: 24, sm: 30, md: 38, lg: 46 };
  const fonts = { xs: 14, sm: 16, md: 18, lg: 22 };
  const d = dims[size] || dims.md;

  const variants = {
    navy:    { bg: 'transparent', fg: 'var(--text-on-navy, #ffffff)', hoverBg: 'var(--surface-navy-strong, #052a40)', activeBg: 'var(--surface-navy-strong, #052a40)', hoverFg: 'var(--text-on-navy, #ffffff)' },
    dark:    { bg: 'transparent', fg: 'var(--text-on-navy, #ffffff)', hoverBg: 'var(--bs-gray-700, #495057)', activeBg: 'var(--bs-gray-700, #495057)', hoverFg: 'var(--text-on-navy, #ffffff)' },
    ghost:   { bg: 'transparent', fg: 'var(--text-emphasis, #374151)', hoverBg: 'var(--tint-primary-hover, rgba(0,121,168,0.05))', activeBg: 'var(--tint-primary-selected, rgba(0,121,168,0.10))', hoverFg: 'var(--bs-primary, #0079a8)' },
    primary: { bg: 'var(--bs-primary, #0079a8)', fg: 'var(--text-on-primary, #ffffff)', hoverBg: 'var(--bs-primary-hover, #00668f)', activeBg: 'var(--bs-primary-hover, #00668f)', hoverFg: 'var(--bs-white, #ffffff)', inset: true },
    light:   { bg: 'var(--surface-canvas, #f1f5f7)', fg: 'var(--text-emphasis, #374151)', hoverBg: 'var(--surface-tertiary, #e9ecef)', activeBg: 'var(--border-color-strong, #ced4da)', hoverFg: 'var(--text-body, #212529)' },
    danger:  { bg: 'transparent', fg: 'var(--bs-danger, #d83506)', hoverBg: 'var(--tint-danger-hover, rgba(216,53,6,0.05))', activeBg: 'var(--tint-danger-selected, rgba(216,53,6,0.10))', hoverFg: 'var(--bs-danger, #d83506)' },
  };
  const v = variants[variant] || variants.ghost;
  // A true toggle (pressed) or an open popup trigger (expanded) rests on the
  // variant's selected fill; ghost also steps its ink to the on-tint link tone.
  const selectedFills = {
    ghost: { bg: 'var(--tint-primary-selected, rgba(0,121,168,0.10))', fg: 'var(--text-link-on-tint, #00688f)' },
    navy: { bg: 'var(--surface-navy-strong, #052a40)', fg: v.fg },
    dark: { bg: 'var(--bs-gray-700, #495057)', fg: v.fg },
    light: { bg: 'var(--border-color-strong, #ced4da)', fg: 'var(--text-body, #212529)' },
  };
  const sel = selectedFills[variant] || (variants[variant] ? { bg: v.activeBg, fg: v.fg } : selectedFills.ghost);
  const selected = pressed === true || expanded === true;
  const hasCount = count != null && count !== false && count !== '';
  const [hover, setHover] = React.useState(false);
  const [active, setActive] = React.useState(false);
  const [focusVisible, setFocusVisible] = React.useState(false);

  // WCAG 4.1.2 — an icon-only control MUST expose an accessible name.
  // Prefer an explicit ariaLabel; otherwise derive a readable fallback
  // from the icon class (e.g. "bi-three-dots" -> "Three dots") so the
  // button is never silent to assistive tech.
  const derived = String(icon || '')
    .replace(/^bi-/, '')
    .replace(/-fill$|-lg$/g, '')
    .replace(/-/g, ' ')
    .trim();
  const explicitLabel = ariaLabel || rest['aria-label'];
  const label = explicitLabel || (derived ? derived.charAt(0).toUpperCase() + derived.slice(1) : 'Button');
  if (!explicitLabel && typeof console !== 'undefined') {
    console.warn(`IconButton: no ariaLabel for icon "${icon}" — using fallback "${label}". Pass ariaLabel for a precise, action-oriented name.`);
  }

  // hover = 5% tint rung, press deepens to the 10% rung (matches grid/nav);
  // solid variants take the inset-active dent instead. Focus paints the ring.
  const bg = disabled ? (selected ? sel.bg : v.bg) : active ? v.activeBg : selected ? sel.bg : hover ? v.hoverBg : v.bg;
  const fg = selected ? sel.fg : (hover || active) && !disabled ? v.hoverFg : v.fg;
  // A countLabel joins the accessible name ("Comments, 3 open threads"); the
  // visible count itself is decorative once the name carries it.
  const hasBadge = badge != null && badge !== false && badge !== '' && badge !== 0;
  const name = [label, countLabel, hasBadge ? badgeLabel : null].filter(Boolean).join(', ');
  const badgeFills = {
    critical: { bg: 'var(--pill-critical-bg, #d83506)', fg: 'var(--pill-critical-fg, #ffffff)' },
    primary: { bg: 'var(--bs-primary, #0079a8)', fg: 'var(--text-on-primary, #ffffff)' },
    neutral: { bg: 'var(--pill-neutral-bg, #e9ecef)', fg: 'var(--pill-neutral-fg, #495057)' },
  };
  const bf = badgeFills[badgeTone] || badgeFills.critical;
  const boxShadow = active && !disabled && v.inset
    ? 'var(--shadow-inset-active, inset 0 2px 3px rgba(0,0,0,.10))'
    : focusVisible && !disabled
    ? 'var(--focus-ring, 0 0 0 0.25rem rgba(0,121,168,0.25))'
    : 'none';

  return (
    <button
      type="button"
      aria-label={name}
      title={title != null ? title : label}
      aria-pressed={pressed === undefined ? undefined : !!pressed}
      aria-expanded={expanded === undefined ? undefined : !!expanded}
      aria-haspopup={hasPopup === undefined || hasPopup === false ? undefined : hasPopup}
      aria-keyshortcuts={keyshortcuts}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      onFocus={(e) => { try { setFocusVisible(e.target.matches(':focus-visible')); } catch (_) { setFocusVisible(true); } }}
      onBlur={() => setFocusVisible(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: hasCount ? 'auto' : d,
        minWidth: hasCount ? d : undefined,
        height: d,
        padding: hasCount ? (size === 'xs' ? '0 var(--space-1, 4px)' : '0 var(--space-2, 8px)') : 0,
        gap: hasCount ? 'var(--space-1, 4px)' : undefined,
        border: 'none',
        borderRadius: shape === 'circle' ? '50%' : 'var(--radius-md, 6px)',
        ...(style?.background != null ? {} : { backgroundColor: bg }),
        color: fg,
        fontSize: fonts[size] || 18,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.65 : 1,
        boxShadow,
        transition: 'background-color .15s ease, color .15s ease, box-shadow .15s ease',
        ...(hasBadge ? { position: 'relative' } : null),
        ...style,
      }}
      // Solid and danger glyphs follow the control's ink; ghost and light keep Studio colours.
      data-icon-tone={variant === 'primary' || variant === 'danger' || variant === 'navy' || variant === 'dark' ? 'current' : undefined}
      {...rest}
    >
      <i className={`bi ${icon}`} aria-hidden="true" />
      {hasCount && (
        <span aria-hidden="true" data-icon-button-count="" style={{
          fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)',
          fontSize: 'var(--font-size-label, 11px)',
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
        }}>{count}</span>
      )}
      {hasBadge && (
        <span aria-hidden="true" data-icon-button-badge="" style={{
          position: 'absolute',
          top: size === 'xs' ? -4 : 2,
          right: size === 'xs' ? -4 : 0,
          minWidth: 16,
          boxSizing: 'border-box',
          padding: '1px 5px',
          borderRadius: 'var(--radius-pill, 10px)',
          background: bf.bg,
          color: bf.fg,
          fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)',
          fontVariantNumeric: 'tabular-nums',
          fontSize: 'var(--font-size-label, 11px)',
          fontWeight: 600,
          lineHeight: 1.3,
          textAlign: 'center',
          pointerEvents: 'none',
        }}>{badge}</span>
      )}
    </button>
  );
}
