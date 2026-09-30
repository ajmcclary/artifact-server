import React from 'react';

export interface FieldGridField {
  /** Uppercase noun phrase — "Date of Injury", "Insurance Carrier". */
  label: React.ReactNode;
  /** The field's value; `null`, `undefined` or `''` draws the em dash (or `absent`). */
  value?: React.ReactNode;
  /** Coded value — identifier, date, amount, code, contact string. */
  mono?: boolean;
  /** Spans two columns. */
  wide?: boolean;
  /** Override the value color — overdue, due-soon, danger. */
  tone?: string;
  /** Text for a value nothing recorded, drawn in italic sans (`DataRef variant="absent"`) in place of the em dash — "not recorded". */
  absent?: string;
  /** `bi-*` studio glyph drawn before the label in the label's ink, e.g. "bi-person". Decorative. */
  icon?: string;
  /** A secondary line under the value, 12px sans — "Registry now: 412 Main St", "Recorded 08/12/2026", a field error. */
  note?: React.ReactNode;
  /** Ink of `note`: `default` is `text-secondary`; `warning`, `danger` and `success` use the pill foregrounds (drift, an error, a confirmation). @default "default" */
  noteTone?: 'default' | 'warning' | 'danger' | 'success';
  /** This field's value weight — `normal` 400, `medium` 500, `strong` 600 — overriding the grid's `valueWeight` and applying to a coded (`mono`) value too, e.g. the one date that must stand out ("Response Due"). Ignored by `size="summary"`, whose values are always 600. */
  weight?: 'normal' | 'medium' | 'strong';
  /** DOM id on the field's cell (stacked), row (divided inline) or value (inline) — a focus or scroll target, e.g. for an error summary. */
  id?: string;
}

export interface FieldGridProps extends Omit<React.HTMLAttributes<HTMLElement>, 'style' | 'children'> {
  /** Label-and-value fields drawn in the grid. */
  fields?: FieldGridField[];
  /** Number of columns before a wide field spans them. In the `inline` layout, the number of label/value pairs per row (1 or 2). @default 2 (stacked), 1 (inline), 3 (summary) */
  columns?: number;
  /** `stacked` sets the uppercase label over its value; `inline` sets a 13px label beside it in a `max-content minmax(0,1fr)` grid — the dense key/value list of a side panel. @default "stacked" */
  layout?: 'stacked' | 'inline';
  /** `summary` is the fact block that heads a reading: an 11px label over a 14px/600 data-face value, three columns dropping to two below a 720px container. @default "default" */
  size?: 'default' | 'summary';
  /** Container width in px below which the grid drops to one field (or one pair) per row. The grid wraps itself in a query container, so the host sets nothing. */
  collapseBelow?: number;
  /** `cells` (stacked layout only) is the ruled cell grid of a record card: no gaps, each field a 12px 16px cell with `list-divider` rules on its right and bottom edges, the uppercase label over a 14px/600 value. Place it flush in a RecordPanel. Auto-fits `minColumnWidth` (200px) tracks unless `columns` is given. @default "plain" */
  variant?: 'plain' | 'cells';
  /** Inline layout: draws a `list-divider` hairline on every row with 8px row padding — the ledger list of a record card. `true` rules under each row; `"top"` rules above each row, for a list that follows a heading. @default false */
  divided?: boolean | 'top';
  /** Row padding of a `divided` list: `compact` is 5px for rows inside a tile. @default "default" */
  density?: 'default' | 'compact';
  /** Inline layout: a fixed label column (px number or CSS length, e.g. 150) instead of `max-content`; long labels wrap inside it. */
  labelWidth?: number | string;
  /** `end` right-aligns values (and their notes) — the spread key/value row, label hard left and value hard right. @default "start" */
  valueAlign?: 'start' | 'end';
  /** Weight of sans values: `normal` 400, `medium` 500, `strong` 600. Coded (`mono`) values keep 400 unless `monoWeight` is set or the field has its own `weight`. @default "normal"; "strong" for `variant="cells"` */
  valueWeight?: 'normal' | 'medium' | 'strong';
  /** Apply `valueWeight` to coded (`mono`) values as well, so a grid of dates and amounts can be set in 500 or 600. A field's own `weight` always applies. @default false */
  monoWeight?: boolean;
  /** Stacked layout: auto-fit tracks at least this many px wide (`repeat(auto-fit, minmax(min(100%, Npx), 1fr))`) instead of a fixed `columns` count; a `wide` field then spans the whole row. */
  minColumnWidth?: number;
  /** Style overrides for the FieldGrid root — the query-container wrapper when `collapseBelow` or `size="summary"` adds one, otherwise the `dl`. */
  style?: React.CSSProperties;
}

/** Label-over-value block every detail card is built from. */
export function FieldGrid(props: FieldGridProps): React.JSX.Element;
