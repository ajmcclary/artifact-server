import React from 'react';

/** One line of a diff. */
export interface DiffLine {
  /** `+` added, `-` removed, `' '` unchanged context. */
  mark: '+' | '-' | ' ';
  /** Line number shown right-aligned; spoken as "line n". */
  n?: number | string;
  /** The line's text; whitespace is preserved. */
  text: string;
}

export interface DiffLinesProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'children'> {
  /** Lines in display order. */
  lines: DiffLine[];
  /** Content shown in secondary text when `lines` is empty, e.g. "No text changes recorded for this path." */
  empty?: React.ReactNode;
  /** Accessible name; makes the diff a named region and a tab stop so a wide diff can be scrolled by keyboard. */
  label?: string;
  /** Style overrides for the DiffLines root. */
  style?: React.CSSProperties;
}

/** Changed-lines view with added/removed tints and spoken change marks. */
export function DiffLines(props: DiffLinesProps): React.JSX.Element;
