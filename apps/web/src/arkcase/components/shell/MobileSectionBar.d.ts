import React from 'react';

export interface MobileSection {
  /** Stable id; matched against `activeId`. */
  id: string;
  /** Tab label. */
  label: string;
  /** Count chip after the label; zero draws nothing. */
  count?: number;
  /** Group heading in the all-sections sheet — "Case", "Process", "Record". */
  group?: string;
}

export interface MobileSectionBarProps extends Omit<React.HTMLAttributes<HTMLElement>, 'style' | 'onSelect'> {
  /** Every section, in order. @default [] */
  sections?: MobileSection[];
  /** `id` of the section on screen — marked `aria-current="page"` and kept in view. */
  activeId?: string;
  /** Called with the chosen section, from the strip or the sheet. Replace the view; do not push history. */
  onSelect?: (section: MobileSection) => void;
  /** `aria-label` of the navigation landmark, and the sheet's default title. @default "Sections" */
  label?: string;
  /** Accessible name of the list button that opens the sheet. @default "All sections" */
  allLabel?: string;
  /** Title of the all-sections sheet. @default label */
  sheetTitle?: React.ReactNode;
  /** Stick beneath the app bar. @default true */
  sticky?: boolean;
  /** Sticky offset. @default "calc(var(--mobile-app-bar-height) + env(safe-area-inset-top))" */
  top?: number | string;
  /** Stacking order while sticky — under the app bar. @default 10 */
  zIndex?: number;
  /** Style overrides for the bar. */
  style?: React.CSSProperties;
}

/**
 * A record's sections on a phone: one line of underline tabs that scrolls sideways, sticky under
 * the `MobileAppBar` with `shadow-md` once docked, and a list button that opens every section,
 * grouped, in a `BottomSheet`.
 */
export function MobileSectionBar(props: MobileSectionBarProps): React.JSX.Element;
