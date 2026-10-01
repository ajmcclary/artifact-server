import React from 'react';

export interface GridColumn<T = any> {
  /** Row data key. */
  field: string;
  /** Header label (defaults to field). */
  headerName?: string;
  /** Fixed column width in px. */
  width?: number;
  /** Pin to an edge — stays visible while scrolling horizontally. */
  pinned?: 'left' | 'right';
  /** Cell text alignment. `'right'` also applies `tabular-nums` automatically,
   *  so an aligned column can't ship with proportional digits. */
  align?: 'left' | 'right' | 'center';
  /**
   * Semantic value class. Every value below `'text'` is a coded value and
   * therefore implies the data font (Source Code Pro + tabular-nums):
   * `'id'` record identifiers · `'date'` dates & times · `'money'` currency ·
   * `'count'` counts & durations · `'code'` FEIN/SSN, policy, bar, batch, class ·
   * `'contact'` username, email, hostname, IP.
   * `'text'` (person and organisation names, statuses, free text) stays sans.
   * @default "text"
   */
  type?: 'id' | 'date' | 'money' | 'count' | 'code' | 'contact' | 'text';
  /**
   * Explicit data-font opt-in / opt-out for this column's body cells: applies
   * `var(--font-data)`, `var(--font-numeric-feature)` and `var(--text-data)`
   * (#495057 — clears 4.5:1 on white and on the #F8F9FA zebra row). Overrides
   * whatever `type` implies. Data cells render at the same px as sans cells in
   * the same row (14px), never one step down.
   */
  dataFont?: boolean;
  /** Disable sorting on this column. @default true */
  sortable?: boolean;
  /**
   * How this column's values are ordered when its header is clicked. The default
   * comes from `type`: `'date'` orders chronologically (both `MM/DD/YYYY` and
   * `YYYY-MM-DD`), `'money'` and `'count'` order by magnitude through the currency
   * symbol, thousands separators, `%` and a parenthesised or leading-minus negative,
   * and everything else collates. Values that do not parse sort after those that do,
   * and absent values sort last in both directions.
   *
   * `sortValue` supplies a different sort key than the displayed value — the usual
   * reason is a column whose `cellRenderer` shows something other than the field.
   * `sortComparator` replaces the type's comparator entirely.
   */
  sortValue?: (row: T) => any;
  /** Custom comparator replacing type-based value ordering. */
  sortComparator?: (a: any, b: any) => number;
  /** Override the derived aria-sort, e.g. when the host sorts the rows itself. */
  ariaSort?: 'ascending' | 'descending' | 'none' | 'other';
  /** Custom renderer — return a React node (e.g. a StatusPill or Avatar). */
  cellRenderer?: (value: any, row: T) => React.ReactNode;
  /** Draws each non-empty cell of this column as a link-styled native button (inside the rendered
   *  content, in the column's face) that calls this with the row and the cell's value. Enter or
   *  Space on the focused cell does the same; the click never also fires `onRowClick`. */
  onCellClick?: (row: T, value: any) => void;
  /** Draws each non-empty cell of this column as a native anchor to this destination. Enter or
   *  Space on the focused cell follows it; `onCellClick`, when also set, fires on the click. */
  cellHref?: (row: T) => string;
  /** With `onCellClick` or `cellHref`, decides per row whether the cell is a link; a row it
   *  rejects draws the value as plain text and Enter on the cell activates the row instead.
   *  Use it where only some rows have a destination (a registry record that may not exist). */
  cellLinkable?: (row: T) => boolean;
  /** False keeps the column out of the column chooser, so it can never be hidden. @default true */
  hideable?: boolean;
}

/** An item of a row's action menu — the same shape `Menu` takes. */
export interface DataGridRowAction {
  /** Visible verb. */
  label?: React.ReactNode;
  /** `bi-*` studio icon class. */
  icon?: string;
  /** Runs the verb; the menu closes afterwards. */
  onClick?: () => void;
  /** Destructive verb, drawn in danger ink. */
  danger?: boolean;
  /** Native disabled item. */
  disabled?: boolean;
  /** An uppercase group label in place of an item. */
  heading?: string;
  /** A hairline rule in place of an item. */
  divider?: boolean;
}

