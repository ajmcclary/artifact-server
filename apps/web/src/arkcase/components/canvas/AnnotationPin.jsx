import React from 'react';

/**
 * ArkCase AnnotationPin — the numbered marker a review conversation leaves on a
 * preview. It sits at `x`,`y` percent inside the positioned parent (a
 * `PreviewFrame` body, say), centred on the point it names, and it is a native
 * button that selects its thread. Selected, it grows to 26px and fills with the
 * primary; resolved, it goes neutral. `pending` is the point a new comment will
 * attach to before it has a number: a dashed ring with a location glyph,
 * decorative and inert, because the composer — not the canvas — owns it.
 *
 * `PickLayer` is the other half of placing a pin: a crosshair wash over the
 * preview that reports where the reader clicked, in percent, and picks the
 * centre from the keyboard.
 */

const round = (n) => Math.round(n * 10) / 10;
const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));

export function AnnotationPin({
  n, x = 50, y = 50, selected = false, pending = false, resolved = false,
  label, onClick, style, ...rest
}) {
  const place = {
    position: 'absolute', left: clamp(x) + '%', top: clamp(y) + '%', transform: 'translate(-50%, -50%)',
    boxSizing: 'border-box', borderRadius: '50%', padding: 0, margin: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  };

  if (pending) {
    return (
      <span
        aria-hidden="true"
        data-annotation-pin="pending"
        style={{
          ...place, zIndex: 35, width: 24, height: 24,
          border: '2px dashed var(--bs-primary, #0079a8)',
          background: 'var(--surface-card, #fff)', color: 'var(--text-link-on-tint, #00688f)',
          boxShadow: 'var(--shadow-card, 0 1px 3px rgba(7, 54, 82, 0.10))',
          pointerEvents: 'none',
          ...style,
        }}
        {...rest}
      >
        <i aria-hidden="true" className="bi bi-geo-alt-fill" style={{ fontSize: 11 }} />
      </span>
    );
  }

  const size = selected ? 26 : 22;
  const edge = resolved ? 'var(--bs-gray-600, #6c757d)' : 'var(--bs-primary, #0079a8)';
  const fill = selected ? edge : 'var(--surface-card, #fff)';
  const ink = selected
    ? 'var(--text-on-primary, #fff)'
    : resolved ? 'var(--text-secondary, #5a6268)' : 'var(--text-link-on-tint, #00688f)';

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={onClick ? !!selected : undefined}
      data-annotation-pin={selected ? 'selected' : resolved ? 'resolved' : 'open'}
      onClick={onClick}
      style={{
        ...place, zIndex: selected ? 31 : 30, width: size, height: size,
        border: '2px solid ' + edge, background: fill, color: ink,
        fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)', fontSize: 12, fontWeight: 600, lineHeight: 1,
        cursor: onClick ? 'pointer' : 'default',
        boxShadow: selected ? '0 2px 8px rgba(7,54,82,.30)' : 'var(--shadow-card, 0 1px 3px rgba(7, 54, 82, 0.10))',
        ...style,
      }}
      {...rest}
    >
      {n}
    </button>
  );
}

/**
 * PickLayer — the click-to-place overlay. Covers its positioned parent with a
 * crosshair and a primary wash; a click reports `{ x, y }` in percent of the
 * layer, rounded to 0.1. Enter or Space picks the centre; Escape cancels.
 */
export function PickLayer({ onPick, onCancel, label = 'Choose a point', autoFocus = false, style, ...rest }) {
  const ref = React.useRef(null);
  React.useEffect(() => { if (autoFocus && ref.current) ref.current.focus(); }, [autoFocus]);
  const pick = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) { onPick && onPick({ x: 50, y: 50 }); return; }
    const x = round(clamp(((e.clientX - box.left) / box.width) * 100));
    const y = round(clamp(((e.clientY - box.top) / box.height) * 100));
    onPick && onPick({ x, y });
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick && onPick({ x: 50, y: 50 }); return; }
    if (e.key === 'Escape') { e.preventDefault(); onCancel && onCancel(); }
  };
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={label}
      data-pick-layer=""
      onClick={pick}
      onKeyDown={onKeyDown}
      style={{
        position: 'absolute', inset: 0, zIndex: 40, cursor: 'crosshair',
        background: 'var(--tint-primary-hover, rgba(0,121,168,.05))',
        ...style,
      }}
      {...rest}
    />
  );
}
