import React from 'react';

/**
 * ArkCase Textarea — labelled multiline input matching the Input palette:
 * Bootstrap `.form-control` border, cyan focus ring, helper/error text.
 * `mono` sets the value in the data font at 12px for tokens, keys and code.
 */
export function Textarea({
  label, value, defaultValue, placeholder, rows = 4, required = false,
  helper, error, disabled = false, id, onChange, onBlur, onFocus, style, inputRef, inputStyle, mono = false, ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const generatedId = React.useId();
  const areaId = id || generatedId;
  const borderCol = error ? 'var(--bs-danger, #d83506)' : focus ? 'var(--bs-primary, #0079a8)' : 'var(--border-color-strong, #ced4da)';
  const messageId = `${areaId}-${error ? 'error' : 'helper'}`;
  const describedBy = [rest['aria-describedby'], (error || helper) ? messageId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div style={{ ...style }}>
      {label && (
        <label htmlFor={areaId} style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem', color: 'var(--text-body, #212529)' }}>
          {label}
          {required && (
            <span aria-hidden="true" data-required-mark="" style={{ color: 'var(--text-overdue, #991b1b)' }}> *</span>
          )}
        </label>
      )}
      <textarea
        ref={inputRef}
        id={areaId}
        value={value}
        defaultValue={defaultValue}
        placeholder={placeholder}
        rows={rows}
        required={required}
        aria-required={required || undefined}
        disabled={disabled}
        onChange={onChange}
        onFocus={(event) => { setFocus(true); onFocus && onFocus(event); }}
        onBlur={(event) => { setFocus(false); onBlur && onBlur(event); }}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        style={{
          width: '100%',
          minHeight: '2.5rem',
          padding: '0.375rem 0.625rem',
          fontSize: '1rem',
          fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
          lineHeight: 1.5,
          color: 'var(--text-body, #212529)',
          backgroundColor: disabled ? 'var(--bs-gray-200, #e9ecef)' : 'var(--surface-card, #fff)',
          border: `1px solid ${borderCol}`,
          borderRadius: 'var(--radius-md, 6px)',
          boxShadow: focus ? 'var(--focus-ring, 0 0 0 0.25rem rgba(0,121,168,0.25))' : 'none',
          transition: 'border-color .15s ease, box-shadow .15s ease',
          resize: 'vertical',
          ...(mono ? {
            fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)',
            fontSize: 'var(--font-size-xs, 0.75rem)',
            fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)',
            color: 'var(--text-data, #495057)',
          } : null),
          ...inputStyle,
        }}
        {...rest}
      />
      {(helper || error) && (
        <div id={messageId} role={error ? 'alert' : undefined} style={{ fontSize: '0.8125rem', marginTop: '0.25rem', color: error ? 'var(--text-overdue, #991b1b)' : 'var(--text-secondary, #5a6268)' }}>{error || helper}</div>
      )}
    </div>
  );
}
