import React from 'react';

export interface PageScaffoldProps {
  /** The screen's title, in the band's `SectionHeading`. */
  title: React.ReactNode;
  /** The count chip beside the title — "12 users". */
  count?: React.ReactNode;
  /** The meta line beside the title — "Last synced 09:42". */
  meta?: React.ReactNode;
  /** Heading level of the title element. @default 2 */
  level?: 2 | 3 | 4 | 5 | 6;
  /** The screen's actions, at the end of the band. */
  actions?: React.ReactNode;
  /** The content column's maximum width, in px or any CSS length. @default 1000 */
  maxWidth?: number | string;
  /** Padding of the scrolling body. @default "14px 18px 24px" */
  bodyPadding?: number | string;
  /** Accessible name of the screen region and its `data-screen-label`. @default the title, when it is a string */
  label?: string;
  /** Style overrides for the PageScaffold root. */
  style?: React.CSSProperties;
  /** The screen's blocks, stacked in the capped column 14px apart. */
  children?: React.ReactNode;
}

/**
 * The frame for an admin or settings route: a card-surface band with the screen's
 * SectionHeading and actions, then a scrolling body holding one column capped at
 * `maxWidth`.
 */
export function PageScaffold(props: PageScaffoldProps): React.JSX.Element;
