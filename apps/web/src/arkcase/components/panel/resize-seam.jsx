import React from 'react';
import { ResizeSeam } from './ResizeSeam.jsx';

/**
 * ArkCase resize seam — the width seam Panel and SideNav share, as one hook over one arithmetic.
 * The seam element is a vertical separator on the column's inward edge: a 9px hit area with a
 * 2px rule that reads at 60% on hover or focus and fully while dragging; pointer capture on
 * down, the clamped width live on move, one commit on up; the inward arrow and ArrowUp widen
 * by `step`, the outward arrow and ArrowDown narrow, Home and End go to the bounds, Delete and
 * Backspace reset; a double-click resets; a readout chip names the width in the data face.
 *
 * The arithmetic is `ResizeSeam`'s: this hook holds one per mounted seam, feeds it the pointer
 * and the keys, and draws what it reports. `onOvershoot` is the one difference between the two
 * callers. Given, a drag that reaches `minWidth` and holds for `holdMs` arms and fires it —
 * Panel collapses to its rail and leaves the width alone, so re-pinning restores it. Omitted,
 * the drag simply bottoms out at the minimum: the navigation never collapses by overshoot, the
 * pin is what rails it. Its exports are lowercase on purpose: the bundler compiles the module
 * and keeps it off the namespace, so it is the two components' seam and not a third public
 * surface. A change to the bounds, the side or the name replaces the arithmetic, which drops a
 * drag in flight — a window resized mid-drag starts over.
 */
/* v8 ignore next */
const isFocusVisible = (el) => { try { return el.matches(':focus-visible'); } catch (_) { return true; } };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));

export function useResizeSeam({
  width, minWidth = 200, maxWidth = 720, side = 'start', step, name = 'panel',
  reduceMotion = false, onWidthChange, onAnnounce, onOvershoot, holdMs, attrs,
}) {
  const [live, setLive] = React.useState({ width: null, dragging: false, arming: false, armPct: 0 });
  const [seamHover, setSeamHover] = React.useState(false);
  const [seamFocus, setSeamFocus] = React.useState(false);
  /* The callbacks are read at call time, so a re-render never rebuilds the arithmetic. */
  const latest = React.useRef({});
  latest.current = { onWidthChange, onAnnounce, onOvershoot };
  const canCollapse = typeof onOvershoot === 'function';
  const core = React.useMemo(() => ResizeSeam({
    minWidth, maxWidth, side, step, name, holdMs,
    onWidthChange: (w) => { const f = latest.current.onWidthChange; if (f) f(w); },
    onAnnounce: (text) => { const f = latest.current.onAnnounce; if (f) f(text); },
    onOvershoot: canCollapse ? () => { const f = latest.current.onOvershoot; if (f) f(); } : undefined,
    onState: (s) => setLive(s),
  }), [minWidth, maxWidth, side, step, name, holdMs, canCollapse]);
  React.useEffect(() => () => core.cancel(), [core]);

  const base = clamp(typeof width === 'number' ? width : minWidth, minWidth, maxWidth);
  const current = live.width != null ? live.width : base;
  const dragging = live.dragging;
  const arming = live.arming;

  const onSeamDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* synthetic event */ }
    core.begin(e.clientX, current);
  };
  const onSeamMove = (e) => { core.move(e.clientX); };
  const onSeamUp = (e) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) { /* not captured */ }
    core.end();
  };
  const onSeamKey = (e) => { if (core.key(e.key, current)) e.preventDefault(); };

  const seamOn = seamHover || seamFocus || dragging;
  const seam = (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-valuenow={current}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-label={'Resize the ' + name}
      title="Drag to resize. Double-click to reset the default width."
      {...(attrs || {})}
      onPointerDown={onSeamDown}
      onPointerMove={onSeamMove}
      onPointerUp={onSeamUp}
      onPointerCancel={onSeamUp}
      onDoubleClick={(e) => { e.preventDefault(); core.reset(); }}
      onKeyDown={onSeamKey}
      onMouseEnter={() => setSeamHover(true)}
      onMouseLeave={() => setSeamHover(false)}
      onFocus={(e) => setSeamFocus(isFocusVisible(e.target))}
      onBlur={() => setSeamFocus(false)}
      style={{
        position: 'absolute', top: 0, bottom: 0, [side === 'end' ? 'left' : 'right']: -5, width: 9, zIndex: 5,
        display: 'flex', justifyContent: 'center', cursor: 'col-resize', background: 'transparent', outline: 'none',
        touchAction: 'none',
      }}
    >
      <span aria-hidden="true" style={{
        width: arming ? 4 : dragging ? 3 : 2, height: '100%',
        background: arming ? 'var(--bs-tertiary, #005a7d)' : 'var(--bs-primary, #0079a8)',
        opacity: seamOn ? (dragging ? 1 : 0.6) : 0,
        transition: reduceMotion ? 'none' : 'opacity .15s ease, width .15s ease',
      }} />
      {seamOn && (
        <span aria-hidden="true" style={{
          position: 'absolute', top: 10, [side === 'end' ? 'right' : 'left']: 12,
          padding: '3px 7px', borderRadius: 'var(--radius-md, 5px)',
          background: arming ? 'var(--bs-tertiary, #005a7d)' : 'var(--surface-header, #073652)',
          color: 'var(--text-on-primary, #fff)',
          fontFamily: arming ? 'var(--font-sans, "Public Sans", system-ui, sans-serif)' : 'var(--font-data, "Source Code Pro", ui-monospace, monospace)',
          fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)',
          fontSize: 'var(--font-size-xs, 12px)', fontWeight: arming ? 600 : 400, whiteSpace: 'nowrap', pointerEvents: 'none',
          opacity: dragging ? 1 : 0.92, boxShadow: 'var(--shadow-md, 0 2px 4px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.1))',
        }}>
          {arming ? 'Hold to collapse' : current + ' px'}
          {arming && (
            <span style={{ display: 'block', marginTop: 4, height: 3, borderRadius: 2, background: 'rgba(255,255,255,.28)', overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', borderRadius: 2, background: 'var(--bs-white, #fff)', width: Math.round(live.armPct * 100) + '%' }} />
            </span>
          )}
        </span>
      )}
    </div>
  );
  return { seam, width: current, dragging, arming };
}
