import React from 'react';

export interface NavItem {
  /** Destination; omit it for a button that is a section, not a page. */
  link?: string;
  label: string;
  /** Marks a link-less item current (`aria-current="true"`). */
  current?: boolean;
  /** 1 renders a child row of the item before it, absent from the rail. */
  depth?: 0 | 1;
  /** `neutral` draws an informational count in the neutral pill; the default is the danger pill. */
  countTone?: 'danger' | 'neutral';
  /** Optional `bi-*` Studio icon. Navigation renditions use 20px in labelled rows and rails, independently of text size. */
  icon?: string;
  /** Stable key; defaults to the index. */
  id?: string;
  /** Count badge — a pill beside the label, a dot on the rail icon. */
  count?: number;
  /** Starts a section: a header when the group changes, a rule in rail mode. */
  group?: string;
  /** Draws a lock glyph; the rail names the item "(restricted)". */
  locked?: boolean;
}

export type SideNavMode = 'drawer' | 'expanded' | 'rail' | 'peek';

export interface SideNavProps {
  /** @default [] */
  /** Items rendered by the SideNav. */
  items?: NavItem[];
  /** `link` of the active item — marked `aria-current="page"` when `mode` is given. */
  activeLink?: string;
  /** Drawer open state (ignored outside `drawer` mode). @default true */
  isOpen?: boolean;
  /** Close handler — shows a backdrop + close button when provided. */
  onClose?: () => void;
  /**
   * Called with the item on an unmodified primary activation (click, Enter or Space). Items are
   * reached by Tab, and by ArrowDown / ArrowUp, Home / End between the visible items — focus
   * only; Enter or Space selects. On a link row a Cmd/Ctrl/Shift/Alt or non-primary click follows
   * the `href` natively (a new tab or window): `onSelect` is not called and a peek stays open.
   */
  onSelect?: (item: NavItem) => void;
  /** Header title; the landmark's `aria-label`. @default "Navigation" */
  title?: string;
  /** Legacy: render as a static in-layout sidebar. Maps to `mode="expanded"` at 280px. @default false */
  inline?: boolean;
  /**
   * `drawer` is the slide-in overlay; `expanded` the persistent sidebar; `rail` the
   * icon-only column at `--navigator-rail-width` with 44px targets; `peek` a rail headed
   * by an expand button ("Expand menu", `aria-expanded`) whose press — never hover or focus —
   * opens the expanded list over the rail; its collapse button in the same place, a press
   * outside, blur, Escape or a selection retracts it. The rail's items go straight to their
   * destination on any pointer. @default "drawer", or "expanded" when `inline`
   */
  mode?: SideNavMode;
  /** Pin state of the Panel Pin Model footer. @default false */
  pinned?: boolean;
  /** Draws the 32px pin footer and receives the next pin state. Without it no footer is drawn. */
  onPinChange?: (next: boolean) => void;
  /** Right side of the pin footer. */
  footerMeta?: React.ReactNode;
  /** The pin's object as it reads in "Pin the menu" — "sections" gives "Pin sections" and "Sections pinned.". @default "the menu" */
  pinName?: string;
  /** False draws the footer's pin as a glyph with its label as name and tooltip only. @default true */
  pinLabelVisible?: boolean;
  /**
   * Suffix for the active item's rail tooltip, joined with " · " — "Current" gives
   * "Review queue · Current". The item's accessible name stays its label; `aria-current`
   * already announces the state. Omitted, the tooltip is the label alone. @default undefined
   */
  currentLabel?: string;
  /** Replaces the title row. */
  header?: React.ReactNode;
  /** Sits above the pin footer — an account row. */
  footer?: React.ReactNode;
  /** Footer content for the collapsed icon rail. */
  footerRail?: React.ReactNode;
  /** Panel width in `expanded`, `drawer` and the peek overlay. The column is `flex: none`, so this is what it stays. @default 232 (280 through `inline` or `drawer`) */
  width?: number | string;
  /** Adds the resize seam on the inward edge of the `expanded` column. @default false */
  resizable?: boolean;
  /** Receives the new width, or `null` when the reader resets it with Delete or a double-click. */
  onWidthChange?: (width: number | null) => void;
  /** Narrowest the seam will go. @default 180 */
  minWidth?: number;
  /** Widest the seam will go. @default 420 */
  maxWidth?: number;
  /** Receives "Menu pinned." / "Menu unpinned." and the seam's width announcements — the host's live region speaks them. */
  onAnnounce?: (text: string) => void;
  /** Style overrides for the SideNav root. */
  style?: React.CSSProperties;
}

/**
 * Primary navigation in four modes — the slide-in drawer, the persistent
 * sidebar, the icon-only rail and the rail whose expand button opens it over the content — with the
 * 32px pin footer the Panel Pin Model gives every dockable panel, and an
 * optional resize seam on the expanded column.
 *
 * @startingPoint section="Shell" subtitle="Side navigation: drawer, expanded, rail, peek" viewport="600x420"
 */
export function SideNav(props: SideNavProps): React.JSX.Element;
