import React from 'react';

export interface AnnotationPinProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style' | 'onClick'> {
  /** The thread's number as the reader sees it, drawn in the data face. Ignored while `pending`. */
  n?: number | string;
  /** Horizontal position in percent (0–100) of the positioned parent; the pin is centred on it. @default 50 */
  x?: number;
  /** Vertical position in percent (0–100) of the positioned parent; the pin is centred on it. @default 50 */
  y?: number;
  /** The thread in focus: 26px, filled with the primary, `aria-pressed="true"` when clickable. @default false */
  selected?: boolean;
  /** The point a new comment will attach to: a 24px dashed ring with a location glyph, `aria-hidden` and inert. @default false */
  pending?: boolean;
  /** A resolved thread: neutral ring and text instead of the primary. @default false */
  resolved?: boolean;
  /** Accessible name, e.g. "Annotation 1 by Dana". The number alone is not a useful name. */
  label?: string;
  /** Selects the pin's thread. Without it the pin is still a button but has no pressed state. */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Style overrides for the pin root. */
  style?: React.CSSProperties;
}

/** A numbered annotation marker placed at percent coordinates inside a positioned preview. */
export declare function AnnotationPin(props: AnnotationPinProps): React.JSX.Element;

/** A point in percent of the PickLayer, rounded to 0.1. */
export interface PickPoint {
  /** Percent across, 0–100. */
  x: number;
  /** Percent down, 0–100. */
  y: number;
}

export interface PickLayerProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'onKeyDown' | 'onClick'> {
  /** Receives the chosen point in percent; Enter or Space picks the centre `{ x: 50, y: 50 }`. */
  onPick?: (point: PickPoint) => void;
  /** Called on Escape — the host leaves picking mode. */
  onCancel?: () => void;
  /** Accessible name of the overlay. @default "Choose a point" */
  label?: string;
  /** Moves focus to the layer when it mounts, so the keyboard can pick at once. @default false */
  autoFocus?: boolean;
  /** Style overrides for the overlay. */
  style?: React.CSSProperties;
}

/** The crosshair overlay that turns a click on a preview into percent coordinates for a new pin. */
export declare function PickLayer(props: PickLayerProps): React.JSX.Element;
