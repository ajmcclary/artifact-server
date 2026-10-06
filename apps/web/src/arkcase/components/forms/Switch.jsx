import React from 'react';
import { visuallyHiddenStyle } from '../utilities/VisuallyHidden.jsx';

const has = (v) => v != null && v !== '' && v !== false;

/**
 * ArkCase Switch — Bootstrap `.form-switch` toggle. ArkCase blue track when on.
 *
 * With `offLabel` / `onLabel` it becomes a two-sided switch ("Monthly [switch] Annual"): the
 * side in effect is drawn in full ink and weight 600, the other in secondary ink, and clicking
 * either word selects that side. `tone="on-navy"` redraws the track, outline and text for the
 * navy header band.
 */
export function Switch({
  label, checked, defaultChecked, disabled = false, id, onChange,
  tone = 'default', offLabel, onLabel, badge, style, ...rest
}) {
  const sid = id || React.useId();
  const isControlled = checked !== undefined;
  const [internal, setInternal] = React.useState(!!defaultChecked);
  const [focus, setFocus] = React.useState(false);
  const inputRef = React.useRef(null);
  const on = isControlled ? checked : internal;
  const navy = tone === 'on-navy';
  const twoSided = has(offLabel) || has(onLabel);
  const onLabelId = sid + '-on';

  const offTrack = navy ? 'var(--surface-navy-strong, #0d4a6b)' : 'var(--bs-gray-400, #ced4da)';
  const offBorder = navy ? 'var(--text-on-navy-secondary, rgba(255,255,255,0.72))' : 'var(--bs-gray-400, #ced4da)';
  const ring = navy
    ? '0 0 0 0.2rem var(--text-on-navy-secondary, rgba(255,255,255,0.72))'
    : 'var(--focus-ring, 0 0 0 0.25rem rgba(0,121,168,0.25))';
  const ink = navy ? 'var(--text-on-navy, #fff)' : 'var(--text-body, #212529)';
  const quiet = navy ? 'var(--text-on-navy-secondary, rgba(255,255,255,0.72))' : 'var(--text-secondary, #5a6268)';

  /* A named switch keeps its own name; an unnamed two-sided switch is named by its "on" side. */
  const named = has(label) || rest['aria-label'] || rest['aria-labelledby'];
  const inputNaming = twoSided && !named && has(onLabel) ? { 'aria-labelledby': onLabelId } : null;

  const control = (
    <label htmlFor={sid} style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.65 : 1,
      color: navy ? ink : undefined,
      ...(twoSided ? null : style),
    }}>
      <span style={{ position: 'relative', width: '2em', height: '1em', fontSize: '1rem' }}>
        <input
          ref={inputRef}
          id={sid}
          type="checkbox"
          checked={on}
          disabled={disabled}
          onChange={(e) => { if (!isControlled) setInternal(e.target.checked); onChange && onChange(e); }}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{ position: 'absolute', opacity: 0, width: '100%', height: '100%', margin: 0, cursor: 'inherit' }}
          {...inputNaming}
          {...rest}
        />
        {/* Track and knob are drawn over the transparent input; they pass pointer events to it. */}
        <span data-switch-track="" style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          backgroundColor: on ? 'var(--bs-primary, #0079a8)' : offTrack,
          border: `1px solid ${on ? 'var(--bs-primary, #0079a8)' : offBorder}`,
          borderRadius: '1em',
          boxShadow: focus ? ring : 'none',
          transition: 'background-color .15s ease, border-color .15s ease',
        }} />
        <span style={{
          position: 'absolute', top: '0.125em', left: on ? '1.125em' : '0.125em', pointerEvents: 'none',
          width: '0.75em', height: '0.75em', borderRadius: '50%', backgroundColor: 'var(--bs-white, #fff)',
          transition: 'left .15s ease',
        }} />
      </span>
      {has(label) && (
        <span data-switch-label="" style={twoSided ? visuallyHiddenStyle : { fontSize: 'var(--font-size-sm, 0.875rem)' }}>{label}</span>
      )}
    </label>
  );

  if (!twoSided) return control;

  /* Clicking a side word selects that side through the native input, so onChange fires as usual. */
  const pick = (want) => () => {
    const el = inputRef.current;
    if (!el || disabled || el.checked === want) return;
    el.click();
  };
  const side = (active) => ({
    fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.4,
    fontWeight: active ? 600 : 400, color: active ? ink : quiet,
    cursor: disabled ? 'not-allowed' : 'pointer', userSelect: 'none',
  });

  return (
    <span data-switch="" data-tone={tone} style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, opacity: disabled ? 0.65 : 1, ...style }}>
      {has(offLabel) && (
        <span data-switch-off-label="" data-active={!on ? '' : undefined} onClick={pick(false)} style={side(!on)}>{offLabel}</span>
      )}
      {React.cloneElement(control, { style: { ...control.props.style, opacity: 1 } })}
      {(has(onLabel) || has(badge)) && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {has(onLabel) && (
            <span id={onLabelId} data-switch-on-label="" data-active={on ? '' : undefined} onClick={pick(true)} style={side(on)}>{onLabel}</span>
          )}
          {has(badge) && <span data-switch-badge="" style={{ display: 'inline-flex' }}>{badge}</span>}
        </span>
      )}
    </span>
  );
}
