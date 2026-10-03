import React from 'react';

export interface AuthLayoutPoint {
  /** `bi-*` icon class drawn 16px, tonal on navy. */
  icon?: string;
  /** The point's sentence, 14px secondary-on-navy. */
  text: React.ReactNode;
}

export interface AuthLayoutProps {
  /** Lock-up for the brand aside, e.g. `<BrandLock tone="reversed" size={17} product="Artifact Server" />`. */
  brand?: React.ReactNode;
  /** Lock-up for the narrow top bar, e.g. a BrandLock at size 15. Defaults to `brand`. */
  brandCompact?: React.ReactNode;
  /** Serif 30px headline in the aside — the page's h1 (kept as a visually hidden h1 when stacked). */
  headline?: React.ReactNode;
  /** One sentence under the headline, 15px secondary-on-navy. */
  lead?: React.ReactNode;
  /** Icon-and-text points listed under the lead. */
  points?: AuthLayoutPoint[];
  /** Closing line at the foot of the aside, above a navy hairline. */
  asideFooter?: React.ReactNode;
  /** Page footer under the stage: the ways out, the origin line. */
  footer?: React.ReactNode;
  /** Accessible name of the brand aside (complementary landmark). @default "About this service" */
  asideLabel?: string;
  /** Maximum width of the centred stage column in px. @default 440 */
  columnWidth?: number;
  /** Root width in px from which the split layout is drawn when `layout` is "auto". @default 1024 */
  breakpoint?: number;
  /** `auto` follows the root width; `split` and `stacked` pin an arrangement (stories, fixed frames). @default "auto" */
  layout?: 'auto' | 'split' | 'stacked';
  /** Stage column content — usually a flush AuthCard. */
  children?: React.ReactNode;
  /** Style overrides for the AuthLayout root. */
  style?: React.CSSProperties;
}

/**
 * The split auth page: a navy brand aside beside a centred stage column, giving
 * way to a navy top bar below the breakpoint.
 */
export function AuthLayout(props: AuthLayoutProps): React.JSX.Element;
