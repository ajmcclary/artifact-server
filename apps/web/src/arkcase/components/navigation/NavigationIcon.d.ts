import React from 'react';
export interface NavigationIconProps {
  /** Studio compatibility class. Uses the navigation rendition when available. @default "bi-circle" */
  icon?: string;
  /** Optional style overrides. Leave color unset for the Portal-matched Studio duotone. */
  style?: React.CSSProperties;
}
/** Shared 20px glyph for labelled, rail and mobile route controls. Not a button. */
export function NavigationIcon(props: NavigationIconProps): React.JSX.Element;
