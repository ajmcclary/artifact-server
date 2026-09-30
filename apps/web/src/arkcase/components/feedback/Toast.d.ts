import React from 'react';

export interface ToastProps {
  /** Tone of the accent rule, icon disc and title. `primary` matches Alert's primary; `info` keeps the same primary-blue treatment. @default "info" */
  variant?: 'primary' | 'info' | 'success' | 'warning' | 'danger';
  /** Bold lead line — what happened, in the past tense. */
  title?: React.ReactNode;
  /** The detail line: which record, and what it now is. */
  children?: React.ReactNode;
  /** Repeats collapse into a count instead of stacking. @default 1 */
  count?: number;
  /** Single follow-up verb ("Undo", "Open claim"). */
  actionLabel?: string;
  /** Called when the primary action is activated. */
  onAction?: () => void;
  /** Called when the Toast requests dismissal; shows the dismiss control when provided. */
  onClose?: () => void;
  /** Overrides the tone's default status glyph (`bi-*` studio icon class). */
  icon?: string;
  /**
   * Live-region politeness. Omitted, `danger` and `warning` announce assertively
   * (`role="alert"`) and the rest politely (`role="status"`). `off` drops the role and
   * `aria-live` for a toast whose host already announces it (a ToastRegion does).
   */
  live?: 'assertive' | 'polite' | 'off';
  /** Accessible name of the dismiss control. @default "Dismiss" */
  dismissLabel?: string;
  /**
   * `card` is the fixed 360px card with the action under the text and a 24px dismiss target.
   * `snackbar` is the fluid row a ToastRegion floats (300–560px): a strong hairline,
   * `shadow-lg`, the count as a pill, the action trailing as an outlined button and a 34px
   * round dismiss target. @default "card"
   */
  layout?: 'card' | 'snackbar';
  /** Where the follow-up verb sits: under the text as a link, or trailing as an outlined button. @default "below" for `card`, "trailing" for `snackbar` */
  actionPlacement?: 'below' | 'trailing';
  /** Play the enter motion on mount (190ms rise; none under reduced motion). @default false */
  animated?: boolean;
  /** Play the exit motion (180ms fall and fade; none under reduced motion). The host removes the toast afterwards. @default false */
  leaving?: boolean;
  /** Which viewport edge the toast sits on; the motion travels from and to it. @default "bottom" */
  edge?: 'top' | 'bottom';
  /** Style overrides for the Toast root. */
  style?: React.CSSProperties;
}

/** Transient confirmation raised after a write. One at a time. */
export function Toast(props: ToastProps): React.JSX.Element;
