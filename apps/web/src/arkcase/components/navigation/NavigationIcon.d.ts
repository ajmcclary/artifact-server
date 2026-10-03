import React from 'react';
export interface NavigationIconProps {
  /** Compatibility class from icon-map.json. @default "bi-circle" */
  icon?: string;
  /** The route is current: draws the filled (Bold) pair. @default false */
  active?: boolean;
  /** Optional style overrides. Colour follows the parent's text colour. */
  style?: React.CSSProperties;
}
/** Shared 20px glyph for labelled, rail and mobile route controls. Not a button. */
export function NavigationIcon(props: NavigationIconProps): React.JSX.Element;
