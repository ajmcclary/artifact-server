import React from 'react';

export interface ButtonProps {
  /** Visible action label and optional inline content. */
  children?: React.ReactNode;
  /** Brand palette variant; `ghost` is an unfilled in-surface text action, `navy` the same on header chrome. Bootstrap-style `outline-*` strings are accepted too. @default "primary" */
  variant?: 'primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'info' | 'light' | 'dark' | 'link' | 'ghost' | 'navy'
    | 'outline-primary' | 'outline-secondary' | 'outline-success' | 'outline-danger' | 'outline-warning' | 'outline-info' | 'outline-light' | 'outline-dark';
  /** Outline (ghost) treatment — transparent fill, colored border + text. With `variant="navy"` it is the on-navy outline for the app bar: `text-on-navy` label, a `text-on-navy-secondary` hairline, `surface-navy-strong` on hover. @default false */
  outline?: boolean;
  /** With `variant="link"` or `ghost`: a destructive action in `--text-overdue` ink (Delete, Revoke); a link underlines on hover, a ghost takes the danger tint. @default false */
  danger?: boolean;
  /** With `variant="link"`: no padding, border or fixed height, a 600 label and an underline on hover, so the link sits inline in a sentence, a table cell or a dense row (Clear filters, a back link). `size` still sets the font size (`xs` 13px, `sm` 14px). @default false */
  flush?: boolean;
  /** @default "md" */
  /** Visual size of the Button; `xs` is a fixed 24px dense-toolbar row with a 13px label. */
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /**
   * `bi-*` icon class for a leading icon, e.g. "bi-plus-lg". Paints in the label colour;
   * `pressed` swaps it to its filled (Bold) pair.
   */
  icon?: string;
  /** `bi-*` icon class for a trailing icon; toned like `icon`. */
  iconRight?: string;
  /** Disables interaction with the Button. */
  disabled?: boolean;
  /** Busy state — shows a spinner, sets `aria-busy`, blocks interaction. @default false */
  loading?: boolean;
  /** Full-width block button. @default false */
  block?: boolean;
  /** Toggle state for a true on/off control; emits `aria-pressed` when defined and paints the variant's selected fill when true. */
  pressed?: boolean;
  /** Open state of the popup this button controls; emits `aria-expanded` when defined and paints the selected fill when true. */
  expanded?: boolean;
  /** Kind of popup the button opens, emitted as `aria-haspopup`. */
  hasPopup?: boolean | 'menu' | 'dialog' | 'listbox';
  /** Keyboard shortcut announced to assistive tech, emitted as `aria-keyshortcuts` (e.g. "Control+S"). */
  keyshortcuts?: string;
  /** Native tooltip text for the button. */
  title?: string;
  /** Rests an outline or `light` button on `--surface-card` so it reads as a control on a tinted bar. @default false */
  onTint?: boolean;
  /** Touch target: min-height 44px, a 16px label (`--font-size-md`), line-height 1.3 and 9px vertical padding; the label may wrap. For portal and sign-in columns on phones. @default false */
  touch?: boolean;
  /** DOM id forwarded to the button element. */
  id?: string;
  /** Renders the Button as a native `<a href>` with the same look — a call to action that navigates ("Request a demo"). Never wrap a Button in a link instead. Disabled or loading, it falls back to a disabled `<button>`. */
  href?: string;
  /** Link target when `href` is set, e.g. "_blank". */
  target?: string;
  /** Link rel when `href` is set; defaults to "noopener noreferrer" for `target="_blank"`. */
  rel?: string;
  /** Link `download` attribute when `href` is set — `true` or the suggested file name. */
  download?: boolean | string;
  /** Native button type; use submit only inside a form that should submit. */
  type?: 'button' | 'submit' | 'reset';
  /** Called when the Button is activated. */
  onClick?: (e: React.MouseEvent) => void;
  /** Style overrides for the Button root. */
  style?: React.CSSProperties;
}

/**
 * Primary action control — Bootstrap 5.3 `.btn` recreation in the ArkCase palette.
 *
 * @startingPoint section="Actions" subtitle="Buttons across the brand palette" viewport="700x150"
 */
export function Button(props: ButtonProps): React.JSX.Element;
