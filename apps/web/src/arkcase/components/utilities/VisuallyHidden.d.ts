import React from 'react';

/** The clip-pattern style object, for hosts that must spread it onto their own element. */
export const visuallyHiddenStyle: React.CSSProperties;

export interface VisuallyHiddenProps extends Omit<React.HTMLAttributes<HTMLElement>, 'style' | 'children'> {
  /** Element to render: `span` inside phrasing content, `div` for block content, `a` for a skip link.
   *  @default 'span' */
  as?: 'span' | 'div' | 'a' | 'p' | 'h2' | 'h3' | 'label';
  /** Reveal the content while it or a descendant has focus, for skip links. The host styles the revealed state through `style`.
   *  @default false */
  focusable?: boolean;
  /** For `as="a"`: the skip link's target, e.g. "#main". */
  href?: string;
  /** Text read by assistive technology but not shown. */
  children?: React.ReactNode;
  /** Element styles. The clip pattern overrides them while hidden, so with `focusable` they are the revealed look. */
  style?: React.CSSProperties;
}

/** Content kept in the accessibility tree but removed from view. */
export function VisuallyHidden(props: VisuallyHiddenProps): React.JSX.Element;
