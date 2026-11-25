import React from 'react';

export interface TimelineItem {
  /** Stable key for the item; the index is used when absent. */
  id?: string;
  /** Marker drawn on the connector: a small dot, a numbered ring or an icon ring.
   *  @default 'dot' */
  marker?: 'dot' | 'number' | 'icon';
  /** `bi-*` icon class for `marker="icon"`, e.g. "bi-check-lg". */
  icon?: string;
  /** Ring content for `marker="number"`; the 1-based position is used when absent. In a compact ledger with any other marker, the small data-face prefix before the title ("1", "01"). */
  number?: React.ReactNode;
  /** This item's marker drawing, overriding the list's `markerStyle`: `dashed` is an empty disc in a dashed strong hairline, for a step not yet reached. */
  markerStyle?: 'ring' | 'soft' | 'solid' | 'dashed';
  /** The marker's state in words — "passed", "held for review" — read after the title by assistive technology (visually hidden). Markers are decorative, so give one whenever tone or icon carries the state. */
  markerLabel?: string;
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
  /** Marks the current step: `aria-current="step"` (on its button when selectable, else on its list item — in every variant and density) plus, when selectable, the selected tint and rail colour. */
  current?: boolean;
  /** Makes this item's title a link-styled native button (in the `text-link-hover` ink, underlined on hover) that calls this with the item and its index. Takes precedence over the list's `onSelect` for this item; a `current` item's button carries `aria-current="step"`. In a compact ledger the whole row is the button, with a chevron at its end. */
  onSelect?: (item: TimelineItem, index: number) => void;
  /** Compact ledger: a step not reached. Its row button is natively disabled, the title reads `text-secondary` and the chevron is withheld. */
  disabled?: boolean;
  /** Compact ledger: the row waiting on a person, washed in `pill-warning-bg` — say why in the body as well. */
  attention?: boolean;
  /** Compact ledger: trailing text at the row's end — a gate count, a duration — in 12px `text-secondary`; dropped when the row stacks. */
  aside?: React.ReactNode;
  /** Any `data-*` key on the item (e.g. `'data-step-row': 4`) is copied onto a compact ledger row, so host hooks survive. */
  [data: `data-${string}`]: string | number | undefined;
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
  /** Rail variant and compact ledger: how `number` and `icon` markers are drawn. `ring` is the tone-coloured ring on the card; `soft` a borderless disc in the tone's pill tint with the pill ink (the record stepper, and the compact ledger's default); `solid` a filled disc in the tone's ink with a white glyph; `dashed` an empty disc in a dashed hairline. Dots are unchanged on the rail. @default "ring" */
  markerStyle?: 'ring' | 'soft' | 'solid' | 'dashed';
  /** Ledger variant: `compact` is the pipeline as one line per step — a 24px round state marker, the number and title in a `titleWidth` column, the body (what happened) beside it, then the tag and `aside`, and a chevron; an item with `onSelect` makes its whole row a native button. Rows are 11px × 16px, divided by `list-divider`. @default "default" */
  density?: 'default' | 'compact';
  /** Compact ledger: width of the number-and-title column, in px or any CSS length. @default 128 */
  titleWidth?: number | string;
  /** Compact ledger: below this measured list width (px) each row stacks the title over the body and drops the aside. @default 600 */
  stackBelow?: number;
  /** Style overrides for the list root. */
  style?: React.CSSProperties;
}

/** Vertical event or step list with markers on a connector line. */
export function Timeline(props: TimelineProps): React.JSX.Element;
