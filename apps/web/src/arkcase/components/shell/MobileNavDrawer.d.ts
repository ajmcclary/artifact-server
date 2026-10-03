import React from 'react';
import { NavItem } from '../navigation/SideNav';

export interface MobileNavDrawerProps {
  /** @default false */
  /** Whether the MobileNavDrawer is visible. */
  open?: boolean;
  /** Called on Escape, backdrop, the close button, and after a selection. */
  onClose?: () => void;
  /** @default [] */
  /** Items rendered by the MobileNavDrawer. */
  items?: NavItem[];
  /** `link` of the active item — marked `aria-current="page"`. */
  activeLink?: string;
  /**
   * Called with the item, then `onClose`, on an unmodified primary activation. On a link row a
   * Cmd/Ctrl/Shift/Alt or non-primary click follows the `href` natively (a new tab or window):
   * neither is called and the drawer stays open.
   */
  onSelect?: (item: NavItem) => void;
  /** Brand mark in the 56px navy header. */
  brand?: React.ReactNode;
  /** Small text beside the brand — the signed-in role, say. */
  title?: React.ReactNode;
  /** Account row at the bottom. */
  footer?: React.ReactNode;
  /** @default "min(320px, calc(100vw - 48px))" */
  /** Requested width of the MobileNavDrawer. */
  width?: number | string;
  /** @default "Close menu" */
  /** Accessible name for the close control. */
  closeLabel?: string;
  /** `aria-label` of the dialog. @default "Modules" */
  label?: string;
  /** Receives "Menu closed." — the host's live region speaks it. */
  onAnnounce?: (text: string) => void;
  /** Stable selector for the opener when pointer activation does not focus buttons (notably WebKit). */
  returnFocusSelector?: string;
  /**
   * Draws the phone's opener while the drawer is closed: a 40px round navy button
   * fixed at the top-left (z-index 60) for a shell with no top bar. `true` uses
   * `bi-list` and "Open menu"; an object overrides either. Focus returns to it on
   * close. Omitted, nothing renders while closed.
   */
  launcher?: boolean | { label?: string; icon?: string };
  /** Called when the launcher is activated; the host sets `open`. */
  onOpen?: () => void;
  /** Style overrides for the MobileNavDrawer root. */
  style?: React.CSSProperties;
}

/**
 * The phone shell's primary navigation: a modal drawer that slides in from the
 * start edge over a navy backdrop, traps Tab, closes on Escape, locks the
 * body's scroll and returns focus on close. Every item is a 44px target with a
 * 20px navigation icon independent of its label's font size; the current item draws Bold.
 */
export function MobileNavDrawer(props: MobileNavDrawerProps): React.JSX.Element | null;
