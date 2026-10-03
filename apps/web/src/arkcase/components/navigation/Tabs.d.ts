import React from 'react';

export interface TabItem {
  id: string;
  label: string;
  /** Optional `bi-*` icon class. */
  icon?: string;
  /** Optional count badge. On `variant="stacked"` iconed tabs a count of 0 (or below) draws nothing. */
  count?: number;
  /** Count badge tone; by default the active tab's count is primary and the rest neutral (white chip on navy). */
  countTone?: 'neutral' | 'primary' | 'danger' | 'warning' | 'success';
  /** Spoken meaning of the count (e.g. "1 failing"); the visible count is then hidden and the name reads "Label, countLabel". */
  countLabel?: string;
  /** Skipped by the arrow keys and not clickable. */
  disabled?: boolean;
  /** Marks the tab restricted: a lock badge in the icon's corner (`countPlacement="corner"`, when the tab has no count) or a lock glyph after the label, and ", {lockLabel}" appended to the accessible name. The tab stays selectable — the host decides what its panel shows. @default false */
  locked?: boolean;
  /** Spoken and tooltip meaning of the lock. @default "Restricted" */
  lockLabel?: string;
  /** DOM id for the tab button, so a panel can point back with aria-labelledby. */
  tabId?: string;
  /** DOM id of the panel this tab controls (emitted as aria-controls). */
  panelId?: string;
}
export interface TabsProps {
  /** Underline bar, the stacked icon-over-label bar the record screens use, or the navy-chrome bar for `surface-header`. `stacked` reproduces the Workers' Compensation locked `stackTabs()` bar exactly: the underline button (8px 14px) around a label block (`padding: 3px 0 1px`, `margin: 0 -9px`, `minWidth: 66`, `gap: 6`, bottom-aligned) with a 20px glyph over a 13px label; an iconed tab's count always rides the icon corner (primary badge, 11px/600, `2px 6px`) and is drawn only when greater than zero. @default "underline" */
  variant?: 'underline' | 'stacked' | 'navy';
  /** Horizontal bar, or a vertical list with the indicator on the inline-start edge (emits aria-orientation). @default "horizontal" */
  orientation?: 'horizontal' | 'vertical';
  /** Shows icons only; each tab keeps its label (plus countLabel) as its accessible name and title tooltip. @default false */
  iconOnly?: boolean;
  /** Horizontal bars only: keeps the tabs on one line and scrolls them sideways (hidden scrollbar), fading an edge while more tabs lie beyond it and keeping the active tab in view. @default false */
  scrollable?: boolean;
  /** Where an iconed tab's count sits: `inline` chip after the label (default), or `corner` — a solid primary badge on the icon's top-right corner in the data face, which is also where a `locked` tab's lock goes. Tabs without an icon keep the inline chip. @default "inline" */
  countPlacement?: 'inline' | 'corner';
  /** Tabs as {id,label,icon?,count?} objects (or plain strings). @default [] */
  tabs?: (TabItem | string)[];
  /** Controlled active id. Omit for uncontrolled. */
  active?: string;
  /** Called with the id of the newly active tab. */
  onChange?: (id: string) => void;
  /** Style overrides for the Tabs root. */
  style?: React.CSSProperties;
}

/**
 * Underline tab bar — active tab gets a cyan underline; optional count badges. Arrow keys, Home
 * and End move focus and select; the handler stops propagation so a host's roving handler does
 * not move the same press twice.
 */
export function Tabs(props: TabsProps): React.JSX.Element;
