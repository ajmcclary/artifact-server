import React from 'react';

export interface SpinnerProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'style' | 'children'> {
  /** Ring diameter in px. @default 22 */
  size?: number;
  /** Spoken busy text, e.g. "Signing you in"; makes the spinner a polite `status`. Omit when adjacent text already says what is happening — the ring is then aria-hidden. */
  label?: string;
  /** Style overrides for the Spinner root. */
  style?: React.CSSProperties;
}

/** Indeterminate busy ring; slows (never stops) under reduced motion. */
export function Spinner(props: SpinnerProps): React.JSX.Element;
