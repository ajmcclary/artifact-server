import React from 'react';

export interface PanelPeekApi {
  /** True while the railed panel's content is shown as an overlay. */
  peeking: boolean;
  /** Retract the peek — call it from a row selection so picking puts the list away. */
  closePeek: () => void;
  /** The panel's effective state after admission. */
  pinned: boolean;
}

export interface PanelProps {
  /** The key the budget knows this panel by. */
  id?: string;
  /** Lower-case name as it reads in a sentence — "case list". Labels use it as given; announcements capitalise it. @default "panel" */
  name?: string;
  /** The rail's vertical word — "Cases" for a name of "case list". @default the capitalised name */
  railLabel?: string;
  /** The pin's object without its article — "case information" reads "Pin case information". @default "the " + name */
  pinName?: string;
  /** `bi-*` icon class for the rail — "bi-folder2". */
  icon?: string;
  /** Count badge on the rail. */
  count?: React.ReactNode;
  /** An accessible name for the rail's count where the number alone would not read — "3 unread notifications". */
  countLabel?: string;
  /** Controlled pinned state. */
  pinned?: boolean;
  /** Initial pinned state when uncontrolled. @default true */
  defaultPinned?: boolean;
  /** Fires with the new state on every pin toggle, including a hold-to-collapse. */
  onPinChange?: (pinned: boolean) => void;
  /** Whether the panel fits pinned. Omit it inside a `PanelBudget` to read the admission by `id`. */
  canPin?: boolean;
  /** False for the route's own content: no rail, the footer drawn with an empty pin slot. @default true */
  pinnable?: boolean;
  /** Which edge the panel docks to; the 1px rule and the seam sit on the inward edge. @default "start" */
  side?: 'start' | 'end';
  /** Controlled width in px. @default 330 */
  width?: number;
  /** A drag, a keypress on the seam, or a hold-to-collapse commit fires the clamped width; a double-click or Delete fires null (reset). */
  onWidthChange?: (width: number | null) => void;
  /** Draw the 9px seam on the inward edge. @default false */
  resizable?: boolean;
  /** @default 200 */
  /** Minimum permitted width in pixels. */
  minWidth?: number;
  /** @default min(720, max(300, 45% of the budget's viewport width)) */
  /** Maximum permitted width in pixels. */
  maxWidth?: number;
  /**
   * What an unpinned panel becomes. `rail` is the 36px rail whose press opens the peek;
   * `float` renders no rail — the whole column (header, selection, body, footer with the pin)
   * floats over the adjacent content at its edge with an overlay shadow, anchored to the
   * nearest positioned ancestor, while the root takes no layout width. The footer pin pins it
   * back. @default "rail"
   */
  unpinned?: 'rail' | 'float';
  /** Distance of the floating column from its edge — the width of a `RailTabs` strip it floats inside. Used only with `unpinned="float"`. @default 0 */
  floatOffset?: number | string;
  /** Phone presentation: the column fills the viewport (fixed, inset 0, above page chrome), with no rail, an empty pin slot and no seam. @default false */
  sheet?: boolean;
  /** With `sheet`: adds a 44px "‹ Back" link above the header that calls this — the sheet's way back to the screen it covers. */
  onSheetClose?: () => void;
  /** Label of the sheet's back link. @default "Back" */
  sheetCloseLabel?: string;
  /** Narrow column layout (Advanced Search's filters above the results, its preview under them): the panel spans the full width with no rail, pin or seam, and a 32px `surface-secondary` toggle strip on its outer edge carries a ghost xs button — "Show filters" / "Hide filters" (`aria-expanded`, `aria-controls`), with the panel's `icon`, and its `count` beside it while closed. Open is the same `pinned` value, reported through `onPinChange` and announced "Filters shown." / "Filters hidden.". @default false */
  stacked?: boolean;
  /** Which edge the stacked strip sits on; the panel opens from it toward the content. @default "top" for side="start", "bottom" for side="end" */
  stackEdge?: 'top' | 'bottom';
  /** Strip button text. @default { show: "Show " + name, hide: "Hide " + name } */
  stackLabel?: { show?: string; hide?: string };
  /** False disables the rail's peek; an object sets the overlay width. The peek opens on a press of the rail (click, tap, Enter, Space) — never on hover or focus — covers the rail so its footer pin is the only pin, and retracts on a second press, Escape, a press outside or focus leaving. @default true */
  peek?: boolean | { width?: number };
  /** Controlled peek: whether the railed panel's content shows as an overlay. Omit to let the rail own it. */
  peeking?: boolean;
  /** Fires with the next peek state on every open and retract — the rail's press, a press outside, focus leaving, Escape, a selection's closePeek. */
  onPeekChange?: (peeking: boolean) => void;
  /** Also run the pin cue — the ring on the pin and the chip naming the new state — when a
   *  controlled `pinned` changes from outside the panel (a shortcut, a menu command, the host
   *  unpinning it to make room), not only after the panel's own pin is pressed. Focus does not
   *  move and nothing is announced; the host announces its own change. @default false */
  cueExternalPin?: boolean;
  /** The `RailHeader` slot; a child with `slot="header"` fills it on a portable page. */
  header?: React.ReactNode;
  /** The `SelectionBar` slot; a child with `slot="selection"` fills it on a portable page. */
  selection?: React.ReactNode;
  /** Footer right — a result count, a last-refreshed time. Never actions. A child with `slot="footerMeta"` fills it on a portable page. */
  footerMeta?: React.ReactNode;
  /** Every state change is spoken here: "Case list pinned.", "Case list width set to 400 pixels." */
  onAnnounce?: (text: string) => void;
  /** Style overrides for the Panel root. */
  style?: React.CSSProperties;
  /** Style overrides for the scrollable body. */
  bodyStyle?: React.CSSProperties;
  /** `column` lays the body out as a non-scrolling flex column, for a header + list + footer stack. @default "block" */
  bodyLayout?: 'block' | 'column';
  /** The body, or a render function that receives the peek API. */
  children?: React.ReactNode | ((api: PanelPeekApi) => React.ReactNode);
}

/**
 * A docked column with its pin in the 32px footer, a 36px rail whose press opens a
 * peek over it when unpinned, and an optional resize seam that collapses after a one-second hold.
 * The pin is a glyph; its stateful label is `aria-label` and `title`, and a cue
 * chip names the new state for two seconds after a toggle. `unpinned="float"` floats the
 * unpinned column over the content instead of railing it; `sheet` fills the viewport.
 *
 * @startingPoint section="Panel" subtitle="Pinned, railed and content panels on one budget" viewport="1080x560"
 */
export function Panel(props: PanelProps): React.JSX.Element;
