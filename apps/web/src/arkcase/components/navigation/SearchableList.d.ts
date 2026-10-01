import React from 'react';

export interface SearchableListItem {
  /** Stable identity, reported by `onSelect` and compared with `selected`. */
  id: string;
  /** The row's title — text, or a node such as a version number beside its author. */
  title: React.ReactNode;
  /** The second line, e.g. a path in the data face or a date. */
  description?: React.ReactNode;
  /** The group the row is listed under; rows keep the order given within it. */
  group?: string;
  /** `bi-*` studio icon class leading the row, in the muted tone. */
  icon?: string;
  /** Trailing marks before the check, e.g. a "Current" StatusPill. */
  meta?: React.ReactNode;
  /** Accessible name of the row when its visible text does not read as one. */
  ariaLabel?: string;
}

export interface SearchableListProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  /** Accessible name of the list region, e.g. "Pages". */
  label: string;
  /** The rows matching the current query, already filtered by the host. */
  items?: SearchableListItem[];
  /** The `id` of the selected row: tint, rail, check and `aria-current`. */
  selected?: string | null;
  /** Called with the row's id and item when a row is chosen. */
  onSelect?: (id: string, item: SearchableListItem) => void;
  /** The search text the host filtered `items` by. @default "" */
  query?: string;
  /** Called with the new search text; supplying it shows the search field. */
  onQueryChange?: (query: string) => void;
  /** Shows or hides the search field regardless of `onQueryChange`. @default !!onQueryChange */
  searchable?: boolean;
  /** Visible label of the search field. @default "Search" */
  searchLabel?: string;
  /** Placeholder of the search field, naming what it matches ("Name or path"). */
  searchPlaceholder?: string;
  /** 44px search field for a phone sheet. @default false */
  touch?: boolean;
  /** Rows listed above the search results and unaffected by the query (a Gallery entry, "Automatic"). */
  pinned?: SearchableListItem[];
  /** The band text for a group, e.g. a folder group read as a path ("project/"). @default the group itself */
  groupLabel?: (group: string) => React.ReactNode;
  /** Group the rows under bands. @default true when the shown rows span more than one group */
  grouped?: boolean;
  /** Bands stay put while the list scrolls. @default true */
  stickyGroups?: boolean;
  /** Render at most this many matching rows; the rest wait for Load more. */
  limit?: number;
  /** Called by the Load more button, shown while matches exceed `limit`. */
  onLoadMore?: () => void;
  /** Label of the Load more button. @default "Load more" */
  loadMoreLabel?: string;
  /** The unfiltered count the footer reports against. @default items.length */
  total?: number;
  /** The footer's count text from the shown, total and matching counts. @default "{shown} of {total} {noun}" */
  countLabel?: (shown: number, total: number, matching: number) => React.ReactNode;
  /** Plural noun for the count, the empty state and the announcement. @default "items" */
  noun?: string;
  /** Controls at the end of the footer, e.g. a link to a fuller panel. */
  footer?: React.ReactNode;
  /** Content under the footer, e.g. a notice that belongs to the picker. */
  after?: React.ReactNode;
  /** Empty-state title when no row matches. @default "No matches" */
  emptyTitle?: string;
  /** Empty-state body, saying what the search covers. */
  emptyBody?: string;
  /** Maximum height of the scrolling rows. @default "min(50vh, 320px)" */
  maxHeight?: number | string;
  /** Draw a check on the selected row. @default true */
  check?: boolean;
  /** Each query change is announced here with the matching count. */
  onAnnounce?: (text: string) => void;
  /** Style overrides for the list root. */
  style?: React.CSSProperties;
}

/**
 * The picker body: a search field, rows pinned above it, matching rows under sticky group
 * bands, Load more, and a footer that counts what is shown. The host filters `items` for its
 * `query`; the selected row takes the tint, the rail and a check.
 *
 * @startingPoint section="Navigation" subtitle="Searchable picker list with groups and paging" viewport="420x420"
 */
export function SearchableList(props: SearchableListProps): React.JSX.Element;
