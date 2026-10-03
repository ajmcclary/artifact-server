import React from 'react';

export interface LoadMoreProps extends React.HTMLAttributes<HTMLDivElement> {
  /** How many items are shown now. */
  shown?: number;
  /** How many there are in all; nothing renders once `shown` reaches it. */
  total?: number;
  /** Plural noun for the count line ("actions"); with `total`, it turns the count on. */
  noun?: string;
  /** Batch size, for the default label "Load {min(step, remaining)} more". */
  step?: number;
  /** Reveals the next batch. */
  onLoadMore?: () => void;
  /** The step's label, e.g. "Show 4 Older". @default "Load {n} more" with `step`, else "Load more" */
  label?: string;
  /** `bi-*` icon class leading the label. @default "bi-chevron-down" */
  icon?: string;
  /** Show the "{shown} of {total} {noun}" count line. @default true when `noun` and `total` are given */
  count?: boolean;
  /** A band at the foot of a ledger: a hairline above and 10px × 14px padding. @default false */
  divided?: boolean;
  /** Style overrides for the root. */
  style?: React.CSSProperties;
}

/**
 * The end of a list that pages: the count of what is shown and an outline step that reveals
 * the next batch; nothing renders once everything is shown.
 *
 * @startingPoint section="Actions" subtitle="Count and next-batch step at the end of a paged list" viewport="460x120"
 */
export function LoadMore(props: LoadMoreProps): React.JSX.Element | null;
