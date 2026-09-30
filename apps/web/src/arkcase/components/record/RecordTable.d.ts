import React from 'react';

export interface RecordTableColumn {
  /** Column cap text. */
  label?: React.ReactNode;
  /** Key read off each row when rows are objects rather than arrays. */
  key?: string;
  /** Grid track — '210px', 'minmax(0, 1fr)'. Defaults to an equal fraction. */
  width?: string;
  /** Cell and cap alignment. @default "left" */
  align?: 'left' | 'center' | 'right';
  /** Render this whole column in the data font. */
  mono?: boolean;
}

export interface RecordTableCell {
  /** The cell's content; null or undefined draws an italic em dash in `text-secondary`. */
  value?: React.ReactNode;
  /** Data font for this cell only. */
  mono?: boolean;
  /** Tinted count / verdict cell. */
  tone?: 'success' | 'primary' | 'warning' | 'danger' | 'neutral';
  /** Semibold weight for the value. */
  strong?: boolean;
  /** Secondary ink for a value that reads as metadata. */
  muted?: boolean;
  /** Italic — a value the record does not carry. */
  absent?: boolean;
  /** Makes the value a link-styled native button that calls this; in a selectable row, clicking it does not select the row. */
  onClick?: (event: React.MouseEvent) => void;
  /** Makes the value a native anchor to this destination; `onClick` still fires. */
  href?: string;
}

export interface RecordTableProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style'> {
  /** Column headings and cell accessors for the ledger. @default [] */
  columns?: RecordTableColumn[];
  /** Rows as cell arrays, or as objects keyed by each column's own key. A cell
   *  may be a plain value, a React node, or a RecordTableCell; a null cell draws
   *  an italic em dash rather than an empty box. @default [] */
  rows?: Array<Array<React.ReactNode | RecordTableCell> | Record<string, any>>;
  /** Footer note — the rule that reads the table. Sits outside the scroll box. */
  footer?: React.ReactNode;
  /** Accessible name for the table element (`role="table"`; `grid` when rows are selectable, `treegrid` when they also expand). */
  ariaLabel?: string;
  /** Pin the caps row to the top of the scroll box (`maxHeight`) or of the nearest scrolling ancestor. @default false */
  stickyHeader?: boolean;
  /** Height of the vertical scroll box around the table (px or CSS length). Omitted, the table grows with its rows. */
  maxHeight?: number | string;
  /** Minimum table width; a narrower container scrolls horizontally (`overflow-x: auto`). */
  minWidth?: number | string;
  /** Shown in one full-width row when `rows` is empty. Omitted, an empty table draws only its caps. */
  empty?: React.ReactNode;
  /** Stable key for a row, matched against `selectedKey`. @default the row index */
  rowKey?: (row: any, index: number) => string | number;
  /** Key of the selected row; the host owns it. */
  selectedKey?: string | number | null;
  /** Makes rows selectable: called on click, Enter and Space. ArrowUp, ArrowDown, Home and End move focus between rows. */
  onRowSelect?: (row: any, index: number) => void;
  /** Extra attributes (typically `data-*`) spread onto each row element. */
  rowProps?: (row: any, index: number) => Record<string, any> | null | undefined;
  /** Content for a full-width detail row directly under the selected row; the row reports it with aria-expanded and aria-controls. Needs `onRowSelect`. */
  renderDetail?: (row: any, index: number) => React.ReactNode;
  /** Style overrides for the RecordTable root. */
  style?: React.CSSProperties;
  /** Zebra rows: every second body row on `surface-secondary`. Hover and selection still show on a striped row; a toned row keeps its tone. @default false */
  striped?: boolean;
  /** A whole-row tone: a wash across the row and a hairline of the same family under it, e.g. the audit ledger's denied event (`'danger'`). Return null for an ordinary row. */
  rowTone?: (row: any, index: number) => 'danger' | 'warning' | 'success' | 'primary' | null | undefined;
  /** The totals row, in the same shape as a row (cell array or keyed object): drawn after the body in its own row group, under a 2px navy rule, on `surface-secondary`, semibold (a cell with `strong: false` opts out). Empty or null cells stay blank. */
  totals?: Array<React.ReactNode | RecordTableCell> | Record<string, any>;
  /** `'strong'` is the report ledger's cap: a 2px navy rule under unfilled caps. @default "default" */
  headerRule?: 'default' | 'strong';
  /** Pin the first column to the left edge while a narrow container scrolls the ledger horizontally (pair with `minWidth`) — the phone ledgers. The pinned cells stay opaque: card, stripe, hover, selection and tone washes are laid over the card. @default false */
  stickyFirstColumn?: boolean;
}

/**
 * The dense record table: micro caps, 13px rows, coded values in the data font,
 * tinted count cells, an italic em dash for an absent value. ARIA table semantics;
 * optional sticky caps, scroll box, empty row, link cells, and selectable rows with
 * an inline detail row. The report ledger adds `striped`, a `totals` row, whole-row
 * `rowTone` and `headerRule="strong"`; phones pin the first column with `stickyFirstColumn`.
 */
export function RecordTable(props: RecordTableProps): React.JSX.Element;
