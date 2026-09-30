import React from 'react';

/** Presence state shown as a dot at the avatar's bottom-right. */
export type AvatarStatus = 'online' | 'away' | 'busy' | 'offline' | 'ready' | 'working';

export interface AvatarProps {
  /** Photo URL. When omitted, initials are shown. */
  src?: string;
  /** Full name — drives initials and the deterministic accent color. */
  name?: string;
  /** `bi-*` glyph for a non-person mark (the Illume assistant): the glyph in `text-secondary` on a `surface-tertiary` tile with a hairline border; the status dot then sits top-right, 3px out, with a 1px card-coloured border. Ignored when `src` is given. */
  icon?: string;
  /** Outline of an `icon` mark: `square` is the 4px-radius tile, `circle` the round one. People (photo or initials) are always circles. @default "square" */
  shape?: 'square' | 'circle';
  /** Explicit initials override. */
  initials?: string;
  /** Pixel diameter. @default 36 */
  size?: number;
  /** Force a background color (otherwise derived from name). */
  color?: string;
  /** Presence dot (bottom-right on a person, top-right on an `icon` mark); its label is appended to the accessible name. `ready` / `working` are an assistant's states. */
  status?: AvatarStatus;
  /** Spoken presence text, e.g. "Reviewing now". @default "Online" | "Away" | "Busy" | "Offline" */
  statusLabel?: string;
  /** Color of a 2px ring around the avatar and its dot, e.g. "var(--surface-header)" on navy. */
  ring?: string;
  /** Tooltip text for the avatar. */
  title?: string;
  /** Style overrides for the Avatar root. */
  style?: React.CSSProperties;
}

/**
 * Circular user marker — photo or initials on a brand-accent background, with
 * an optional presence dot and separating ring.
 */
export function Avatar(props: AvatarProps): React.JSX.Element;
