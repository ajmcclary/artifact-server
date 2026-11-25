import React from 'react';

export interface StatusMarkProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'style' | 'children'> {
  /** `bi-*` icon class, e.g. "bi-shield-check". Rendered tonal in the tone's pill foreground. */
  icon: string;
  /** Pill tone pair: `pill-<tone>-bg` ground with `pill-<tone>-fg` glyph. `secondary` is StatusPill's queued/inactive pair, so a list row's mark can wear its pill's tone. Any other value falls back to `primary`. @default 'primary' */
  tone?: 'success' | 'primary' | 'warning' | 'danger' | 'neutral' | 'secondary';
  /** Diameter in px; the glyph is about 0.47 of it. @default 44 */
  size?: number;
  /** Accessible name; makes the mark `role="img"`. Omit when a heading beside it says the same — it is then aria-hidden. */
  label?: string;
  /** Style overrides for the StatusMark root, e.g. a bottom margin. */
  style?: React.CSSProperties;
}

/** Round tinted icon mark heading an outcome. */
export function StatusMark(props: StatusMarkProps): React.JSX.Element;
