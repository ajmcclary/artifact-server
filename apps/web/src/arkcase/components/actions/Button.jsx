import { akStyleDocument } from '@/arkcase-style';
import React from 'react';

/* Inject the spin keyframe once (for the loading/busy state). */
function ensureSpinKeyframes() {
  if (typeof document === 'undefined' || akStyleDocument.getElementById('ak-spin-kf')) return;
  const s = akStyleDocument.createElement('style');
  s.id = 'ak-spin-kf';
  s.textContent = '@keyframes ak-spin{to{transform:rotate(360deg)}}';
  akStyleDocument.head.appendChild(s);
}
function Spinner({ size = '1em' }) {
  React.useEffect(ensureSpinKeyframes, []);
  return (
    <span aria-hidden="true" style={{
      display: 'inline-block', width: size, height: size, flex: 'none',
      border: '2px solid currentColor', borderTopColor: 'transparent',
      borderRadius: '50%', opacity: 0.9, animation: 'ak-spin .7s linear infinite',
    }} />
  );
}

/**
 * ArkCase Button — Bootstrap 5.3 `.btn` recreation.
 * Solid + outline variants across the brand palette, three sizes.
 * `touch` raises the control to a 44px phone target with a 15px label that may wrap.
 * `variant="navy"` with `outline` is the outline button for the navy app bar (Sign In).
 * `danger` turns a `link` or `ghost` action to the danger ink (Delete, Revoke); `flush`
 * drops a link's padding so it sits inline in running text or a table cell.
 */
