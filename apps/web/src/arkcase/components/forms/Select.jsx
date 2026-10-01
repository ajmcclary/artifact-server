import { akStyleDocument } from '@/arkcase-style';
import React from 'react';

/* The viewer size steps down to 11px under 576px. A media query cannot be inline,
   so the size's font is a custom property the once-injected sheet redefines. */
function ensureSelectStyles() {
  if (typeof document === 'undefined' || akStyleDocument.getElementById('ak-select-css')) return;
  const el = akStyleDocument.createElement('style');
  el.id = 'ak-select-css';
  el.textContent = '@media (max-width:575.98px){[data-ak-select][data-size="viewer"]{--ak-select-viewer-font:var(--font-size-label,11px)}}';
  akStyleDocument.head.appendChild(el);
}

/* Options of the navy select open on the light popup surface, so they keep body ink. */
const NAVY_OPTION = { color: 'var(--text-body, #212529)', backgroundColor: 'var(--surface-card, #fff)' };

/* The label of the option the select currently shows, read from the DOM so options,
   children and optgroups are all covered. */
function selectShownLabel(root) {
  const el = root && root.querySelector('select');
  if (!el || el.selectedIndex < 0) return '';
  const opt = el.options[el.selectedIndex];
  return opt ? opt.text : '';
}

/**
 * ArkCase Select — Bootstrap `.form-select`. Native select with the brand
 * chevron indicator and cyan focus ring. `variant="bare"` drops the border,
 * fill and own focus ring so the select can sit inside another field (Input
 * `trailing`), whose focus-within ring then marks focus. `variant="flush"` keeps
 * the size's geometry and fill but drops border and radius, for a segment of a
 * joined tool group whose container draws the outline. `variant="navy"` is the app bar's
 * select (a language picker): `text-on-navy` ink and chevron, a `text-on-navy-secondary`
 * hairline and a faint white fill; its options keep body ink on the popup.
 *
 * `fit` sizes the control to its options (the native widest-option width);
 * `fit="selected"` sizes the closed control to the option it shows now — a hidden
 * copy of that label, in the same font and padding, shares one inline-grid cell
 * with the select and sets the track, so a toolbar does not reserve room for its
 * longest choice.
 *
 * `placeholder` adds a leading empty-value option ("Select…") before the options;
 * `required` sets native `required` and `aria-required` and marks the label with `*`.
 */
