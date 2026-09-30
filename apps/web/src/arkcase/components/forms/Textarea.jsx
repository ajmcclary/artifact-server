import React from 'react';

/**
 * ArkCase Textarea — labelled multiline input matching the Input palette:
 * Bootstrap `.form-control` border, cyan focus ring, helper/error text.
 * `mono` sets the value in the data font at 12px for tokens, keys and code.
 * `toolbar` draws a formatting strip inside the field border, above the text: the box
 * then carries the one border, focus ring (focus-within), error and disabled states, and
 * the root becomes a `role="group"` named by the label.
 */
export function Textarea({
  label, value, defaultValue, placeholder, rows = 4, required = false,
  helper, error, disabled = false, id, onChange, onBlur, onFocus, style, inputRef, inputStyle, mono = false, toolbar, ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const [focusWithin, setFocusWithin] = React.useState(false);
  const stripRef = React.useRef(null);
  const hasToolbar = toolbar != null && toolbar !== false;
  /* A disabled field takes its toolbar out of the tab order and pointer reach as well.
     Set as a DOM property so React 18 and 19 treat it alike. */
  React.useEffect(() => {
    if (stripRef.current) stripRef.current.inert = !!disabled;
  }, [disabled, hasToolbar]);
  const generatedId = React.useId();
  const areaId = id || generatedId;
  const borderCol = error ? 'var(--bs-danger, #d83506)' : focus ? 'var(--bs-primary, #0079a8)' : 'var(--border-color-strong, #ced4da)';
  const messageId = `${areaId}-${error ? 'error' : 'helper'}`;
  const describedBy = [rest['aria-describedby'], (error || helper) ? messageId : null].filter(Boolean).join(' ') || undefined;
  const labelId = `${areaId}-label`;
  const boxFocus = hasToolbar && focusWithin;
  const boxBorder = error ? 'var(--bs-danger, #d83506)' : boxFocus ? 'var(--bs-primary, #0079a8)' : 'var(--border-color-strong, #ced4da)';

  const area = (
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
        ...(hasToolbar ? {
          /* Inside the toolbar box: the box owns the border, radius, ring and ground. */
          display: 'block',
          boxSizing: 'border-box',
          border: 0,
          borderRadius: '0 0 var(--radius-md, 6px) var(--radius-md, 6px)',
          boxShadow: 'none',
          outline: 'none',
          backgroundColor: 'transparent',
        } : null),
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
  );

  return (
    <div
      style={{ ...style }}
      role={hasToolbar ? 'group' : undefined}
      aria-labelledby={hasToolbar && label ? labelId : undefined}
      data-textarea-group={hasToolbar ? '' : undefined}
    >
      {label && (
        <label htmlFor={areaId} id={hasToolbar ? labelId : undefined} style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem', color: 'var(--text-body, #212529)' }}>
          {label}
          {required && (
            <span aria-hidden="true" data-required-mark="" style={{ color: 'var(--text-overdue, #991b1b)' }}> *</span>
          )}
        </label>
      )}
      {hasToolbar ? (
        <div
          data-textarea-field=""
          onFocus={() => setFocusWithin(true)}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false); }}
          style={{
            border: `1px solid ${boxBorder}`,
            borderRadius: 'var(--radius-md, 6px)',
            backgroundColor: disabled ? 'var(--bs-gray-200, #e9ecef)' : 'var(--surface-card, #fff)',
            boxShadow: boxFocus ? 'var(--focus-ring, 0 0 0 0.25rem rgba(0,121,168,0.25))' : 'none',
            transition: 'border-color .15s ease, box-shadow .15s ease',
          }}
        >
          <div
            ref={stripRef}
            data-textarea-toolbar=""
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '4px 8px',
              background: 'var(--surface-secondary, #f8f9fa)',
              borderBottom: '1px solid var(--border-color, #dee2e6)',
              borderRadius: 'var(--radius-md, 6px) var(--radius-md, 6px) 0 0',
              opacity: disabled ? 0.65 : undefined,
              pointerEvents: disabled ? 'none' : undefined,
            }}
          >
            {toolbar}
          </div>
          {area}
        </div>
      ) : area}
      {(helper || error) && (
        <div id={messageId} role={error ? 'alert' : undefined} style={{ fontSize: '0.8125rem', marginTop: '0.25rem', color: error ? 'var(--text-overdue, #991b1b)' : 'var(--text-secondary, #5a6268)' }}>{error || helper}</div>
      )}
    </div>
  );
}
