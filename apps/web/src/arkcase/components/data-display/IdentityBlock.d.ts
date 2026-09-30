import React from 'react';

/** Avatar options for IdentityBlock; initials fall back to the name's. */
export interface IdentityBlockAvatar {
  /** Explicit initials, e.g. "DO". */
  initials?: string;
  /** Avatar diameter in px. @default 32 */
  size?: number;
}

export interface IdentityBlockProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'children'> {
  /** The person's display name, 14px semibold. */
  name?: string;
  /** The one detail line — an email, username or role. */
  detail?: string;
  /** Set the detail in the data face at 14px `text-data` (emails, ids); otherwise 12px `text-secondary` Public Sans (roles). @default false */
  detailMono?: boolean;
  /** Show a leading Avatar (32px by default) derived from `name`; pass an object to set initials or size. @default false */
  avatar?: boolean | IdentityBlockAvatar;
  /** Visible label of the trailing link action, e.g. "Change". Rendered only with `onAction`. */
  actionLabel?: string;
  /** Called when the trailing link action is activated. */
  onAction?: (e: React.MouseEvent) => void;
  /** Set the block in a secondary-surface box with a hairline border (sign-in cards). @default false */
  framed?: boolean;
  /** Style overrides for the IdentityBlock root. */
  style?: React.CSSProperties;
}

/** Compact who-is-this summary: avatar, name, one detail line, optional link action. */
export function IdentityBlock(props: IdentityBlockProps): React.JSX.Element;
