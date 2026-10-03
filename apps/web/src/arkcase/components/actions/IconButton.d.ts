import React from 'react';

export interface IconButtonProps {
  /**
   * `bi-*` icon class, e.g. "bi-list", "bi-x-lg", "bi-three-dots-vertical". The glyph paints in
   * the control's ink; `pressed` swaps it to its filled (Bold) pair.
   */
  icon: string;
  /** @default "ghost" */
  /** Visual treatment applied to the IconButton. */
  variant?: 'ghost' | 'primary' | 'light' | 'danger' | 'navy' | 'dark';
  /** @default "md" */
  /** Visual size of the IconButton: `xs` 24px with a 14px glyph (dense toolbars), `sm` 30, `md` 38, `lg` 46. */
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** @default "square" */
  /** Outline shape of the icon-only button. */
  shape?: 'square' | 'circle';
  /** Accessible label — required since the button has no text. */
  ariaLabel?: string;
  /** DOM id forwarded to the button element. */
  id?: string;
  /** Disables interaction with the IconButton. */
  disabled?: boolean;
  /** Toggle state for a true on/off control; emits `aria-pressed` when defined and paints the variant's selected fill when true. */
  pressed?: boolean;
  /** Open state of the popup this button controls; emits `aria-expanded` when defined and paints the selected fill when true. */
  expanded?: boolean;
  /** Kind of popup the button opens, emitted as `aria-haspopup`. */
  hasPopup?: boolean | 'menu' | 'dialog' | 'listbox';
  /** Tooltip text override; defaults to the accessible label. */
  title?: string;
  /** Keyboard shortcut announced to assistive tech, emitted as `aria-keyshortcuts` (e.g. "Control+K"). */
  keyshortcuts?: string;
  /** Small count shown after the glyph in the data face; the button becomes auto-width at the same height. */
  count?: React.ReactNode;
  /** Spoken meaning of `count`, appended to the accessible name (e.g. "3 open threads"); the visible count is then aria-hidden. */
  countLabel?: string;
  /** Corner badge over the glyph, e.g. an unread count on a bell: an 11px data-face pill pinned to the top-right corner. Hidden when empty, false or 0. Decorative (aria-hidden) — give its meaning with `badgeLabel`. */
  badge?: React.ReactNode;
  /** Spoken meaning of `badge`, appended to the accessible name while the badge shows, e.g. "3 unread". */
  badgeLabel?: string;
  /** Badge fill: `critical` (the `pill-critical` pair, for unread alerts), `primary` or `neutral`. @default "critical" */
  badgeTone?: 'critical' | 'primary' | 'neutral';
  /** Called when the IconButton is activated. */
  onClick?: (e: React.MouseEvent) => void;
  /** Style overrides for the IconButton root. */
  style?: React.CSSProperties;
}

/**
 * Icon-only button — app-bar controls, dialog close, table row actions.
 */
export function IconButton(props: IconButtonProps): React.JSX.Element;