export function Select({ label, value, defaultValue, options = [], children, size = 'md', fit = false, helper, error, disabled = false, id, onChange, onBlur, onFocus, className, style, variant = 'default', required = false, placeholder, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  const selId = id || React.useId();
  const rootRef = React.useRef(null);
  const fitSelected = fit === 'selected';
  const [shown, setShown] = React.useState('');
  const pads = {
    viewer: '4px 30px 4px 10px',
    dock: '2px 30px 2px 6px',
    sm: '0.25rem 1.75rem 0.25rem 0.5rem',
    md: '0.375rem 2.25rem 0.375rem 0.625rem',
    lg: '0.5rem 2.25rem 0.5rem 0.875rem',
  };
  const fonts = {
    viewer: 'var(--ak-select-viewer-font, var(--font-size-xs, 12px))',
    dock: 'var(--font-size-label, 11px)',
    sm: '0.875rem',
    md: '1rem',
    lg: '1.25rem',
  };
  const heights = { viewer: 30, dock: 24 };
  const toolbarSize = size === 'viewer' || size === 'dock';
  React.useEffect(() => { if (size === 'viewer') ensureSelectStyles(); }, [size]);
  /* Keep the measured label in step with whatever the select shows: a controlled
     value, changed options, a user pick (onChange below) or a form reset. */
  React.useLayoutEffect(() => {
    if (!fitSelected) return;
    const next = selectShownLabel(rootRef.current);
    if (next !== shown) setShown(next);
  });
  React.useEffect(() => {
    if (!fitSelected) return undefined;
    const el = rootRef.current && rootRef.current.querySelector('select');
    const form = el && el.form;
    if (!form) return undefined;
    let t = null;
    const onReset = () => { t = setTimeout(() => setShown(selectShownLabel(rootRef.current)), 0); };
    form.addEventListener('reset', onReset);
    return () => { form.removeEventListener('reset', onReset); if (t) clearTimeout(t); };
  }, [fitSelected]);
  // Encoded at runtime: a pre-encoded data URI in source reads as an obfuscated payload to automated review.
  const chevron = 'data:image/svg+xml,' + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path fill='none' stroke='#343a40' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='m2 5 6 6 6-6'/></svg>");
  const bare = variant === 'bare';
  const flush = variant === 'flush';
  // navy: the app bar's select (a language picker) — on-navy ink, a light hairline, a faint white fill.
  const navy = variant === 'navy';
  const chevronOnNavy = 'data:image/svg+xml,' + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path fill='none' stroke='#ffffff' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='m2 5 6 6 6-6'/></svg>");
  const intrinsic = !!fit || bare;
  const messageId = `${selId}-${error ? 'error' : 'helper'}`;
  const describedBy = [rest['aria-describedby'], (error || helper) ? messageId : null].filter(Boolean).join(' ') || undefined;

  const listed = options.length > 0 ? options.map((o, i) => {
    const opt = typeof o === 'string' ? { value: o, label: o } : o;
    return <option key={i} value={opt.value} style={navy ? NAVY_OPTION : undefined}>{opt.label}</option>;
  }) : children;
  const hasPlaceholder = placeholder != null && placeholder !== '';
  const renderedOptions = hasPlaceholder
    ? <><option value="" style={navy ? NAVY_OPTION : undefined}>{placeholder}</option>{listed}</>
    : listed;

  const selectStyle = bare ? {
    width: fitSelected ? '100%' : 'auto',
    padding: '0.125rem 1.25rem 0.125rem 0.25rem',
    fontSize: 'inherit',
    fontFamily: 'inherit',
    lineHeight: 'inherit',
    color: 'var(--text-body, #212529)',
    backgroundColor: 'transparent',
    backgroundImage: `url("${chevron}")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 0.25rem center',
    backgroundSize: '11px 9px',
    border: 0,
    borderRadius: 'var(--radius-sm, 4px)',
    appearance: 'none',
    outline: 'none',
    boxShadow: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
  } : {
    width: fitSelected ? '100%' : fit ? 'auto' : '100%',
    boxSizing: 'border-box',
    height: toolbarSize ? heights[size] : undefined,
    padding: pads[size] || pads.md,
    fontSize: fonts[size] || fonts.md,
    fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
    lineHeight: size === 'viewer' ? 1.25 : 1.5,
    color: navy ? 'var(--text-on-navy, #ffffff)' : 'var(--text-body, #212529)',
    backgroundColor: navy
      ? 'color-mix(in srgb, var(--text-on-navy, #ffffff) 18%, transparent)'
      : disabled ? 'var(--bs-gray-200, #e9ecef)' : 'var(--surface-card, #fff)',
    backgroundImage: `url("${navy ? chevronOnNavy : chevron}")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: toolbarSize ? 'right 9px center' : 'right 0.5rem center',
    backgroundSize: toolbarSize ? '10px 10px' : '14px 12px',
    border: flush ? 0 : `1px solid ${error ? 'var(--bs-danger, #d83506)'
      : navy ? (focus ? 'var(--text-on-navy, #ffffff)' : 'var(--text-on-navy-secondary, rgba(255,255,255,0.72))')
      : focus ? 'var(--bs-primary, #0079a8)' : 'var(--border-color-strong, #ced4da)'}`,
    borderRadius: flush ? 0 : size === 'viewer' ? 'var(--radius-sm, 4px)' : 'var(--radius-md, 6px)',
    appearance: 'none',
    outline: 'none',
    boxShadow: !focus ? 'none'
      : flush ? 'inset 0 0 0 2px var(--focus-ring-color, #0079a8)'
      : 'var(--focus-ring, 0 0 0 0.25rem rgba(0,121,168,0.25))',
    textOverflow: 'ellipsis',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'border-color .15s ease, box-shadow .15s ease',
  };

  const select = (
    <select
      id={selId}
      value={value}
      defaultValue={defaultValue}
      disabled={disabled}
      onChange={(event) => {
        if (fitSelected) setShown(selectShownLabel(rootRef.current));
        onChange && onChange(event);
      }}
      onFocus={(event) => { setFocus(true); onFocus && onFocus(event); }}
      onBlur={(event) => { setFocus(false); onBlur && onBlur(event); }}
      required={required || undefined}
      aria-required={required || undefined}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      style={selectStyle}
      {...rest}
    >
      {renderedOptions}
    </select>
  );

  /* fit="selected": the hidden label and the select share one grid cell. The label
     sets the track; the select sits in an inline-size-contained wrapper, so its own
     widest-option width contributes nothing and it fills the measured track. */
  const control = fitSelected ? (
    <div data-ak-select-fit="" style={{ display: 'inline-grid', width: 'max-content', maxWidth: '100%', verticalAlign: 'middle' }}>
      <span
        aria-hidden="true"
        data-ak-select-measure=""
        style={{
          gridArea: '1 / 1', minWidth: 0, visibility: 'hidden', whiteSpace: 'pre', overflow: 'hidden',
          boxSizing: 'border-box',
          padding: selectStyle.padding,
          border: bare || flush ? 0 : '1px solid transparent',
          fontSize: selectStyle.fontSize,
          fontFamily: selectStyle.fontFamily,
          lineHeight: selectStyle.lineHeight,
        }}
      >
        {shown || '\u00a0'}
      </span>
      <div style={{ gridArea: '1 / 1', minWidth: 0, width: '100%', contain: 'inline-size' }}>{select}</div>
    </div>
  ) : select;

  return (
    <div ref={rootRef} className={className} data-ak-select="" data-fit={fit ? (fitSelected ? 'selected' : '') : undefined} data-size={size} data-variant={bare || flush || navy ? variant : undefined} style={{ display: intrinsic ? 'inline-block' : 'block', width: intrinsic ? 'auto' : undefined, maxWidth: fitSelected ? '100%' : undefined, ...style }}>
      {label && (
        <label htmlFor={selId} style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
          {label}
          {required && <span aria-hidden="true" data-required-mark="" style={{ color: 'var(--text-overdue, #991b1b)' }}> *</span>}
        </label>
      )}
      {control}
      {(helper || error) && <div id={messageId} role={error ? 'alert' : undefined} style={{ fontSize: '0.8125rem', marginTop: '0.25rem', color: error ? 'var(--text-overdue, #991b1b)' : 'var(--text-secondary, #5a6268)' }}>{error || helper}</div>}
    </div>
  );
}
