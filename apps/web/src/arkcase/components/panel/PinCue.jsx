import { akStyleDocument } from '@/arkcase-style';
import React from 'react';
import { LiveRegion } from '../utilities/announcer.jsx';

/**
 * ArkCase PinCue — the two-second "your control moved here" cue after a pin toggles.
 *
 * Pinning moves the control that reverses it (a panel's pin goes from its footer to its rail,
 * the menu's pin from the expanded nav to the collapsed one). After the toggle a ring pulses
 * over the control's new home and a small navy chip beside it names what the control now does —
 * "Unpin the menu". `Panel` draws the same cue on its own pin; PinCue is that cue for a control
 * that has none of its own (a SideNav pin, a host-drawn button), laid `position: fixed` over
 * `anchor` so it can sit at the root of the page. Both share the ring colour, pulse, chip and
 * reduced-motion behaviour defined here.
 *
 * The ring and chip are `aria-hidden`: the cue is visual. The label is announced politely
 * through a `LiveRegion` unless `announce={false}` — pass that when the host already says
 * "Menu pinned." itself.
 */

export const PIN_CUE_MS = 2000;
/** The pin cue ring, on the brand primary. */
export const PIN_RING = 'rgba(var(--bs-primary-rgb, 0, 121, 168), .45)';

/** The navy chip that names the new state — shared by Panel's footer cue and PinCue. */
export const PIN_CUE_CHIP_STYLE = {
  padding: '3px 8px', borderRadius: 'var(--radius-md, 5px)',
  background: 'var(--surface-header, #073652)', color: 'var(--text-on-navy, #fff)',
  fontSize: 'var(--font-size-xs, 12px)', fontWeight: 600, whiteSpace: 'nowrap', pointerEvents: 'none',
  boxShadow: 'var(--shadow-md, 0 2px 4px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.1))',
  opacity: 0.94,
};

/** Injects the ring pulse (`ak-pin-ring`) and the cue fade (`ak-pin-cue`, `ak-pin-cue-chip`) once. */
export function ensurePinCueKeyframes() {
  if (typeof document === 'undefined' || akStyleDocument.getElementById('ak-pin-cue-kf')) return;
  const s = akStyleDocument.createElement('style');
  s.id = 'ak-pin-cue-kf';
  const clear = 'rgba(var(--bs-primary-rgb, 0, 121, 168),0)';
  s.textContent =
    '@keyframes ak-pin-ring{0%{box-shadow:0 0 0 0 ' + PIN_RING + '}60%{box-shadow:0 0 0 6px ' + clear + '}100%{box-shadow:0 0 0 0 ' + clear + '}}' +
    '@keyframes ak-pin-cue{0%{opacity:0}14%{opacity:1}78%{opacity:1}100%{opacity:0}}' +
    '@keyframes ak-pin-cue-chip{0%{opacity:0;transform:translateY(4px)}14%{opacity:.94;transform:none}78%{opacity:.94;transform:none}100%{opacity:0;transform:none}}';
  akStyleDocument.head.appendChild(s);
}

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

function measure(anchor) {
  if (!anchor) return null;
  if (typeof anchor.getBoundingClientRect === 'function') {
    const r = anchor.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  const { x, y, w, h } = anchor;
  if ([x, y, w, h].some((n) => typeof n !== 'number' || !isFinite(n))) return null;
  return { x, y, w, h };
}

/* What identifies one cue: a rect by its values (a host rebuilds the object every render), an
   element by itself. A change restarts the cue. */
function anchorKey(anchor) {
  if (!anchor) return '';
  if (typeof anchor.getBoundingClientRect === 'function') return anchor;
  return [anchor.x, anchor.y, anchor.w, anchor.h].map((n) => Math.round(n)).join(',');
}

export function PinCue({
  anchor, label = '', open = true, duration = PIN_CUE_MS, onDone, announce = true, reduceMotion, zIndex = 2096,
}) {
  const reduce = reduceMotion != null ? !!reduceMotion : prefersReducedMotion();
  const [cue, setCue] = React.useState(null); // { rect, n } while showing
  const doneRef = React.useRef(onDone);
  doneRef.current = onDone;
  const runs = React.useRef(0);
  const key = anchorKey(anchor);

  React.useEffect(ensurePinCueKeyframes, []);

  React.useLayoutEffect(() => {
    if (!open || !label) { setCue(null); return undefined; }
    const rect = measure(anchor);
    if (!rect || rect.w < 8) { setCue(null); return undefined; }
    runs.current += 1;
    setCue({ rect, n: runs.current });
    /* A non-finite duration holds the cue until the host turns `open` off. */
    if (!isFinite(duration)) return undefined;
    const t = setTimeout(() => {
      setCue(null);
      if (doneRef.current) doneRef.current();
    }, Math.max(0, duration));
    return () => clearTimeout(t);
  }, [open, label, key, duration]);

  const live = announce ? <LiveRegion message={cue ? label : ''} /> : null;
  if (!cue) return live;

  /* A rail's pin sits flush against the viewport edge, so the ring is nudged inward rather
     than half-drawn off-screen, and the chip drops below the control when there is no room
     above it. */
  const { x, y, w, h } = cue.rect;
  const left = Math.round(Math.max(4, x - 3));
  const above = y - 34 >= 4;
  const ms = (isFinite(duration) ? Math.max(0, duration) : PIN_CUE_MS) + 'ms';
  /* Held indefinitely, the ring pulses and settles but does not fade. */
  const fade = isFinite(duration);
  return (
    <React.Fragment>
      {live}
      <span
        key={'ring' + cue.n}
        data-pin-cue-ring=""
        aria-hidden="true"
        style={{
          position: 'fixed', zIndex, pointerEvents: 'none', boxSizing: 'border-box',
          left, top: Math.round(y - 3), width: Math.round(w + 6), height: Math.round(h + 6),
          border: '2px solid var(--bs-primary, #0079a8)', borderRadius: 6,
          boxShadow: reduce ? '0 0 0 3px ' + PIN_RING : 'none',
          animation: reduce ? 'none' : 'ak-pin-ring 1s ease-out 2' + (fade ? ', ak-pin-cue ' + ms + ' ease-out both' : ''),
        }}
      />
      <span
        key={'chip' + cue.n}
        data-pin-cue-chip=""
        aria-hidden="true"
        style={{
          ...PIN_CUE_CHIP_STYLE,
          /* Laid at the page root, so it names its face rather than inheriting one. */
          fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)', lineHeight: 1.5,
          position: 'fixed', zIndex, left, top: Math.round(above ? y - 34 : y + h + 10),
          animation: reduce || !fade ? 'none' : 'ak-pin-cue-chip ' + ms + ' ease-out both',
        }}
      >
        {label}
      </span>
    </React.Fragment>
  );
}
