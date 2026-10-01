import * as React from 'react';

export interface ScrollDockState {
  /** True from the moment the element's top meets the scroller's. */
  docked: boolean;
}

export interface ScrollDockProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'style'> {
  /** A node, or a function of `{ docked }` so the header can condense as it docks. */
  children?: React.ReactNode | ((state: ScrollDockState) => React.ReactNode);
  /** Sticky offset from the scroller's top, in px. Default 0. */
  top?: number;
  /** Stacking level of the docked header. */
  zIndex?: number;
  /** Horizontal gutter to cancel, in px: negative margin out, equal padding back in. */
  bleed?: number;
  /** Scroll offset, in px, the scroller must pass before the element can count as docked. Default 1. */
  threshold?: number;
  /** The surface painted behind the dock. Default `var(--surface-card, #fff)`. */
  surface?: string;
  /** The shadow painted once docked. */
  shadow?: string;
  /** Style merged in only while docked. */
  dockedStyle?: React.CSSProperties;
  /** Reports when the header starts or stops docking. */
  onDockChange?: (docked: boolean) => void;
  /** Turns the dock off: no sticky, no listener, `docked` stays false. */
  disabled?: boolean;
  /** Style overrides for the ScrollDock root. */
  style?: React.CSSProperties;
}

/** A header that sticks to its scroller's top edge and reports when it did. */
export declare function ScrollDock(props: ScrollDockProps): React.JSX.Element;
