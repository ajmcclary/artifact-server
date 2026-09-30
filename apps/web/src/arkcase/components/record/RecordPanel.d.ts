import React from 'react';

export interface RecordPanelCollapsible {
  /** Whether the body is shown. The host owns this state. */
  open: boolean;
  /** Called when the cap's Inspect/Close button is activated; the host flips `open`. */
  onToggle: () => void;
  /** One-line summary shown in place of the body while closed — 12px secondary, wraps anywhere. */
  preview?: React.ReactNode;
  /** Height cap of the open body, which scrolls beyond it. @default 560 */
  maxHeight?: number | string;
  /** Button text while closed. @default "Inspect record" (cap), "Expand" (strip) */
  openLabel?: string;
  /** Button text while open. @default "Close details" (cap), "Collapse" (strip) */
  closeLabel?: string;
  /** Where the toggle lives. `cap` is the Inspect/Close button in the cap, with the body in a scroll box. `strip` is a full-width strip under the body — chevron plus `preview`, on `surface-secondary` above a `list-divider` rule — that stays in place open or closed, keeps the cap free for `actions`, and leaves the body unscrolled unless `maxHeight` is given. Its accessible name is "Expand|Collapse <label>: <preview>". @default "cap" */
  placement?: 'cap' | 'strip';
}

export interface RecordPanelProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'children'> {
  /** Cap label — 11px/600 uppercase, navy. Names what the panel holds. */
  label?: React.ReactNode;
  /** Cap subtitle — the reading rule, sits beside the label at 12px. */
  subtitle?: React.ReactNode;
  /** Right-aligned cap meta in the data font — a route, an id, a digest. */
  meta?: React.ReactNode;
  /** Right-hand cap slot in the sans face (12px secondary) after `meta` — Buttons, a link button, a StatusPill, an audit line such as "Created by … · 08/26/2026". Use it for anything that is not a coded value. */
  actions?: React.ReactNode;
  /** Footer band — the sentence that qualifies what the body states. */
  footer?: React.ReactNode;
  /** `band` draws the footer as a `surface-secondary` strip above a hairline; `note` draws it as an unbanded 12px secondary footnote under the body (the note line a row list ends on). @default "band" */
  footerVariant?: 'band' | 'note';
  /** Pad the body: `true` is 14px; a number or CSS padding string sets it exactly, e.g. `"6px 14px 12px"` for a divided row list. Leave false for flush tables and row lists. Ignored while `collapsible` uses the cap placement. @default false */
  padded?: boolean | number | string;
  /** Requested width of the RecordPanel. */
  width?: number | string;
  /** `bi-*` studio glyph drawn before the cap label, e.g. `bi-file-earmark-text`. Decorative. */
  icon?: string;
  /** Visual weight: `primary` leads the page (navy-subtle cap, strong hairlines, card lift); `reference` sits flat with no shadow. @default "default" */
  emphasis?: 'default' | 'primary' | 'reference';
  /** Recolours the frame for an alarm or caution panel: a pill-border hairline around the panel and under the cap, the cap tinted (`tint-danger-hover`, `pill-warning-bg`, `pill-success-bg`) and the label in the pill ink. Takes precedence over emphasis for the border and cap ground; say the state in the label too. @default "default" */
  tone?: 'default' | 'danger' | 'warning' | 'success';
  /** Cap ground, independent of emphasis: `secondary` (`surface-secondary`), `navy` (`surface-navy-subtle`), `tint` (the 10% primary tint), `solid` (a `bs-primary` fill with a 13px sentence-case `text-on-primary` label, meta and actions in the same ink — no uppercase) or `plain` (the card surface over a `list-divider` rule). `auto` follows `tone`, then `emphasis`. @default "auto" */
  capTone?: 'auto' | 'secondary' | 'navy' | 'tint' | 'solid' | 'plain';
  /** Cap label step: `sm` is the 11px navy label; `md` the 12px uppercase label in `text-link-hover` with a 10px cap padding, the Workers' Compensation card cap. Ignored by `capTone="solid"`. @default "sm" */
  capSize?: 'sm' | 'md';
  /** Cross-axis alignment of the cap row. `center` also gives the cap a 46px minimum height, for caps that hold a button. @default "baseline" */
  capAlign?: 'baseline' | 'start' | 'center';
  /** Let the cap meta wrap (and the cap row wrap under the label) instead of staying on one line — for narrow side columns. The `actions` row wraps too (6px between lines), so a grid toolbar of several buttons folds onto a second line at phone width instead of overflowing the panel. @default false */
  metaWrap?: boolean;
  /** Makes the body an Inspect/Close disclosure driven by the host: the cap meta gains a button with `aria-expanded`/`aria-controls`; closed, the panel shows `preview`; open, the children in a scroll box capped at `maxHeight`. */
  collapsible?: RecordPanelCollapsible;
  /** Style overrides for the RecordPanel root. */
  style?: React.CSSProperties;
  /** Record content rendered inside the panel body. */
  children?: React.ReactNode;
}

/**
 * The record surface: cap, body, footer band. The container every ledger,
 * reading and dense table on the console sits inside.
 */
export function RecordPanel(props: RecordPanelProps): React.JSX.Element;
