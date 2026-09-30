import React from 'react';

/** One line of a diff. */
export interface DiffLine {
  /** `+` added, `-` removed, `~` changed, `' '` unchanged context. */
  mark: '+' | '-' | '~' | ' ';
  /** Line number shown right-aligned; spoken as "line n" (neither when `numbered` is false). */
  n?: number | string;
  /** The line's text; whitespace is preserved. */
  text: string;
}

export interface DiffLinesProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'children'> {
  /** Lines in display order. */
  lines: DiffLine[];
  /** Content shown in secondary text when `lines` is empty, e.g. "No text changes recorded for this path." */
  empty?: React.ReactNode;
  /** Show the line-number column. `false` drops the column (a two-column mark/text grid) for change summaries without numbers. @default true */
  numbered?: boolean;
  /** Accessible name; makes the diff a named region and a tab stop so a wide diff can be scrolled by keyboard. */
  label?: string;
  /** Style overrides for the DiffLines root. */
  style?: React.CSSProperties;
}

/** Changed-lines view with added/removed/changed tints and spoken change marks. */
export function DiffLines(props: DiffLinesProps): React.JSX.Element;
