import React from 'react';

/** A trailing action given as data; Alert draws it as a small Button. */
export interface AlertAction {
  /** Button text, e.g. "Generate notice". */
  label: React.ReactNode;
  /** Called when the button is activated. */
  onClick?: () => void;
  /** Button variant. Defaults to the alert's own tone (`danger` alert → `danger` button); a `neutral` alert defaults to `secondary`. */
  variant?: 'primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'info' | 'light' | 'dark' | 'link' | 'ghost' | 'navy';
  /** Outline treatment. Defaults to true only for a `neutral` alert's default secondary button. */
  outline?: boolean;
  /** Leading `bi-*` studio icon class. */
  icon?: string;
  /** Native `disabled`. */
  disabled?: boolean;
}

export interface AlertProps {
  /** Visual treatment applied to the Alert. `neutral` is a note on the secondary surface with a hairline and no status accent. @default "primary" */
  variant?: 'primary' | 'success' | 'danger' | 'warning' | 'info' | 'neutral';
  /** `compact` is the inline note a panel carries: tighter padding, 13px text, a 14px glyph in the tone's text-safe ink. `neutral` + `compact` + `live="off"` is the static panel note. @default "default" */
  density?: 'default' | 'compact';
  /** Bold lead line. */
  title?: React.ReactNode;
  /** Content rendered inside the Alert. */
  children?: React.ReactNode;
  /** Override the default status icon (`bi-*` studio icon class). */
  icon?: string;
  /** Dismiss handler — shows a close button when provided. */
  onClose?: () => void;
  /**
   * Live-region politeness. Defaults by variant — `danger` announces
   * assertively (role="alert"), others politely (role="status").
   * Use "off" to silence, or force a level. A static note that is part of the
   * page rather than a new message — every `neutral` panel note — passes "off".
   */
  live?: 'assertive' | 'polite' | 'off';
  /**
   * Trailing verbs beside the body text: one `AlertAction`, an array of them (the first is
   * drawn first), or any node. The body and the verbs share one row — the verbs centred
   * against the text, the text taking the room left (240px basis) — and the verbs wrap under
   * the text in a narrow column. With a `title`, the row sits under the title.
   */
  action?: AlertAction | AlertAction[] | React.ReactNode;
  /** Cross-axis alignment of the icon and content. `center` centres the icon on a single-line, titleless alert whose height comes from its button. @default "start" */
  align?: 'start' | 'center';
  /** Style overrides for the Alert root. */
  style?: React.CSSProperties;
}

/**
 * Inline contextual message — tinted, left accent rule, status icon.
 */
export function Alert(props: AlertProps): React.JSX.Element;
