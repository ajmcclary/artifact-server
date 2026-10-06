import React from 'react';
import { toneTokens, toneIcon } from '../utilities/tones.jsx';
import { FIELD_PAD_X, FIELD_PAD_Y, FieldLabel, FieldMessage, fieldDescription, useFieldId } from './field-chrome.jsx';

// Field status → semantic tone. `error` keeps the historical danger border and message ink.
const STATUS_TONE = { error: 'danger', warning: 'warning', success: 'success', info: 'primary' };

/* The trailing Show/Hide text toggle of a revealable password field. A native
   button with aria-pressed; its own focus outline shows inside the field ring. */
function RevealToggle({ revealed, disabled, controls, onToggle, label, touch }) {
  const [hover, setHover] = React.useState(false);
  const [focusVisible, setFocusVisible] = React.useState(false);
  return (
    <button
      type="button"
      aria-pressed={revealed}
      aria-controls={controls}
      disabled={disabled}
      onClick={onToggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={(e) => { try { setFocusVisible(e.target.matches(':focus-visible')); } catch (_) { setFocusVisible(true); } }}
      onBlur={() => setFocusVisible(false)}
      style={{
        flex: '0 0 auto',
        minHeight: touch ? '36px' : undefined,
        padding: '0.125rem var(--space-2, 0.5rem)',
        background: 'transparent',
        border: 0,
        borderRadius: 'var(--radius-sm, 4px)',
        fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
        fontSize: 'var(--font-size-dense, 0.8125rem)',
        fontWeight: 'var(--bs-font-weight-semibold, 600)',
        lineHeight: 1.5,
        color: disabled ? 'var(--text-secondary, #5a6268)' : hover ? 'var(--text-link-hover, #005a7d)' : 'var(--text-link-on-tint, #00688f)',
        textDecoration: hover && !disabled ? 'underline' : 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        outline: focusVisible ? 'var(--focus-outline, 2px solid #0079a8)' : 'none',
        outlineOffset: '1px',
      }}
    >
      {label}
    </button>
  );
}

/**
 * ArkCase Input — Bootstrap `.form-control`. Optional leading icon, label,
 * helper/error text, sizes, `autoFocus` for a dialog's search field.
 * ArkCase blue focus ring. `variant="pill"` rounds the field; `trailing` places
 * content (a divider and compact select, a clear button) inside the border.
 * `leading` places content (a ColorSwatch) before the input; `status` adds a
 * semantic border and status glyph; `mono` sets the value in the data font.
 * With in-field content the wrapper shows the focus ring while focus is
 * anywhere inside it (focus-within), so a bare trailing Select stays visible.
 * `touch` sets a 44px control with a 15px value for phone columns; `revealable`
 * gives a password field a trailing Show/Hide text toggle (after `trailing`).
 * `required` sets native `required` and `aria-required` and marks the visible label
 * with a trailing `*` (aria-hidden; the required state itself is announced).
 */
export function Input({
  label, value, defaultValue, placeholder, type = 'text', size = 'md',
  icon, helper, error, disabled = false, id, onChange, onBlur, onFocus, style, autoFocus = false,
  trailing, variant = 'default', inputRef, onKeyDown, leading, status, statusIcon, mono = false,
  touch = false, revealable = false, revealLabels, required = false, ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const [focusWithin, setFocusWithin] = React.useState(false);
  const [revealed, setRevealed] = React.useState(false);
  const inputId = useFieldId(id);
  // touch: a 44px control, 0 × 12px padding and a 16px value (--font-size-md, Button's touch label) — the
  // phone measure; at 16px iOS Safari does not zoom the page on focus.
  const pads = touch
    ? { sm: { y: '0', x: '12px' }, md: { y: '0', x: '12px' }, lg: { y: '0', x: '12px' } }
    : { sm: { y: '0.25rem', x: '0.5rem' }, md: { y: FIELD_PAD_Y, x: FIELD_PAD_X }, lg: { y: '0.5rem', x: '0.875rem' } };
  const fonts = touch
    ? { sm: 'var(--font-size-md, 1rem)', md: 'var(--font-size-md, 1rem)', lg: 'var(--font-size-md, 1rem)' }
    : { sm: '0.875rem', md: '1rem', lg: '1.25rem' };
  const touchHeight = touch ? { height: '44px', boxSizing: 'border-box' } : null;
  // revealable: only a password field gets the Show/Hide toggle.
  const canReveal = revealable && type === 'password';
  const inputType = canReveal && revealed ? 'text' : type;
  const [showLabel, hideLabel] = Array.isArray(revealLabels) && revealLabels.length === 2 ? revealLabels : ['Show', 'Hide'];
  // `error` text implies status "error"; an explicit `status` otherwise sets the tone.
  const fieldStatus = error ? 'error' : (STATUS_TONE[status] ? status : undefined);
  const tone = fieldStatus ? toneTokens(STATUS_TONE[fieldStatus]) : null;
  // The glyph shows for an explicit `status` unless `statusIcon={false}`; legacy `error`-only fields opt in with `statusIcon`.
  const showStatusIcon = !!fieldStatus && (statusIcon != null ? !!statusIcon : !!STATUS_TONE[status]);
  const borderCol = fieldStatus === 'error' ? 'var(--bs-danger, #d83506)' : tone ? tone.line : focus ? 'var(--bs-primary, #0079a8)' : 'var(--border-color-strong, #ced4da)';
  const { messageId, describedBy } = fieldDescription(inputId, { helper, error, describedBy: rest['aria-describedby'] });
  const radius = variant === 'pill' ? 'var(--radius-pill, 10px)' : 'var(--radius-md, 5px)';
  // navy: the app bar's search field — on-navy ink over a faint white fill, a light hairline that
  // turns solid on-navy while focused.
  const navy = variant === 'navy';
  const navyField = navy ? {
    color: 'var(--text-on-navy, #ffffff)',
    backgroundColor: 'color-mix(in srgb, var(--text-on-navy, #ffffff) 18%, transparent)',
    border: `1px solid ${focus ? 'var(--text-on-navy, #ffffff)' : 'var(--border-on-navy, rgba(255,255,255,0.18))'}`,
  } : null;
  const iconColor = navy ? 'var(--text-on-navy-secondary, rgba(255,255,255,0.72))' : 'var(--text-secondary, #5a6268)';
  const hasTrailing = trailing != null && trailing !== false;
  const hasLeading = leading != null && leading !== false;
  // In-field content (leading, status glyph, trailing) moves the border onto a wrapper.
  const framed = hasTrailing || hasLeading || showStatusIcon || canReveal;
  const wrapperFocus = focus || focusWithin;
  const wrapperBorder = fieldStatus ? borderCol : wrapperFocus ? 'var(--bs-primary, #0079a8)' : borderCol;
  const monoStyle = mono ? { fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)', fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)', color: 'var(--text-data, #495057)' } : null;
  const fieldSurface = {
    fontSize: fonts[size],
    fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
    lineHeight: 1.5,
    color: 'var(--text-body, #212529)',
    backgroundColor: disabled ? 'var(--bs-gray-200, #e9ecef)' : 'var(--surface-card, #fff)',
  };
  const inputEvents = {
    onChange,
    onKeyDown,
    onFocus: (event) => { setFocus(true); onFocus && onFocus(event); },
    onBlur: (event) => { setFocus(false); onBlur && onBlur(event); },
  };
  return (
    <div style={{ ...style }}>
      {label && <FieldLabel htmlFor={inputId} required={required}>{label}</FieldLabel>}
      {framed ? (
        <div
          onFocus={() => setFocusWithin(true)}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false); }}
          style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-2, 0.5rem)',
            paddingInlineStart: pads[size].x, paddingInlineEnd: 'var(--space-1, 0.25rem)',
            ...fieldSurface,
            ...touchHeight,
            border: `1px solid ${wrapperBorder}`,
            borderRadius: radius,
            boxShadow: wrapperFocus ? 'var(--focus-ring, 0 0 0 0.25rem rgba(0,121,168,0.25))' : 'none',
            outline: wrapperFocus ? 'var(--focus-outline, 2px solid #0079a8)' : 'none',
            outlineOffset: 'var(--focus-outline-offset, 2px)',
            transition: 'border-color .15s ease, box-shadow .15s ease',
          }}
        >
          {icon && (
            <i className={`bi ${icon}`} aria-hidden="true" style={{ color: 'var(--text-secondary, #5a6268)', fontSize: fonts[size], pointerEvents: 'none', flex: '0 0 auto' }} />
          )}
          {hasLeading && (
            <span style={{ display: 'inline-flex', alignItems: 'center', flex: '0 0 auto', pointerEvents: 'none' }}>{leading}</span>
          )}
          <input
            id={inputId}
            ref={inputRef}
            type={inputType}
            value={value}
            defaultValue={defaultValue}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus || undefined}
            {...inputEvents}
            required={required || undefined}
            aria-required={required || undefined}
            aria-invalid={fieldStatus === 'error' ? true : undefined}
            style={{
              flex: 1, minWidth: 0, width: '100%',
              padding: `${pads[size].y} 0`,
              ...(touch ? { height: '100%' } : null),
              ...fieldSurface,
              ...monoStyle,
              backgroundColor: 'transparent',
              border: 0,
              outline: 'none',
            }}
            {...rest}
            aria-describedby={describedBy}
          />
          {showStatusIcon && (
            <i className={`bi ${toneIcon(STATUS_TONE[fieldStatus])}`} aria-hidden="true" data-status={fieldStatus}
              style={{ color: tone.icon, fontSize: '0.875em', lineHeight: 1, pointerEvents: 'none', flex: '0 0 auto', marginRight: hasTrailing || canReveal ? 0 : 'var(--space-1, 0.25rem)' }} />
          )}
          {hasTrailing && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1, 0.25rem)', flex: '0 0 auto' }}>{trailing}</span>}
          {canReveal && (
            <RevealToggle
              revealed={revealed}
              disabled={disabled}
              controls={inputId}
              onToggle={() => setRevealed((v) => !v)}
              label={revealed ? hideLabel : showLabel}
              touch={touch}
            />
          )}
        </div>
      ) : (
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          {icon && (
            <i className={`bi ${icon}`} aria-hidden="true" data-icon-tone={navy ? 'current' : undefined} style={{ position: 'absolute', insetInlineStart: '0.6rem', color: iconColor, fontSize: fonts[size], pointerEvents: 'none' }} />
          )}
          <input
            id={inputId}
            type={inputType}
            value={value}
            defaultValue={defaultValue}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus || undefined}
            ref={inputRef}
            {...inputEvents}
            required={required || undefined}
            aria-required={required || undefined}
            aria-invalid={fieldStatus === 'error' ? true : undefined}
            style={{
              width: '100%',
              padding: `${pads[size].y} ${pads[size].x}`,
              paddingInlineStart: icon ? '2rem' : pads[size].x,
              fontSize: fonts[size],
              fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
              lineHeight: 1.5,
              color: 'var(--text-body, #212529)',
              backgroundColor: disabled ? 'var(--bs-gray-200, #e9ecef)' : 'var(--surface-card, #fff)',
              border: `1px solid ${borderCol}`,
              borderRadius: radius,
              boxShadow: focus ? 'var(--focus-ring, 0 0 0 0.25rem rgba(0,121,168,0.25))' : 'none',
              transition: 'border-color .15s ease, box-shadow .15s ease',
              ...touchHeight,
              ...monoStyle,
              ...navyField,
            }}
            data-ak-input={navy ? 'navy' : undefined}
            {...rest}
            aria-describedby={describedBy}
          />
        </div>
      )}
      <FieldMessage
        id={messageId}
        helper={helper}
        error={error}
        color={fieldStatus === 'error' ? 'var(--text-overdue, #991b1b)' : fieldStatus === 'warning' ? tone.text : 'var(--text-secondary, #5a6268)'}
      />
    </div>
  );
}
