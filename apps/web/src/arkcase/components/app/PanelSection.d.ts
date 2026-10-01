import React from 'react';

export interface PanelSectionProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  /** The section's name, drawn as the 11px uppercase Eyebrow heading. Omit for an untitled band. */
  title?: React.ReactNode;
  /** Heading level of the title. @default 3 */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** Controls at the end of the heading row, e.g. a link button. */
  actions?: React.ReactNode;
  /** Full-width `border-color` rule above the section; pass false for the first section of a column. @default true */
  divided?: boolean;
  /** `band` lays the section on the secondary ground — the closing band of a popover. @default "default" */
  tone?: 'default' | 'band';
  /** Gap between the heading and each body child, in px. @default 10 */
  gap?: number;
  /** Section padding. @default "14px 16px 16px" */
  padding?: number | string;
  /** Style overrides for the section. */
  style?: React.CSSProperties;
  /** The section's body. */
  children?: React.ReactNode;
}

/**
 * One titled section of a side panel or popover: an 11px uppercase heading over its body, a
 * full-width rule between sections, and a `band` tone for a closing band on the secondary ground.
 *
 * @startingPoint section="App" subtitle="Titled section of a side panel or popover" viewport="380x360"
 */
export function PanelSection(props: PanelSectionProps): React.JSX.Element;
