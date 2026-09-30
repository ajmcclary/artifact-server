import React from 'react';

export interface CountBadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'style' | 'children'> {
  /** The visible count, e.g. 3 or "99+". */
  count: number | string;
  /** `primary` (10% primary tint, on-tint link ink, semibold) asks for attention; `neutral` (canvas tint, data ink) is a plain total. @default 'neutral' */
  tone?: 'primary' | 'neutral';
  /** Spoken text replacing the bare number, e.g. "3 unresolved"; the visible count becomes aria-hidden. */
  label?: string;
  /** Data face for the digits; false uses Public Sans. @default true */
  mono?: boolean;
  /** Style overrides for the CountBadge root. */
  style?: React.CSSProperties;
}

/** Small tinted pill carrying a count beside a tab, title or row. */
export function CountBadge(props: CountBadgeProps): React.JSX.Element;