export function Button({
  children,
  variant = 'primary',
  outline = false,
  size = 'md',
  icon,
  iconRight,
  disabled = false,
  loading = false,
  block = false,
  pressed,
  expanded,
  hasPopup,
  keyshortcuts,
  title,
  onTint = false,
  touch = false,
  danger = false,
  flush = false,
  type = 'button',
  href,
  target,
  rel,
  download,
  onClick,
  style,
  ...rest
}) {
  // Bootstrap-style variant strings ('outline-primary') are accepted as well as the
   // `outline` flag — the applications mount buttons both ways.
  if (typeof variant === 'string' && variant.indexOf('outline-') === 0) {
    outline = true;
    variant = variant.slice(8);
  }
  const palette = {
    primary: 'var(--bs-primary, #0079a8)',
    secondary: 'var(--bs-secondary, #757575)',
    success: 'var(--bs-success, #00b532)',
    danger: 'var(--bs-danger, #d83506)',
    warning: 'var(--bs-warning, #ff9a15)',
    info: 'var(--bs-info, #0a7a90)',
    light: 'var(--bs-light, #f1f5f7)',
    dark: 'var(--bs-dark, #374151)',
    link: 'transparent',
    ghost: 'transparent',
    navy: 'transparent',
  };
  const hoverPalette = {
    primary: 'var(--bs-primary-hover, #00668f)',
    secondary: 'var(--bs-secondary-hover, #636363)',
    success: 'var(--bs-success-hover, #009a2a)',
    danger: 'var(--bs-danger-hover, #b82d05)',
    warning: 'var(--bs-warning-hover, #d98312)',
    info: 'var(--bs-info-hover, #08687a)',
    light: 'var(--bs-light-hover, #cdd5d9)',
    dark: 'var(--bs-dark-hover, #2f3745)',
  };
  const base = palette[variant] || palette.primary;
  // success & warning fills are too light for white text (see --text-on-success/-warning)
  const lightish = variant === 'light' || variant === 'warning' || variant === 'success';
  const onColor = variant === 'success' ? 'var(--text-on-success, #212529)' : variant === 'warning' ? 'var(--text-on-warning, #212529)' : variant === 'light' ? 'var(--text-body, #212529)' : 'var(--text-on-primary, #ffffff)';
  // Text-safe ink for the outline treatment. The raw fills are fills, not text colors —
  // the readme rules #6C757D a non-text neutral and success/warning too light for text —
  // so outline text + border step to the palette's AA text tones (the pill foregrounds).
  // outline-light keeps its fill color: it is drawn on the navy chrome, never on white.
  const outlineInks = {
    primary: 'var(--text-link-on-tint, #00688f)',
    secondary: 'var(--text-secondary, #5a6268)', /* 6.21:1 on white */
    success: 'var(--pill-success-fg, #15803d)',    /* 4.9:1 on white */
    danger: 'var(--text-overdue, #991b1b)',        /* 7.6:1 on white */
    warning: 'var(--text-due-soon, #92400e)',      /* 7.0:1 on white */
    info: 'var(--text-info-on-tint, #005a7d)',
    light: base,
    dark: 'var(--text-emphasis, #374151)',
  };
  const outlineInk = outlineInks[variant] || base;

  const sizes = {
    sm: { padding: '0.25rem 0.5rem', fontSize: '0.875rem', radius: '0.25rem' },
    md: { padding: '0.375rem 0.75rem', fontSize: '1rem', radius: '0.3125rem' },
    lg: { padding: '0.5rem 1rem', fontSize: '1.25rem', radius: '0.5rem' },
    // Dense toolbar step: a fixed 24px (--space-5) row, 13px label.
    xs: { padding: '0 var(--space-2, 0.5rem)', fontSize: 'var(--font-size-dense, 0.8125rem)', radius: 'var(--radius-md, 0.3125rem)', height: 'var(--space-5, 1.5rem)' },
  };
  const sz = sizes[size] || sizes.md;

  const isLink = variant === 'link';
  // navy + outline: a hairline outline on the navy app bar (Sign In beside a primary Create Account).
  const isNavyOutline = variant === 'navy' && outline;
  // danger: a destructive link or ghost action in the danger text ink.
  const dangerText = danger && (isLink || (variant === 'ghost' && !outline));
  const flat = flush && isLink;
  // ghost: an in-surface text action (no fill, no border, no underline) in the
  // on-tint link ink, so it clears AA on white and on every shipped tint.
  // navy: the same shape for --surface-header chrome, in text-on-navy.
  const isGhost = variant === 'ghost' && !outline;
  const isNavy = variant === 'navy' && !outline;
  const isFlat = isGhost || isNavy;
  // The selected state of a true toggle (pressed) or an open popup trigger (expanded).
  const selected = pressed === true || expanded === true;
  // onTint: an outline or light control on a tinted status bar rests on the card
  // surface so it still reads as a control. Solid non-light variants are unaffected.
  const cardRest = onTint && (outline || variant === 'light');
  const solidBg = cardRest ? 'var(--surface-card, #ffffff)' : outline || isLink || isFlat ? 'transparent' : base;
  // A link/ghost label has no fill of its own, so it inherits whatever surface it sits on —
  // toolbars, selection bars and tinted caps included. It takes the on-tint link step, which
  // clears AA on white and on every shipped tint; --text-link would not.
  const fg = dangerText ? 'var(--text-overdue, #991b1b)'
    : isLink || isGhost ? 'var(--text-link-on-tint, #00688f)'
    : isNavy || isNavyOutline ? 'var(--text-on-navy, #ffffff)'
    : outline ? outlineInk : onColor;
  const navyLine = 'var(--text-on-navy-secondary, rgba(255,255,255,0.72))';

  const styles = {
    display: block ? 'flex' : 'inline-flex',
    width: block ? '100%' : 'auto',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.4em',
    fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
    fontWeight: isFlat || flat ? 'var(--bs-font-weight-semibold, 600)' : 400,
    fontSize: sz.fontSize,
    lineHeight: 1.5,
    ...(sz.height ? { height: sz.height, boxSizing: 'border-box' } : {}),
    padding: flat ? 0 : isLink && !sz.height ? '0.375rem 0.25rem' : sz.padding,
    ...(flat ? { height: 'auto', lineHeight: 'inherit', textAlign: 'left', verticalAlign: 'baseline' } : {}),
    color: fg,
    ...(style?.background != null ? {} : { backgroundColor: solidBg }),
    border: flat ? 0 : isLink || isFlat ? '1px solid transparent' : isNavyOutline ? `1px solid ${navyLine}` : `1px solid ${outline ? outlineInk : base}`,
    borderRadius: sz.radius,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.65 : 1,
    textDecoration: isLink ? 'none' : 'none',
    transition: 'color .15s ease, background-color .15s ease, border-color .15s ease, box-shadow .15s ease',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    // The phone measure: a 44px target whose label may wrap rather than overflow.
    ...(touch ? {
      minHeight: 44, fontSize: '0.9375rem', lineHeight: 1.3, whiteSpace: 'normal',
      paddingTop: 9, paddingBottom: 9, boxSizing: 'border-box',
    } : {}),
    ...style,
  };

  const [hover, setHover] = React.useState(false);
  const [active, setActive] = React.useState(false);
  const [focusVisible, setFocusVisible] = React.useState(false);
  let bg = solidBg, color = fg, bc = isLink || isFlat ? 'transparent' : isNavyOutline ? navyLine : outline ? outlineInk : base;
  let underline = false;
  if (!disabled && hover) {
    if (isLink && dangerText) { underline = true; }
    else if (isLink) { color = 'var(--text-link-hover, #005a7d)'; underline = flat; }
    else if (isGhost && dangerText) { bg = 'var(--tint-danger-hover, rgba(216,53,6,0.05))'; }
    else if (isGhost) { bg = 'var(--tint-primary-hover, rgba(0,121,168,0.05))'; color = 'var(--text-link-hover, #005a7d)'; }
    else if (isNavyOutline) { bg = 'var(--surface-navy-strong, #052a40)'; bc = 'var(--text-on-navy, #ffffff)'; }
    else if (isNavy) { bg = 'var(--surface-navy-strong, #052a40)'; }
    else if (outline) { bg = base; color = onColor; }
    else { bg = hoverPalette[variant] || base; bc = hoverPalette[variant] || base; }
  }
  // Selected (pressed/expanded) and the ghost/navy press take the variant's selected
  // fill: the 10% primary tint, the strong navy step, a solid variant's hover fill,
  // or an outline's filled hover state.
  if (selected || (active && isFlat && !disabled && !loading)) {
    if (dangerText) { bg = 'var(--tint-danger-selected, rgba(216,53,6,0.10))'; color = 'var(--text-overdue, #991b1b)'; }
    else if (isNavyOutline) { bg = 'var(--surface-navy-strong, #052a40)'; color = 'var(--text-on-navy, #ffffff)'; }
    else if (isLink || isGhost) { bg = 'var(--tint-primary-selected, rgba(0,121,168,0.10))'; color = 'var(--text-link-on-tint, #00688f)'; }
    else if (isNavy) { bg = 'var(--surface-navy-strong, #052a40)'; color = 'var(--text-on-navy, #ffffff)'; }
    else if (outline) { bg = base; color = onColor; bc = base; }
    // Solid light steps to the tertiary surface with the strong hairline: --bs-light-hover
    // is not re-themed for dark, so it would drop the dark theme's light label to 1.2:1.
    else if (variant === 'light') { bg = 'var(--surface-tertiary, #e9ecef)'; bc = 'var(--border-color-strong, #ced4da)'; }
    else { bg = hoverPalette[variant] || base; bc = hoverPalette[variant] || base; }
  }

  // 2025-refresh token for the pressed dent; the cyan focus ring unifies the
  // button's keyboard-focus look with the form controls.
  const boxShadow = active && !disabled && !loading && !isFlat
    ? 'var(--shadow-inset-active, inset 0 2px 3px rgba(0,0,0,.10))'
    : focusVisible && !disabled
    ? 'var(--focus-ring, 0 0 0 0.25rem rgba(0,121,168,0.25))'
    : 'none';

  // `href` renders the same control as a native link (a CTA that navigates), so a host
  // never wraps a <button> in an <a>. A disabled or loading link falls back to the
  // disabled button: an anchor cannot be natively disabled.
  const asLink = href != null && !disabled && !loading;
  const Tag = asLink ? 'a' : 'button';
  const linkRel = rel != null ? rel : target === '_blank' ? 'noopener noreferrer' : undefined;
  const elementProps = asLink
    ? { href, target, rel: linkRel, download }
    : { type, disabled: disabled || loading };

  return (
    <Tag
      {...elementProps}
      aria-busy={loading || undefined}
      aria-pressed={pressed === undefined ? undefined : !!pressed}
      aria-expanded={expanded === undefined ? undefined : !!expanded}
      aria-haspopup={hasPopup === undefined || hasPopup === false ? undefined : hasPopup}
      aria-keyshortcuts={keyshortcuts}
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      onFocus={(e) => { try { setFocusVisible(e.target.matches(':focus-visible')); } catch (_) { setFocusVisible(true); } }}
      onBlur={() => setFocusVisible(false)}
      style={{
        ...styles,
        cursor: loading ? 'progress' : disabled ? 'not-allowed' : 'pointer',
        ...(style?.background != null ? {} : { backgroundColor: bg }),
        color,
        ...(flat ? {} : { borderColor: bc }),
        ...(underline ? { textDecoration: 'underline' } : {}),
        ...(asLink && !underline ? { textDecoration: 'none' } : {}),
        boxSizing: 'border-box',
        boxShadow,
      }}
      // Icons follow a coloured label (tonal duotone); a neutral light button keeps Studio colours.
      data-icon-tone={variant === 'light' && !outline ? undefined : 'current'}
      {...rest}
    >
      {loading && <Spinner />}
      {!loading && icon && <i className={`bi ${icon}`} aria-hidden="true" />}
      {children}
      {!loading && iconRight && <i className={`bi ${iconRight}`} aria-hidden="true" />}
    </Tag>
  );
}
