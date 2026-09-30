import React from 'react';

export interface DividerProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'children'> {
  /** Short label, e.g. "or"; shown uppercase and used as the separator's accessible name. Horizontal only. */
  label?: string;
  /** `center` puts the label between two rules; `start` puts it first, 8px before one rule filling the rest (a section rule). Only with `label`. @default 'center' */
  labelAlign?: 'center' | 'start';
  /** `horizontal` spans the row; `vertical` stretches to the height of a flex row. @default 'horizontal' */
  orientation?: 'horizontal' | 'vertical';
  /** `default` is `border-color`, `strong` is `border-color-strong`, `list` is the lighter `list-divider`. @default 'default' */
  tone?: 'default' | 'strong' | 'list';
  /** Style overrides for the Divider root, e.g. margins. */
  style?: React.CSSProperties;
}

/** Hairline separator, optionally labelled. */
export function Divider(props: DividerProps): React.JSX.Element;
