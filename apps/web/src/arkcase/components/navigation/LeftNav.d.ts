import React from 'react';
import type { NavItem } from './SideNav';

export type LeftNavMode = 'expanded' | 'rail' | 'peek';

export interface LeftNavBrand {
  /** Brand name for the lock-up. @default "ArkCase" */
  label?: string;
  /** Accessible name of the home control, also the rail tooltip. */
  homeLabel?: string;
  /** Makes the lock-up the home control. */
  onClick?: React.MouseEventHandler<HTMLElement>;
  /** Home link target, instead of `onClick`. */
  href?: string;
  /** Product line beside the wordmark; `null` hides it. */
  product?: React.ReactNode | null;
}

export interface LeftNavProps {
  /**
   * `expanded` the persistent column; `rail` the 52px icon column;
   * `peek` a rail whose expanded list opens over the content. @default "expanded"
   */
  mode?: LeftNavMode;
  /** Navy application chrome or the default light section navigation. @default "default" */
  tone?: 'default' | 'navy';
  /** The column's accessible name, handed to the `SideNav` landmark. @default "Navigation" */
  title?: string;
  /** Replaces the `SideNav` title row; pass `false` to omit the visible row while retaining `title` as the landmark name. */
  header?: React.ReactNode | false;
  /** Lock-up in the navy header: a node (a demonstration build adds its `DemoChip` beside a `BrandLock`), or a descriptor LeftNav turns into a reversed `BrandLock` — wordmark expanded, emblem with a right tooltip on the rail. */
  brand?: React.ReactNode | LeftNavBrand;
  /** Replaces `brand` whenever the column is not expanded — the emblem alone. */
  brandRail?: React.ReactNode;
  /** Search control under the header — a field, or an icon button on the rail. */
  search?: React.ReactNode;
  /** Replaces `search` whenever the column is not expanded. */
  searchRail?: React.ReactNode;
  /** Opens the host's search dialog. LeftNav draws a field-shaped trigger when expanded and an icon with a tooltip on the rail. `search`/`searchRail` win when given. */
  onSearch?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Visible label and accessible name of the search trigger. @default "Quick Search" */
  searchLabel?: string;
  /** Visible shortcut hint after the label, e.g. "⌘K". */
  searchShortcut?: string;
  /** `aria-keyshortcuts` of the trigger, e.g. "Meta+K Control+K /". */
  searchKeyShortcuts?: string;
  /** Whether the search dialog is open; sets `aria-expanded` on the trigger. */
  searchOpen?: boolean;
  /** The `SideNav` contract — groups, counts, locks included. Ignored when `navigation` is given. */
  items?: NavItem[];
  /** `link` of the active item. */
  activeLink?: string;
  /**
   * Called with the item selected by the user — an unmodified primary activation. On a link row
   * a Cmd/Ctrl/Shift/Alt or non-primary click follows the `href` natively and is not reported.
   */
  onSelect?: (item: NavItem) => void;
  /**
   * Custom navigation node replacing the `SideNav` — for rows that carry
   * per-row controls a `NavItem` cannot describe. The pin footer is the
   * caller's then; `pinned` and `onPinChange` are not read. `footer`/`account`
   * (expanded) and `footerRail` (rail) still render below it.
   */
  navigation?: React.ReactNode;
  /** Account row above the pin footer — handed to `SideNav` as its `footer`. An `AccountButton` is also drawn in its rail form when `footerRail` is not given. */
  account?: React.ReactNode;
  /**
   * General footer content above the pin row. Prefer this for application
   * actions; when omitted, the legacy `account` node is used.
   */
  footer?: React.ReactNode;
  /** Footer content shown in the collapsed icon rail. */
  footerRail?: React.ReactNode;
  /** Controlled pin state. */
  pinned?: boolean;
  /** Draws the 32px pin footer and receives the next pin state. Without it no footer is drawn. */
  onPinChange?: (pinned: boolean) => void;
  /** The pin's object as it reads in "Pin the menu". @default "the menu" */
  pinName?: string;
  /** False draws the footer's pin as a glyph with its label as name and tooltip only. @default true */
  pinLabelVisible?: boolean;
  /** Passed to SideNav: suffix for the active item's rail tooltip, e.g. "Current" → "Review queue · Current". Ignored with `navigation`. @default undefined */
  currentLabel?: string;
  /** Right side of the pin footer. */
  footerMeta?: React.ReactNode;
  /** Panel width when expanded. @default 232 */
  width?: number | string;
  /** Adds the resize seam on the inward edge of the expanded column. @default false */
  resizable?: boolean;
  /** Receives the new width, or `null` on reset. */
  onWidthChange?: (width: number | null) => void;
  /** Narrowest the seam will go. @default 180 */
  minWidth?: number;
  /** Widest the seam will go. @default 420 */
  maxWidth?: number;
  /** Every state change is spoken here — hand it the shell's live region. */
  onAnnounce?: (text: string) => void;
  /** Style overrides for the LeftNav root. */
  style?: React.CSSProperties;
}

/**
 * The application navigation column for the no-top-bar workstation: a navy
 * brand header, a search slot, a `SideNav`, an application footer and the pin
 * footer — the whole route chrome in one column.
 *
 * @startingPoint section="Navigation" subtitle="Left navigation column without a top bar" viewport="600x560"
 */
export function LeftNav(props: LeftNavProps): React.JSX.Element;

/** Width of the collapsed rail in px; the CSS custom property `--navigator-rail-width` overrides it. */
export const LEFT_NAV_RAIL_WIDTH: number;
/** Default expanded width in px. */
export const LEFT_NAV_DEFAULT_WIDTH: number;
/** Narrowest expanded width the seam allows, in px. */
export const LEFT_NAV_MIN_WIDTH: number;
/** Widest expanded width the seam allows, in px. */
export const LEFT_NAV_MAX_WIDTH: number;
