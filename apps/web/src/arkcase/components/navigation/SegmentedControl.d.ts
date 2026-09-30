import React from 'react';

export interface SegmentedOption {
  id: string;
  label?: React.ReactNode;
  /** Optional `bi-*` studio icon class shown before the label (or alone, with `ariaLabel`). */
  icon?: string;
  /** A small drawn picture in the icon's place — e.g. the Dashboard column picker's bar drawings — as a node or a function of the segment's selected state. Wrapped in an aria-hidden span; draw it in `currentColor` so it follows the segment's ink. */
  glyph?: React.ReactNode | ((selected: boolean) => React.ReactNode);
  /** Optional count shown after the label in the data face. */
  count?: React.ReactNode;
  /** Accessible name for the segment; required when the option is icon-only (no label). */
  ariaLabel?: string;
  /** Tooltip text (the native `title`), e.g. the label plus its shortcut. */
  title?: string;
  /** Keyboard shortcut hint emitted as `aria-keyshortcuts`, e.g. "1". */
  keys?: string;
  /** Renders the segment natively disabled; radio-mode arrow keys skip it. @default false */
  disabled?: boolean;
}

export interface SegmentedControlProps {
  /** Two to four options (`chip` may hold more short options; its row wraps). */
  options?: (SegmentedOption | string)[];
  /** Controlled selection — omit for internal state. */
  value?: string;
  /** Called with the id of the newly selected segment. */
  onChange?: (id: string) => void;
  /** Fills its container. @default false */
  block?: boolean;
  /** Accessible group name. */
  label?: string;
  /** Bordered teal control, the pill track used in dense tool chrome, or `chip`: separate 28px bordered pills (24px at `sm`) 6px apart whose selected one takes the primary tint, border and 600 ink, with 14px icons and `text-secondary` counts. @default "bordered" */
  variant?: 'bordered' | 'pill' | 'chip';
  /** Let the row wrap onto further lines when it runs out of width. @default true for `chip`, false otherwise */
  wrap?: boolean;
  /** Segment metrics: `md` is the standard control, `sm` gives 20–24px segments. @default "md" */
  size?: 'sm' | 'md';
  /** Toggle buttons (`aria-pressed`) or an APG radio group with one tab stop and arrow-key selection. @default "toggle" */
  mode?: 'toggle' | 'radio';
  /** Style overrides for the SegmentedControl root. */
  style?: React.CSSProperties;
}

/** Two to four mutually exclusive views of one surface. */
export function SegmentedControl(props: SegmentedControlProps): React.JSX.Element;
