import React from 'react';

export interface ActiveFilter {
  /** Stable key for the chip, e.g. "type:template". */
  id: string;
  /** What the filter keeps, e.g. a project's name or "Templates". */
  label: React.ReactNode;
  /** `bi-*` glyph before the label, e.g. the filter menu's own icon. */
  icon?: string;
  /** Removes this one filter; focus then moves to the chip that takes its place. */
  onRemove: () => void;
  /** Accessible name of the chip. @default "Remove {label} filter" */
  removeLabel?: string;
}

export interface ActiveFiltersProps {
  /** One removable chip per applied filter, in the order the toolbar's menus list them. @default [] */
  filters?: ActiveFilter[];
  /** Whether the view is narrowed; a search query narrows it without a chip. @default filters.length > 0 */
  filtered?: boolean;
  /** The count while narrowed, e.g. "Showing 3 of 12 previews"; set figures in the data face. */
  status?: React.ReactNode;
  /** What `live` speaks at rest, e.g. "Showing all 12 entries"; never shown. */
  restStatus?: React.ReactNode;
  /** Keep the count mounted as a polite `role="status"` (visually hidden at rest), so every change is spoken. @default false */
  live?: boolean;
  /** Clears every filter; omit it to hide Clear filters. */
  onClear?: () => void;
  /** Text of the clear link. @default "Clear filters" */
  clearLabel?: string;
  /** Where focus goes when nothing in the row is left to take it (the last chip removed, or Clear filters pressed): the element itself if focusable, else its first button or field — e.g. the first filter menu. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  /** Style overrides for the row. */
  style?: React.CSSProperties;
}

/**
 * The row under a toolbar while a view is narrowed: the count, a removable chip per filter and
 * Clear filters, with focus kept on the row as chips are removed.
 *
 * @startingPoint section="Actions" subtitle="Applied filters as removable chips" viewport="560x120"
 */
export function ActiveFilters(props: ActiveFiltersProps): React.JSX.Element | null;
