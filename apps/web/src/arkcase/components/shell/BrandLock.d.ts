import * as React from 'react';

export interface BrandLockProps extends Omit<React.HTMLAttributes<HTMLElement>, 'style' | 'onClick'> {
  /** Product name drawn after a hairline divider, e.g. "ExtractionKit". Omitted, the lock-up is the brand alone. */
  product?: React.ReactNode;
  /** Wordmark height in px. The emblem is sized from it unless `emblemSize` says otherwise. Default 20. */
  size?: number;
  /** Emblem height in px. Default `Math.round(size * 1.4)`. */
  emblemSize?: number;
  /** Draw the emblem. Default true. */
  emblem?: boolean;
  /** Draw the wordmark. Default true. Both false leaves the accessible name as text. */
  wordmark?: boolean;
  /** `reversed` for the navy application bar, `ink` for a light surface, `color` for full brand palette. Default `reversed`. */
  tone?: 'reversed' | 'ink' | 'color';
  /** Gap between the emblem, the wordmark and the product name, in px. Default 10. */
  gap?: number;
  /** Accessible name of the wordmark. Default "ArkCase". */
  label?: string;
  /**
   * Makes the lock-up the home control: a `<button type="button">` around the mark that
   * calls this on activation. Its hit area is padded 4px 6px and pulled back by a -6px side
   * margin, so the mark does not move; hover takes `surface-navy-strong` (reversed tone) or
   * `tint-primary-hover` (ink and color tones), and keyboard focus adds the `focus-ring`
   * glow to the global focus outline. Works for the emblem-only rail form too.
   */
  onClick?: React.MouseEventHandler<HTMLElement>;
  /** Makes the lock-up the home control as an `<a href>` instead of a button, with the same hit area, hover and focus as `onClick`. */
  href?: string;
  /** Accessible name of the home control (button or link). @default `${label}, home` */
  homeLabel?: string;
  /** Style overrides for the root: the lock-up, or the home button/link when `onClick` or `href` is given. Other root props land on the same element. */
  style?: React.CSSProperties;
}

/**
 * The ArkCase emblem and wordmark as one lock-up, with an optional product name.
 * The path data is inlined, so it needs no asset origin and no per-project copy.
 */
export declare function BrandLock(props: BrandLockProps): React.JSX.Element;
