import React from 'react';

export interface EyebrowProps extends Omit<React.HTMLAttributes<HTMLElement>, 'style' | 'children'> {
  /** Element to render: a span in running chrome, a heading for a panel cap, label or dt beside a field.
   *  @default 'span' */
  as?: 'span' | 'div' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'label' | 'dt';
  /** Type step: `label` is the 11px micro-label, `xs` the 12px step a few denser caps use.
   *  @default 'label' */
  size?: 'label' | 'xs';
  /** Text token: `secondary` on light grounds, `navy` for brand ink, `on-navy` on the navy app chrome.
   *  @default 'secondary' */
  tone?: 'secondary' | 'navy' | 'on-navy';
  /** Clip to one line with an ellipsis; the host must constrain the width.
   *  @default false */
  truncate?: boolean;
  /** For `as="label"`: id of the control this label names. */
  htmlFor?: string;
  /** Label text. Write it in Title Case; the uppercase is visual only. */
  children?: React.ReactNode;
  /** Style overrides for the Eyebrow root. */
  style?: React.CSSProperties;
}

/** Uppercase micro-label for panel caps, section eyebrows and field-group names. */
export function Eyebrow(props: EyebrowProps): React.JSX.Element;
