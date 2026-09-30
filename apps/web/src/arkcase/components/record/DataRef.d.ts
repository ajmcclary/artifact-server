import React from 'react';

export interface DataRefProps {
  /** plain: a coded value · strong: the record's own id · route: the URL pill a
   *  screen wears · absent: italic sans for a value the record does not carry. */
  variant?: 'plain' | 'strong' | 'route' | 'absent';
  /** Content rendered inside the DataRef. */
  children?: React.ReactNode;
  /** Style overrides for the DataRef root. */
  style?: React.CSSProperties;
}

/** A coded value inline in prose — and the one way to draw an absent one. */
export function DataRef(props: DataRefProps): React.JSX.Element;
