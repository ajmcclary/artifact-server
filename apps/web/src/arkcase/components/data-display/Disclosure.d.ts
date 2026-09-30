import React from 'react';

export interface DisclosureProps {
  /** Header title (14px/600 sans, 13px when compact, 12px `text-emphasis` when dense). Also accepted as a child with `slot="title"`; the prop wins. */
  title?: React.ReactNode;
  /** Secondary line under the title (12px, text-secondary). Also accepted as a child with `slot="meta"`; the prop wins. */
  meta?: React.ReactNode;
  /** Node before the title — a StatusPill, a DataRef identifier, an icon. Also accepted as a child with `slot="leading"`; the prop wins. */
  leading?: React.ReactNode;
  /** Node after the title, in the data face — a count or a pill. Also accepted as a child with `slot="trailing"`; the prop wins. */
  trailing?: React.ReactNode;
  /** Draws the persistent 3px status rail on the start edge, in the SelectableRow rail colours. Omit for no rail. */
  tone?: 'success' | 'danger' | 'warning' | 'primary' | 'neutral';
  /** Controlled open state; pair with `onToggle`. Omit to let the row keep its own state. */
  open?: boolean;
  /** Initial open state when `open` is not supplied. @default false */
  defaultOpen?: boolean;
  /** Called with the requested open state each time the header is pressed. */
  onToggle?: (next: boolean) => void;
  /** Base id; the header is `${id}-header` and the detail `${id}-region`. Generated when omitted. */
  id?: string;
  /** Gives the detail `role="region"` labelled by the header — only for a few, substantial sections a reader may jump between. @default false */
  region?: boolean;
  /** Draws the `list-divider` hairline under the row. @default true */
  divider?: boolean;
  /** Row height and title size: comfortable is a 48px header at 14px, compact a 40px header at 13px. `dense` is the builder palette's group band: a 30px header with 10px inline padding and 6px gaps, a 12px/600 `text-emphasis` label (truncated to one line), `surface-secondary` ground between top and bottom `border-color` hairlines, a 12px chevron, no row divider and an unpadded detail whose rows draw their own insets. @default "comfortable" */
  density?: 'compact' | 'comfortable' | 'dense';
  /** Pins the header to the top of its nearest scrolling container while the row is in view (`position: sticky; top: 0; z-index: 2`), at any density. Where the header would otherwise be transparent it takes an opaque `surface-card` ground so scrolled rows do not show through. @default false */
  sticky?: boolean;
  /** Trailing action words that swap with the state, e.g. `{ closed: 'Inspect checks', open: 'Close details' }`: 12px/600 link ink before the chevron. Visual only (aria-hidden) — `aria-expanded` carries the state, so the header keeps one accessible name. */
  actionLabel?: { open: string; closed: string };
  /** Draws the row as its own bordered, rounded card (`surface-card`, `border-color`) whose header takes `surface-secondary` and a hairline while open; the detail gets 12px padding. Replaces the `divider`. @default false */
  framed?: boolean;
  /** Makes the header a native disabled button: it leaves the tab order, ignores presses (no `onToggle`), drops its hover tint and draws the title and chevron in `text-secondary`. The row keeps its current open state. @default false */
  disabled?: boolean;
  /** Controls beside the header button, never inside it — e.g. a small outline "Download PDF" Button on a filing card. They sit at the row's end (12px end, 16px start padding, 8px gap), keep their own tab stops and names, and do not toggle the row. Framed and open, the header's ground and hairline run under them. */
  actions?: React.ReactNode;
  /** The detail revealed when open. Children marked `slot="title"`, `slot="meta"`, `slot="leading"` or `slot="trailing"` fill those header positions instead. */
  children?: React.ReactNode;
  /** Style overrides for the Disclosure root. */
  style?: React.CSSProperties;
}

/** An expandable row: a native `aria-expanded` button header with leading, title, meta, trailing and chevron — optionally followed by sibling `actions` — over the detail it reveals. */
export function Disclosure(props: DisclosureProps): React.JSX.Element;
