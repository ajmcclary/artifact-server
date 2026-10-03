import React from 'react';

export interface LinkRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title' | 'style' | 'onSelect'> {
  /** `bi-*` icon class before the title. */
  icon?: string;
  /** Glyph ink: `link` for a starter or destination, `muted` (`text-secondary`) for a history row. @default "link" */
  iconTone?: 'link' | 'muted';
  /** What the row runs or opens — part of the control's accessible name. */
  title: React.ReactNode;
  /** A summary line under the title (12px, 11px compact, `text-secondary`). */
  description?: React.ReactNode;
  /** A trailing count in the data face: 14px/600 `text-link-hover`, or 18px `text-body` over `countLabel`. */
  count?: React.ReactNode;
  /** Small line under the count, e.g. "matches"; switches the count to the stacked 18px form. */
  countLabel?: React.ReactNode;
  /** Draws a trailing `bi-chevron-right` to say the row navigates. @default false */
  chevron?: boolean;
  /** Trailing controls (ghost `IconButton`s) beside the row's own button — never inside it. */
  actions?: React.ReactNode;
  /** Runs or opens the row; the row is a native button. */
  onSelect?: (event: React.MouseEvent<HTMLElement>) => void;
  /** Makes the row's control a link to this URL instead of a button. */
  href?: string;
  /** `comfortable` fills a card edge to edge (10px × 14px, divider); `compact` is a rounded 6px row for a popover or padded list (no divider). @default "comfortable" */
  density?: 'comfortable' | 'compact';
  /** Draws the `list-divider` hairline under the row. @default true when comfortable, false when compact */
  divider?: boolean;
  /** Title ink: `link` (600, link colour, underline on hover) or `body`. @default "link" with a description, "body" without */
  tone?: 'link' | 'body';
  /** Marks the current row: `tint-primary-selected` fill and `aria-current="true"`. @default false */
  selected?: boolean;
  /** With `selected`, draws the 3px `list-rail` mark on the start edge — the current row of a picker list. @default false */
  rail?: boolean;
  /** Accessible name of the row's control when its visible title does not read as one ("Open page Receipt · Default page"). */
  ariaLabel?: string;
  /** Style overrides for the row root. */
  style?: React.CSSProperties;
}

/** A full-width row that runs or opens something: icon, title and summary, count, chevron, trailing actions. */
export function LinkRow(props: LinkRowProps): React.JSX.Element;
