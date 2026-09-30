import React from 'react';

/**
 * ArkCase Checkbox — Bootstrap `.form-check-input`. Cyan when checked.
 * Set `radio` for a radio control. `meta` sets a data-font value inline after
 * the label (a capability scope such as `artifact:read`); `description` adds a
 * 12px secondary line beneath it. Both describe the input (aria-describedby)
 * without joining its accessible name, and the box aligns to the label's first line.
 */
export function Checkbox({ label, checked, defaultChecked, disabled = false, radio = false, id, onChange, description, meta, style, ...rest }) {
  const generatedId = React.useId();
  const cid = id || generatedId;
  const [focus, setFocus] = React.useState(false);
  const isControlled = checked !== undefined;
  const [internal, setInternal] = React.useState(!!defaultChecked);
  const on = isControlled ? checked : internal;
  const radius = radio ? '50%' : '0.25em';
  const hasMeta = meta != null && meta !== false && meta !== '';
  const hasDescription = description != null && description !== false && description !== '';
  const detailed = hasMeta || hasDescription;
  const metaId = `${cid}-meta`;
  const descriptionId = `${cid}-description`;
  const describedBy = [rest['aria-describedby'], hasMeta ? metaId : null, hasDescription ? descriptionId : null].filter(Boolean).join(' ') || undefined;
  // The label's line box: 15px × 1.5. The box is centred in it so it sits on the first line.
  const LINE = '1.40625rem';
  const control = (
    <span style={{ position: 'relative', display: 'inline-flex', width: '1em', height: '1em', fontSize: '1rem', flex: 'none' }}>
      <input
        id={cid}
        type={radio ? 'radio' : 'checkbox'}
        checked={on}
        disabled={disabled}
        onChange={(e) => { if (!isControlled) setInternal(e.target.checked); onChange && onChange(e); }}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{ position: 'absolute', opacity: 0, width: '100%', height: '100%', margin: 0, cursor: 'inherit' }}
        {...rest}
        aria-describedby={describedBy}
      />
      <span style={{
        width: '1em', height: '1em',
        border: `1px solid ${on ? 'var(--bs-primary, #0079a8)' : 'var(--border-color-strong, #ced4da)'}`,
        borderRadius: radius,
        backgroundColor: on ? 'var(--bs-primary, #0079a8)' : 'var(--bs-white, #fff)',
        boxShadow: focus ? 'var(--focus-ring, 0 0 0 0.25rem rgba(0,121,168,0.25))' : 'none',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background-color .15s ease, border-color .15s ease',
      }}>
        {on && !radio && <i className="bi bi-check" style={{ color: 'var(--text-on-primary, #fff)', fontSize: '0.9em', lineHeight: 1 }} />}
        {on && radio && <span style={{ width: '0.4em', height: '0.4em', borderRadius: '50%', background: 'var(--bs-white, #fff)' }} />}
      </span>
    </span>
  );
  if (!detailed) {
    return (
      <label htmlFor={cid} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.65 : 1, ...style }}>
        {control}
        {label && <span style={{ fontSize: '0.9375rem' }}>{label}</span>}
      </label>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, ...style }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', columnGap: 'var(--space-2, 0.5rem)', minWidth: 0 }}>
        {/* Disabled dims the control and label only: meta and description stay legible (AA). */}
        <label htmlFor={cid} style={{ display: 'inline-flex', alignItems: 'flex-start', gap: '0.5rem', minWidth: 0, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.65 : 1 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', height: LINE, flex: 'none' }}>{control}</span>
          {label && <span style={{ fontSize: '0.9375rem', lineHeight: 1.5, color: 'var(--text-body, #212529)' }}>{label}</span>}
        </label>
        {hasMeta && (
          <span id={metaId} style={{
            display: 'inline-flex', alignItems: 'center', minHeight: LINE,
            fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)',
            fontSize: 'var(--font-size-label, 0.6875rem)', color: 'var(--text-data, #495057)',
            overflowWrap: 'anywhere',
          }}>{meta}</span>
        )}
      </div>
      {hasDescription && (
        <div id={descriptionId} style={{
          marginTop: '0.125rem', paddingLeft: '1.5rem',
          fontSize: 'var(--font-size-xs, 0.75rem)', lineHeight: 1.5,
          color: 'var(--text-secondary, #5a6268)', textWrap: 'pretty',
        }}>{description}</div>
      )}
    </div>
  );
}
