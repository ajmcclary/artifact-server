import React from 'react';

/** A viewport rect in CSS pixels — what `getBoundingClientRect()` gives as left/top/width/height. */
export interface PinCueRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PinCueProps {
  /** The control the cue marks: an element (measured when the cue starts) or its viewport rect. A change restarts the cue. */
  anchor?: Element | PinCueRect | null;
  /** What the control now does — "Unpin the menu". Drawn in the chip and, unless `announce` is false, announced politely. */
  label?: string;
  /** Show the cue. Turning it on, or changing `label` or `anchor` while on, starts a new one. @default true */
  open?: boolean;
  /** How long the ring and chip stay, in milliseconds. The ring pulses twice within the first two seconds. `Infinity` holds the cue (no fade) until `open` goes false. @default 2000 */
  duration?: number;
  /** Fires once when `duration` elapses; the host clears its cue state here. */
  onDone?: () => void;
  /** Announce `label` through a polite live region. Pass false when the host already says "Menu pinned.". @default true */
  announce?: boolean;
  /** Force the reduced-motion presentation (a steady halo, no pulse or fade). Defaults to `prefers-reduced-motion`. */
  reduceMotion?: boolean;
  /** Stacking order of the fixed ring and chip. @default 2096 */
  zIndex?: number;
}

/**
 * The two-second cue after a pin toggles: a fixed-position ring pulsing over the control's
 * new home and a navy chip beside it naming what the control now does. Visual parts are
 * `aria-hidden`; the label is announced politely unless `announce={false}`. Shares its ring,
 * pulse and chip with `Panel`'s own pin cue.
 */
export function PinCue(props: PinCueProps): React.JSX.Element | null;

/** Cue length shared with `Panel`. */
export const PIN_CUE_MS: number;
/** The ring colour on the brand primary, shared with `Panel`. */
export const PIN_RING: string;
/** The chip's visual style, shared with `Panel`'s footer cue. */
export const PIN_CUE_CHIP_STYLE: React.CSSProperties;
/** Injects the `ak-pin-ring`, `ak-pin-cue` and `ak-pin-cue-chip` keyframes once. */
export function ensurePinCueKeyframes(): void;
/** Whether the user asked for reduced motion. */
export function prefersReducedMotion(): boolean;
