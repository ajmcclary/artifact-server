import React from 'react';

export interface MobileHistoryEntry {
  /** Stable key; defaults to the index. */
  id?: string;
  /** Screen name — "Claims", "Boateng, Akosua". */
  label: React.ReactNode;
  /** Second line — a record id, the section, a filter. */
  sub?: React.ReactNode;
  /** `bi-*` icon class. */
  icon?: string;
  /** The last entry is the current screen unless this is `false`. */
  current?: boolean;
}

export interface MobileAppBarProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title' | 'style'> {
  /** The current screen's name. At a root it fades in over the brand once the page has scrolled; below the root it is centred. */
  title?: React.ReactNode;
  /** Second line under a pushed title, in the data face — a record id. */
  subtitle?: React.ReactNode;
  /** The root's leading mark — a `BrandLock` home control. Ignored when `onBack` is set. */
  brand?: React.ReactNode;
  /** One or two trailing actions — `MobileAppBarAction`s. */
  actions?: React.ReactNode;
  /** The parent screen's name after the ‹; truncates at 42% of the bar. */
  backLabel?: React.ReactNode;
  /** Present below a tab's root: the bar leads with ‹ Back and calls this on activation. */
  onBack?: () => void;
  /** The tab's stack, root first and the current screen last. With two or more entries, press-and-hold, right-click or Alt+↑ on ‹ Back opens it as a menu. */
  history?: MobileHistoryEntry[];
  /** Called with the chosen entry and its index; the host pops to it. */
  onHistorySelect?: (entry: MobileHistoryEntry, index: number) => void;
  /** Heading of the history menu. @default "Go back to" */
  historyLabel?: string;
  /** Controls the title's visibility. Omitted, the bar reveals it once `scrollTarget` (the window) passes `revealAfter`. */
  titleVisible?: boolean;
  /** Scroll distance, in px, after which the title appears. @default 40 */
  revealAfter?: number;
  /** Element whose scroll reveals the title. @default window */
  scrollTarget?: HTMLElement | null;
  /** `fixed` to the viewport's top edge; `static` or `relative` for previews and frames. @default "fixed" */
  position?: 'fixed' | 'static' | 'relative' | 'sticky';
  /** Stacking order while fixed. @default 1020 */
  zIndex?: number;
  /** Style overrides for the bar. */
  style?: React.CSSProperties;
}

/**
 * The phone's 52px navy bar. A tab's root carries the brand and one or two actions; below the
 * root it leads with ‹ and the parent's name, and the screen's title (with a record id) fades in
 * once the page's own header has scrolled under it. Press and hold ‹ Back for the whole stack.
 */
export function MobileAppBar(props: MobileAppBarProps): React.JSX.Element;

export interface MobileAppBarActionProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  /** `bi-*` icon class, drawn at 20px. */
  icon: string;
  /** Accessible name and tooltip. */
  label: string;
  /** Called on activation. */
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  /** Style overrides for the button. */
  style?: React.CSSProperties;
}

/** A 44px round icon button sized and coloured for the navy bar. */
export function MobileAppBarAction(props: MobileAppBarActionProps): React.JSX.Element;
