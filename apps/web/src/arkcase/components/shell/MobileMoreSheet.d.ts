import React from 'react';
import { NavItem } from '../navigation/SideNav';

export interface MobileMoreSheetProps {
  /** Whether the sheet is shown. @default false */
  open?: boolean;
  /** Called on dismissal and after a tile is chosen. */
  onClose?: () => void;
  /** The modules the tab bar has no room for — the same `NavItem`s as `SideNav`, grouped by `group`. @default [] */
  items?: NavItem[];
  /** `link` of the current module — its tile is tinted and marked `aria-current="page"`. */
  activeLink?: string;
  /** Called with the chosen item, then `onClose`. Modified clicks on a link tile open it natively instead. */
  onSelect?: (item: NavItem) => void;
  /** The account row at the top — avatar, name, role. */
  account?: React.ReactNode;
  /** A footer band — "Edit tab bar", say. */
  footer?: React.ReactNode;
  /** Optional heading; omitted, the account row leads. */
  title?: React.ReactNode;
  /** `aria-label` of the dialog when there is no `title`. @default "More" */
  label?: string;
  /** Selector of the More tab, which takes focus back on close. */
  returnFocusSelector?: string;
}

/**
 * Everything the tab bar has no room for: a `BottomSheet` with the account row and every other
 * module as a 4-column grid of tiles, grouped as the desktop navigation groups them.
 */
export function MobileMoreSheet(props: MobileMoreSheetProps): React.JSX.Element | null;
