import React from 'react';

export interface MenuItem {
  label?: React.ReactNode;
  /** `bi-*` studio icon class. */
  icon?: string;
  onClick?: () => void;
  /** Destructive verb — renders in danger red. */
  danger?: boolean;
  disabled?: boolean;
  /** Uppercase group label instead of an item. */
  heading?: string;
  /** Hairline rule instead of an item. */
  divider?: boolean;
  /** Item kind: `checkbox`/`radio` render `menuitemcheckbox`/`menuitemradio` with `aria-checked`. @default "item" */
  type?: 'item' | 'checkbox' | 'radio';
  /** Checked state for `checkbox`/`radio` items; shows a trailing check mark. */
  checked?: boolean;
  /** Keycaps shown trailing with ShortcutKey, in reading order. Display only; the host installs the shortcut. */
  shortcut?: string[];
  /** Spoken equivalent of `shortcut`, e.g. "Option S". */
  shortcutLabel?: string;
  /** Second, smaller secondary line under the label. */
  description?: React.ReactNode;
  /** Right-aligned data-font count or value, e.g. a filter's match count. */
  meta?: React.ReactNode;
  /** Replaces the icon slot, e.g. a ColorSwatch. */
  leading?: React.ReactNode;
  /** Opens elsewhere (new window or external tool); adds a trailing box-arrow glyph. */
  external?: boolean;
  /** Activation does not call `onClose`, for multi-select filters. */
  keepOpen?: boolean;
}

export interface MenuProps {
  // Escape ownership is coordinated with shared Modal and Popover layers.
  /** @default true */
  /** Whether the Menu is visible. */
  open?: boolean;
  /** Items rendered by the Menu. */
  items?: MenuItem[];
  /** Called when the Menu requests dismissal. */
  onClose?: () => void;
  /** Aligns to the trigger's start or end edge. @default "end" */
  align?: 'start' | 'end';
  /** "top" opens above the trigger and takes --shadow-up. @default "bottom" */
  placement?: 'bottom' | 'top';
  /** Accessible name. @default "Actions" */
  label?: string;
  /** Style overrides for the Menu root. */
  style?: React.CSSProperties;
  /** Host-computed viewport coordinates; renders `position: fixed` there and ignores `align`/`placement`. Ignored when `anchor` is given. */
  position?: { top: number | string; left?: number | string; right?: number | string };
  /** Explicit menu width; when omitted the menu keeps a 238px minimum width. */
  width?: number | string;
  /** Row density: `compact` is the kebab sheet; `comfortable` is 36px rows with an icon column. @default "compact" */
  density?: 'compact' | 'comfortable';
  /** Content above the items (e.g. a zoom input), separated by a hairline and kept outside `role="menu"`. */
  header?: React.ReactNode;
  /** On open, focus the first checked item, else the first enabled item. @default false (true for `presentation="sheet"`) */
  autoFocus?: boolean;
  /**
   * `popover` floats beside its trigger. `sheet` is the phone form: a bottom sheet over a navy
   * scrim (45%), full width, 12px top corners, `shadow-up`, capped at the viewport height less
   * 24px (scrolling inside), 44px comfortable rows and safe-area bottom padding. It ignores
   * `anchor`, `position`, `align`, `placement` and `width`, focuses the first item on open, and
   * a press on the scrim is an outside press (`onClose`). The host picks the presentation for
   * its display profile. @default "popover"
   */
  presentation?: 'popover' | 'sheet';
  /** Stacking order of the floating sheet; a `sheet`'s scrim sits one below. @default 1060 */
  zIndex?: number;
  /**
   * The trigger element to hang the menu from. Given, the menu measures it and renders
   * `position: fixed`: `placement="top"` opens upward with its bottom 8px above the anchor's
   * top, `placement="bottom"` opens 8px below the anchor's bottom; `align="start"` lines up
   * the left edges, `align="end"` the right edges. The sheet is clamped 12px inside the
   * viewport, capped at the viewport height less 24px (scrolling inside), and recomputed on
   * window resize. A press on the anchor is not an outside press, so the trigger's own
   * toggle closes it. Takes precedence over `position`. @default null
   */
  anchor?: Element | null;
  /** Called before the menu's own key handling; call `preventDefault()` to skip it. */
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
}

/** Row-action sheet opened by a kebab, or a phone bottom sheet (`presentation="sheet"`). Arrow keys, Home/End and typeahead move focus; dismisses on outside click, Escape or Tab. */
export function Menu(props: MenuProps): React.JSX.Element | null;
