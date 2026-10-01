import React from 'react';

export interface SkeletonLinesProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** One bar per entry, each its width (CSS length or px). @default ['72%', '58%', '64%', '41%'] */
  lines?: Array<number | string>;
  /** Bar height in px. @default 10 */
  height?: number;
  /** Gap between bars in px. @default 8 */
  gap?: number;
  /** Style overrides for the column. */
  style?: React.CSSProperties;
}

/**
 * Rounded `list-divider` bars standing in for lines of text — a page sketch or a loading row.
 * Decorative and hidden from assistive technology.
 *
 * @startingPoint section="Feedback" subtitle="Placeholder bars for lines of text" viewport="420x140"
 */
export function SkeletonLines(props: SkeletonLinesProps): React.JSX.Element;
