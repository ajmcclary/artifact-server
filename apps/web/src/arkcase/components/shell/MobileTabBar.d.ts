import React from 'react';

export interface MobileTabItem {
  /** Stable id; matched against `activeId`. */
  id: string;
  /** Short label under the icon — one word where possible. */
  label: string;
  /** `bi-*` icon class, drawn at 22px; Bold when current. */
  icon?: string;
  /** Destination. With a link the item is an `<a>` and modified clicks open it natively. */
  link?: string;
  /** Count on the icon (99+ above 99). Zero or empty draws nothing. */
  count?: number | string;
  /** `danger` for a count that needs action now; otherwise the primary fill. @default "neutral" */
  countTone?: 'danger' | 'neutral';
  /** Marks the item as opening a sheet (More) — adds `aria-haspopup="dialog"`. */
  opensSheet?: boolean;
  /** Accessible name override. @default "<label>" or "<label>, <count> new" */
  ariaLabel?: string;
}

export interface MobileTabBarProps extends Omit<React.HTMLAttributes<HTMLElement>, 'style' | 'onSelect'> {
  /** Up to five destinations; the last is usually More. @default [] */
  items?: MobileTabItem[];
  /** `id` of the current destination — marked `aria-current="page"`. */
  activeId?: string;
  /** Called with the item on activation; the host navigates or opens the More sheet. Choosing the current tab again should return that tab to its root. */
  onSelect?: (item: MobileTabItem) => void;
  /** `aria-label` of the navigation landmark. @default "Primary" */
  label?: string;
  /** `fixed` to the viewport's bottom edge; `static` or `relative` for previews and frames. @default "fixed" */
  position?: 'fixed' | 'static' | 'relative' | 'sticky';
  /** Stacking order while fixed — under sheets and dialogs. @default 1020 */
  zIndex?: number;
  /** Style overrides for the bar. */
  style?: React.CSSProperties;
}

/**
 * The phone's primary navigation: up to five destinations along the bottom edge, the current
 * one in a 56 × 30 tint pill with a Bold icon, counts in a solid badge, padded by the bottom
 * safe-area inset. Four modules and a More item that opens a `MobileMoreSheet`.
 */
export function MobileTabBar(props: MobileTabBarProps): React.JSX.Element;
