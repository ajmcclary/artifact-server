import React from 'react';

export interface AuthCardProps {
  /** Visible title for the AuthCard. */
  title?: React.ReactNode;
  /** One sentence on what signing in gives access to. */
  subtitle?: React.ReactNode;
  /** The two ways out — forgot password, create an account. */
  links?: React.ReactNode;
  /** @default 380 */
  /** Requested width of the AuthCard. */
  width?: number | string;
  /** Node above everything in the card, e.g. a 44px status icon circle on a success or "sent" screen. */
  mark?: React.ReactNode;
  /** Node directly above the title, e.g. a StatusPill naming the outcome. */
  badge?: React.ReactNode;
  /** Title scale: `md` is the 22px card heading; `lg` the 25px (line-height 1.22) heading of a full-page auth column. @default "md" */
  titleSize?: 'md' | 'lg';
  /** Drop the outer 40px × 20px padding wrapper, for a layout (AuthLayout) that already provides the stage. @default false */
  flush?: boolean;
  /** Content rendered inside the AuthCard. */
  children?: React.ReactNode;
  /** Style overrides for the AuthCard root. */
  style?: React.CSSProperties;
}

/** The centred card sign-in, verification and registration sit in. */
export function AuthCard(props: AuthCardProps): React.JSX.Element;
