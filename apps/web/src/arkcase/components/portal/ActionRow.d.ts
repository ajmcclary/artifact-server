import React from 'react';

export interface ActionRowDate {
  /** Three-letter month, uppercased by the component. */
  month: React.ReactNode;
  day: React.ReactNode;
}

export interface ActionRowProps {
  /** Bootstrap icon name for the lead mark, e.g. "bi-file-earmark-check". */
  icon?: string;
  /** Date block lead — use instead of an icon when the row is a scheduled event. */
  date?: ActionRowDate;
  /** Visible title for the ActionRow. */
  title?: React.ReactNode;
  /** Second line — receipt and date, submitter, time and place. */
  meta?: React.ReactNode;
  /** A third line that qualifies the row: why it was cancelled, when it expires. */
  note?: React.ReactNode;
  /** Tones the note. @default "default" */
  noteTone?: 'default' | 'overdue' | 'due-soon';
  /** A StatusPill. */
  status?: React.ReactNode;
  /** The row's actions — two at most. */
  children?: React.ReactNode;
  /** Last row in the panel — drops the hairline. @default false */
  last?: boolean;
  /** Style overrides for the ActionRow root. */
  style?: React.CSSProperties;
}

/** The portal list row: lead mark, two lines, state, actions. */
export function ActionRow(props: ActionRowProps): React.JSX.Element;
