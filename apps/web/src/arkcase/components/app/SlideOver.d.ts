import React from 'react';

export interface SlideOverProps {
  /** Visible title for the SlideOver. */
  title?: React.ReactNode;
  /** What the panel is currently pointed at — a widget kind, a record id. */
  subtitle?: React.ReactNode;
  /** Rendered before the title block — a Back button when the pane has drilled into one item. */
  leading?: React.ReactNode;
  /** Rendered inline right after the title text — a count badge. It never truncates; the title does. */
  titleMeta?: React.ReactNode;
  /** Header controls before the close button — a pane-level command such as a Compare IconButton. */
  actions?: React.ReactNode;
  /** Called when the SlideOver requests dismissal. */
  onClose?: () => void;
  /** @default "Close" */
  /** Accessible name for the close control. */
  closeLabel?: string;
  /** Sticky footer band — the panel's commit action, if it has one. */
  footer?: React.ReactNode;
  /** @default 320 */
  /** Requested width of the SlideOver. `"100%"` fills the parent — full width and height, no edge rule — for use inside a `Panel`. */
  width?: number | string;
  /** Which edge it docks to. @default "end" */
  side?: 'start' | 'end';
  /** Phone form: the pane covers the viewport — fixed, inset 0, no edge rule. @default false */
  fullscreen?: boolean;
  /** Stacking order while `fullscreen`. @default 1040 */
  zIndex?: number;
  /** Style overrides for the SlideOver root. */
  style?: React.CSSProperties;
  /** Style overrides for the scrollable body. */
  bodyStyle?: React.CSSProperties;
  /** Content rendered inside the SlideOver. */
  children?: React.ReactNode;
}

/**
 * A panel docked beside the content, not over it — inspector, library, details.
 * Reach for Modal only when the answer must come before anything else.
 */
export function SlideOver(props: SlideOverProps): React.JSX.Element;