export interface DataGridProps<T = any> {
  /** Column definitions, including sort and renderer rules. */
  columns: GridColumn<T>[];
  /** Current rows supplied by the host; the grid does not mutate them. */
  rows: T[];
  /** Toolbar title. */
  title?: string;
  /** Show the leading checkbox-selection column. @default true */
  selectable?: boolean;
  /** Show the quick-filter search box. @default true */
  quickFilter?: boolean;
  /** Extra toolbar nodes on the right (buttons, icon buttons…). */
  toolbarActions?: React.ReactNode;
  /** Show the bottom status bar with row counts. @default true */
  statusBar?: boolean;
  /** Row height in px. @default 40 */
  rowHeight?: number;
  /** Grid height (number px or CSS string). @default "auto" */
  height?: number | string;
  /** Show a polite live-region loading overlay. @default false */
  loading?: boolean;
  /** Accessible name for the grid (falls back to `title`). */
  ariaLabel?: string;
  /** Row activation: called with the row on a click anywhere in the row (except the checkbox
   *  cell and any link, button or field inside a cell), and on Enter or Space on a focused body
   *  cell other than the checkbox cell or a link column. Adds a pointer cursor to body rows. */
  onRowClick?: (row: T) => void;
  /** Shown in the single full-width row when no rows match (and the grid is not loading).
   *  @default "No rows found" */
  empty?: React.ReactNode;
  /** Additional style for the grid root. */
  style?: React.CSSProperties;
  /** With `selectable`, `'multiple'` draws the checkbox column with a select-all header;
   *  `'single'` draws a radio per row, no select-all, and choosing a row replaces the
   *  selection. @default "multiple" */
  selection?: 'multiple' | 'single';
  /** Controlled selection: the `id`s of the selected rows. Given, the grid draws exactly these
   *  and reports every change through `onSelectionChange`; omitted, the grid owns selection.
   *  Rows need a stable `id`. */
  selectedIds?: Array<string | number>;
  /** Initial selection when uncontrolled. */
  defaultSelectedIds?: Array<string | number>;
  /** Called with the next selected ids, and the rows (from `rows`) carrying them, on every
   *  checkbox, radio or select-all change. Select-all adds or removes the rows in view and
   *  leaves selected rows outside the view (filtered, capped or on another page) alone. */
  onSelectionChange?: (ids: Array<string | number>, rows: T[]) => void;
  /** Row verbs: a pinned 60px "Actions" column on the trailing edge draws a kebab IconButton
   *  for every row this returns items for, opening a `Menu` anchored to it. Enter or Space on
   *  the focused actions cell opens it too; focus returns to the cell when it closes. */
  rowActions?: (row: T) => DataGridRowAction[] | null | undefined;
  /** Accessible name of a row's kebab and its menu, e.g. `(row) => 'Actions for ' + row.doc`.
   *  @default "Actions" */
  rowActionsLabel?: (row: T) => string;
  /** Controlled list of hidden column `field`s. Omitted, the grid owns it (from
   *  `defaultHiddenColumns`). */
  hiddenColumns?: string[];
  /** Columns hidden initially when uncontrolled, and the set "Reset to default" restores. */
  defaultHiddenColumns?: string[];
  /** Called with the next hidden fields when the column chooser changes them. */
  onHiddenColumnsChange?: (hidden: string[]) => void;
  /** Draw the "Columns" chooser in the toolbar: a Menu of checkbox items for every column not
   *  marked `hideable: false`, a "shown of total" count, and "Reset to default". An object
   *  renames the button. @default false */
  columnChooser?: boolean | { label?: string };
  /** Show only the first `rowCap` rows (after filtering and sorting) with a footer that says so
   *  — "Showing 10 of 34" — and a toggle to show them all. No footer when the rows fit. */
  rowCap?: number;
  /** Controlled expansion of the row cap. Omitted, the grid owns it. */
  rowCapExpanded?: boolean;
  /** Called with the next expansion when the cap toggle is pressed. */
  onRowCapExpandedChange?: (expanded: boolean) => void;
  /** The cap toggle's two labels, as text or built from the count.
   *  @default { more: "Show all {total}", less: "Show first {cap}" } */
  rowCapLabels?: { more?: string | ((total: number) => string); less?: string | ((cap: number) => string) };
  /** Footer content under the rows, in the same secondary band as the cap note (trailing when
   *  both are present) and above the status bar: a note, a link, a pager. */
  footer?: React.ReactNode;
}

export interface DataGridColumnChooserProps {
  /** Every column the grid knows, in order; `hideable: false` columns are not listed. */
  columns: GridColumn[];
  /** The hidden column fields. @default [] */
  hiddenColumns?: string[];
  /** Called with the next hidden fields. The last visible column cannot be hidden. */
  onChange?: (hidden: string[]) => void;
  /** Given, a "Reset to default" item closes the menu and calls this. */
  onReset?: () => void;
  /** Button text, menu heading and menu name. @default "Columns" */
  label?: string;
  /** Text of the reset item. @default "Reset to default" */
  resetLabel?: string;
  /** Style for the chooser's wrapper. */
  style?: React.CSSProperties;
}

/**
 * Enterprise data grid — the app's signature surface. Sortable headers,
 * checkbox selection, pinned columns, zebra-striped rows (every 2nd body row
 * on #F8F9FA), cyan hover, quick filter, status bar. Use `cellRenderer` to drop
 * in StatusPill / Avatar / links.
 *
 * Data font: set `type` or `dataFont` on a column rather than writing
 * `font-family: 'Source Code Pro', monospace` inline — the bare `monospace`
 * keyword drops `--font-data`'s named fallbacks and reintroduces cross-OS
 * column misalignment.
 *
 * Selection can be controlled (`selectedIds` / `onSelectionChange`) and single
 * (`selection="single"`). `rowActions` adds a pinned kebab column; `columnChooser`
 * and `hiddenColumns` hide columns; `rowCap` shows the first rows with a
 * "Showing n of N" footer; `footer` adds a note band under the rows.
 *
 * Keyboard: Tab into the grid, then arrow keys / Home / End / Ctrl+Home /
 * Ctrl+End to move between cells; Enter or Space sorts a header, toggles a
 * selection checkbox or radio, opens a row's action menu, follows a link
 * column's link or activates the row (`onRowClick`). A button or link the host renders inside a cell keeps its own
 * Enter and Space. Headers expose `aria-sort`; the grid announces row-count
 * and loading changes via a polite live region.
 *
 * @startingPoint section="Data Grid" subtitle="AG-Grid-style enterprise table" viewport="1100x520"
 */
export function DataGrid<T = any>(props: DataGridProps<T>): React.JSX.Element;

/**
 * The "Columns" button and its checkbox Menu. DataGrid draws one with `columnChooser`; mount it
 * directly when the host lays out its own toolbar, and pass the same hidden fields to the grid's
 * `hiddenColumns`.
 */
export function DataGridColumnChooser(props: DataGridColumnChooserProps): React.JSX.Element;

/** Whether a column renders its values in the data font (`dataFont`, else `type`). */
export function usesDataFont(col: GridColumn): boolean;
/** Comparator selected from a column's declared type or custom sortComparator. */
export function comparatorFor(col: GridColumn): (a: unknown, b: unknown) => number;
