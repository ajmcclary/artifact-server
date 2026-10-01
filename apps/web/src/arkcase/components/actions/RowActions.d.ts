import React from 'react';
import type { MenuItem } from '../overlays/Menu';

export interface RowActionsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** The kebab's Menu entries; falsy entries are dropped. No entries, no kebab. */
  items?: Array<MenuItem | null | false | undefined>;
  /** Accessible name of the kebab and its Menu, naming the row: "More actions for v5". @default "More actions" */
  menuLabel?: string;
  /** Width of the floating Menu in px. @default 210 */
  menuWidth?: number | string;
  /** Quick IconButtons (size xs) revealed with the kebab, e.g. Preview. */
  quick?: React.ReactNode;
  /** Marks that show at rest, before the revealed actions, e.g. a "Current" StatusPill. */
  persistent?: React.ReactNode;
  /** Keep the actions visible — touch, where there is no hover. @default false */
  always?: boolean;
  /** The row, as a function of the actions node to place in it (e.g. a LinkRow's `actions`). */
  children: React.ReactNode | ((actions: React.ReactNode) => React.ReactNode);
  /** Style overrides for the wrapper. */
  style?: React.CSSProperties;
}

/**
 * Row actions revealed on hover or focus — quick IconButtons and a kebab whose Menu floats
 * over the rows below. Wraps the host's row and hands it the actions node to place.
 *
 * @startingPoint section="Actions" subtitle="Hover- and focus-revealed row actions with a kebab menu" viewport="460x260"
 */
export function RowActions(props: RowActionsProps): React.JSX.Element;
