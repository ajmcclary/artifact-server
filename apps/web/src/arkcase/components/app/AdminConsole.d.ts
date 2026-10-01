import React from 'react';

export interface AdminConsoleProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** The area menu at the start edge, usually a `SideNav` the host pins or peeks; omit on a phone. */
  nav?: React.ReactNode;
  /** The heading band's content: a `SectionHeading` with a `Breadcrumb` eyebrow and the area's lede. */
  heading?: React.ReactNode;
  /** Accessible name of the scrolling content region — the area's name. */
  label: string;
  /** Docked at the content's end edge: a `SlideOver` for the selected row. */
  inspector?: React.ReactNode;
  /** Rendered last, outside the layout: confirmations such as `ConfirmDialog`. */
  overlay?: React.ReactNode;
  /** Measure of the content column. @default 1360 */
  maxWidth?: number | string;
  /** The area's panels, e.g. a `RecordPanel` over a `DataGrid`. */
  children?: React.ReactNode;
  /** Style overrides for the root. */
  style?: React.CSSProperties;
}

/**
 * The administration layout: an area menu, a heading band on the card surface, then a named
 * scrolling region of list panels on the canvas with an optional inspector docked at its end.
 *
 * @startingPoint section="App" subtitle="Administration layout: area menu, heading band, panels and inspector" viewport="1200x600"
 */
export function AdminConsole(props: AdminConsoleProps): React.JSX.Element;
