import React from 'react';
import type { MenuItem } from '../overlays/Menu';

export interface SplitButtonProps {
  /** Label of the main action, e.g. "Open Claim". */
  children?: React.ReactNode;
  /** Leading `bi-*` icon class of the main action, e.g. "bi-box-arrow-up-right". */
  icon?: string;
  /** Runs the default command when the main half is activated. */
  onClick?: (e: React.MouseEvent) => void;
  /** Related actions listed in the Menu the chevron opens (Menu items: label, icon, onClick, danger, disabled, divider, heading…). @default [] */
  menuItems?: MenuItem[];
  /** Accessible name and tooltip of the chevron, and the Menu's name. @default "More actions" */
  menuLabel?: string;
  /** Button variant of both halves; `outline-*` strings are accepted. @default "primary" */
  variant?: 'primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'info' | 'light' | 'dark'
    | 'outline-primary' | 'outline-secondary' | 'outline-success' | 'outline-danger' | 'outline-warning' | 'outline-info' | 'outline-dark';
  /** Outline treatment for both halves, which then share one border. @default false */
  outline?: boolean;
  /** Button size of both halves. @default "sm" */
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** Natively disables both halves. @default false */
  disabled?: boolean;
  /** Busy state of the main half (spinner, `aria-busy`); the chevron stays usable. @default false */
  loading?: boolean;
  /** Natively disables only the chevron, e.g. when no related action applies. @default false */
  menuDisabled?: boolean;
  /** Menu edge aligned with the chevron. @default "end" */
  menuAlign?: 'start' | 'end';
  /** `top` opens the menu above the button (a docked footer). @default "bottom" */
  menuPlacement?: 'bottom' | 'top';
  /** Explicit menu width; the Menu keeps its 238px minimum otherwise. */
  menuWidth?: number | string;
  /** Controlled open state of the menu; omit to let the SplitButton own it. */
  menuOpen?: boolean;
  /** Called with the requested open state when the chevron toggles or the menu closes. */
  onMenuOpenChange?: (open: boolean) => void;
  /** Style overrides for the SplitButton root (the joined pair). */
  style?: React.CSSProperties;
}

/** A primary action joined to a chevron that opens a menu of related actions. */
export function SplitButton(props: SplitButtonProps): React.JSX.Element;
