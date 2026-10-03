import React from 'react';

export interface RailTabItem {
  /** The view's key — what `active` holds and `onSelect` receives. */
  id: string;
  /** `bi-*` icon class — "bi-chat-square-text". Rendered at the shared 20px navigation size. */
  icon: string;
  /** The view's name, set vertically under the icon — "Comments". */
  label: string;
  /** Count pill under the icon — unresolved comments, files. Omit for none. */
  count?: React.ReactNode;
  /** `primary` for a count that asks for action, `neutral` for an inventory. @default "primary" */
  countTone?: 'primary' | 'neutral';
  /** Accessible name when the default `label — count` does not read well — "Comments, 3 unresolved". */
  ariaLabel?: string;
}

export interface RailTabsProps {
  /** One entry per inspector view, top to bottom. */
  items: RailTabItem[];
  /** The id of the open view, or null when the inspector is closed. @default null */
  active?: string | null;
  /** Fires with the entry's id on every press. Selecting the active id means close — the host toggles. */
  onSelect?: (id: string) => void;
  /** Show the vertical uppercase label under the icon and count. @default true */
  labels?: boolean;
  /** The edge the strip docks to; the rule sits on the inward edge and tooltips open away from it. @default "end" */
  side?: 'start' | 'end';
  /** A 32px footer slot under the entries — the inspector's pin. */
  footer?: React.ReactNode;
  /** Accessible name of the group. @default "Panels" */
  label?: string;
  /** Style overrides for the RailTabs root. */
  style?: React.CSSProperties;
}

/**
 * The 36px vertical tab strip an end- or start-edge inspector hangs off: one pressed-state
 * toggle per view with an icon, a count pill and a vertical label, a divider between
 * entries and a 32px footer slot for the pin. Arrow Up / Down move focus.
 */
export function RailTabs(props: RailTabsProps): React.JSX.Element;
