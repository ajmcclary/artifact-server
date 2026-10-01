import React from 'react';

export interface RowSummaryProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** The row's name, 14px/600, wrapping. */
  title: React.ReactNode;
  /** At the title's end: a string or number is drawn in the data face at 11px ("v7"); a node (an Archived pill) as given. */
  meta?: React.ReactNode;
  /** The second line: strings in 12px secondary ink, nodes (a CountBadge) as given, in order. Falsy entries are skipped. */
  detail?: React.ReactNode | React.ReactNode[];
  /** Style overrides for the summary root. */
  style?: React.CSSProperties;
}

/**
 * The two-line body of a list row — title with a data-face meta at its end, then badges and a
 * secondary fact — for the caller-owned body of a `SelectableRow`.
 *
 * @startingPoint section="Record surface" subtitle="Two-line body of a list row" viewport="340x200"
 */
export function RowSummary(props: RowSummaryProps): React.JSX.Element;
