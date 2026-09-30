import React from 'react';

export interface TooltipProps {
  /** The control's name — a noun phrase, not a sentence. */
  label: React.ReactNode;
  /** Preferred edge for the tooltip relative to its trigger. `end` sits above with right edges aligned; `bottom-end` sits below with right edges aligned, for a control at the top-right of a rail. @default "top" */
  placement?: 'top' | 'bottom' | 'end' | 'bottom-end' | 'right' | 'left';
  /** Wraps to 236px — for the rare tooltip that is a sentence. @default false */
  wide?: boolean;
  /**
   * Positions against the viewport so the tooltip can escape a scrolling or
   * clipped rail. @default false
   */
  fixed?: boolean;
  /** The trigger whose hover and focus reveal the tooltip. */
  children?: React.ReactNode;
  /** Style overrides for the Tooltip root. */
  style?: React.CSSProperties;
}

/** Names an icon-only control. Shows on hover and keyboard focus. */
export function Tooltip(props: TooltipProps): React.JSX.Element;
