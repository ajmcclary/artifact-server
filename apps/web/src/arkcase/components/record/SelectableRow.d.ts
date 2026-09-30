import React from 'react';

export interface SelectableRowProps extends Omit<React.HTMLAttributes<HTMLElement>, 'onSelect'> {
  /** Lights the 3px rail and tints the row; sets aria-current. */
  selected?: boolean;
  /** Called on click, Enter and Space. */
  onSelect?: (e: React.SyntheticEvent) => void;
  /** Drops the role and the tab stop and sets aria-disabled. */
  disabled?: boolean;
  /** The element to render; `"button"` renders a native button (no role or tabIndex, native `disabled`). @default "div" */
  as?: keyof React.JSX.IntrinsicElements;
  /** Accessible name, when the body does not read as one. */
  label?: string;
  /** @default "10px 16px" */
  /** Internal padding applied to the selectable row. */
  padding?: string | number;
  /** false for a row inside a component that draws its own rail. @default true */
  rail?: boolean;
  /** Persistent status rail colour, shown selected or not; selection is then read from the tint and aria-current. */
  tone?: 'success' | 'danger' | 'warning' | 'primary' | 'neutral' | 'info' | 'muted';
  /** Literal CSS colour for the persistent rail; wins over `tone`. */
  railColor?: string;
  /** The 5% `tint-primary-hover` wash under the pointer. It shows only on an interactive row (`onSelect` or `onClick`) that is neither disabled nor selected; `false` opts out, e.g. inside a host that draws its own hover. @default true */
  hover?: boolean;
  /** Style overrides for the SelectableRow root. */
  style?: React.CSSProperties;
  /** Content rendered inside the SelectableRow. */
  children?: React.ReactNode;
}

/** The one selectable list row: rail, tint, and a button's keyboard. */
export function SelectableRow(props: SelectableRowProps): React.JSX.Element;
