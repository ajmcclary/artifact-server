import React from 'react';

export interface TimelineItem {
  /** Stable key for the item; the index is used when absent. */
  id?: string;
  /** Marker drawn on the connector: a small dot, a numbered ring or an icon ring.
   *  @default 'dot' */
  marker?: 'dot' | 'number' | 'icon';
  /** `bi-*` icon class for `marker="icon"`, e.g. "bi-check-lg". */
  icon?: string;
  /** Ring content for `marker="number"`; the 1-based position is used when absent. */
  number?: React.ReactNode;
  /** Marker ink, drawn from text-safe tokens. Colour is never the only signal; say the state in the title or tag.
   *  @default 'primary' */
  tone?: 'primary' | 'success' | 'warning' | 'danger' | 'neutral';
  /** Event or step title in the body face. */
  title: React.ReactNode;
  /** Secondary line in the data face: a time, date, build number or duration. */
  meta?: React.ReactNode;
  /** Turns `meta` into a 12px/600 sans status line in this tone's text-safe ink — "Overdue — was due 08/12/2026", "Completed 08/02/2026". Omit (or `default`) for the data-face meta. */
  metaTone?: 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'neutral';
  /** A button for this step — "Record Payment", "Approve". An object renders a small outline secondary Button (`variant` switches to that solid variant); a React element renders as given. Sits at the row's end unless `actionPlacement="below"`. */
  action?: React.ReactElement | { label: string; onClick: () => void; icon?: string; variant?: 'primary' | 'secondary' | 'success' | 'danger'; disabled?: boolean };
  /** `end` puts `action` in a column at the row's right edge, top-aligned; `below` puts it under the body. @default "end" */
  actionPlacement?: 'end' | 'below';
  /** Trailing chip beside the title, usually a StatusPill. */
  tag?: React.ReactNode;
  /** Body under the heading, e.g. a sentence or a CodeBlock of failure output. */
  children?: React.ReactNode;
  /** Marks the current step: `aria-current="step"` plus, when selectable, the selected tint and rail colour. */
  current?: boolean;
  /** Makes this item's title a link-styled native button (in the `text-link-hover` ink, underlined on hover) that calls this with the item and its index. Takes precedence over the list's `onSelect` for this item; a `current` item's button carries `aria-current="step"`. */
  onSelect?: (item: TimelineItem, index: number) => void;
}

export interface TimelineProps extends Omit<React.HTMLAttributes<HTMLOListElement>, 'style' | 'children' | 'onSelect'> {
  /** Ordered events or steps, first at the top. */
  items: TimelineItem[];
  /** Draw the vertical hairline between markers.
   *  @default true */
  connected?: boolean;
  /** Makes each title area a native button; called with the chosen item and its index. The host moves `current`. */
  onSelect?: (item: TimelineItem, index: number) => void;
  /** List element: `ol` for sequences whose order matters, `ul` for a plain event feed.
   *  @default 'ol' */
  as?: 'ol' | 'ul';
  /** Accessible name for the list, e.g. "Steps" or "Build history". */
  label?: string;
  /** `rail` is the connector timeline. `ledger` is a run's step ledger: a 32px square index per row (the number, zero-padded to two digits when absent, or the icon), hairline-divided 18px rows on the card, and the tag at the heading's right edge; `connected` and the list-level `onSelect` do not apply.
   *  @default 'rail' */
  variant?: 'rail' | 'ledger';
  /** Rail variant: how `number` and `icon` markers are drawn. `ring` is the tone-coloured ring on the card; `soft` a borderless disc in the tone's pill tint with the pill ink (the record stepper); `solid` a filled disc in the tone's ink with a white glyph. Dots are unchanged. @default "ring" */
  markerStyle?: 'ring' | 'soft' | 'solid';
  /** Style overrides for the list root. */
  style?: React.CSSProperties;
}

/** Vertical event or step list with markers on a connector line. */
export function Timeline(props: TimelineProps): React.JSX.Element;
