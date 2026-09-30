import React from 'react';
export interface ShortcutKeyProps {
  /** Key names or keycap contents, in reading order. Does not install a shortcut. */
  children?: React.ReactNode;
  /** Spoken equivalent for symbolic key names, e.g. Command K. */
  label?: string;
  /** Style overrides for the hint. */
  style?: React.CSSProperties;
}
/** Read-only keyboard hint for menus, toolbars and shortcut documentation. */
export function ShortcutKey(props: ShortcutKeyProps): React.JSX.Element;
