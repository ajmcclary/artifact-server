import React from 'react';

export interface GroupBandProps {
  /** Group name — 'Needs you', 'Running', 'Settled'. */
  label?: React.ReactNode;
  /** Count of rows in the group, appended after a middot. */
  count?: number | string;
  /** The rule that put rows here, right-aligned. */
  note?: React.ReactNode;
  /** Semantic color treatment of this state. */
  tone?: 'attention' | 'running' | 'settled' | 'failed' | 'neutral';
  /** Whether the group's rows are shown; emitted as `aria-expanded` when `onToggle` is set. @default false */
  open?: boolean;
  /** Makes the band a native disclosure button with a trailing chevron; called on activation. */
  onToggle?: () => void;
  /** Id of the element holding the group's rows, emitted as `aria-controls`. */
  controls?: string;
  /** Pins the band to the top of its scroller on an opaque fill. @default false */
  sticky?: boolean;
  /** Leading status dot: `true` uses the tone's rail colour, a string is a CSS colour. @default false */
  dot?: boolean | string;
  /** Style overrides for the GroupBand root. */
  style?: React.CSSProperties;
}

/** The group band inside a record list — rail, tint, name, count, rule; optionally a sticky disclosure button. */
export function GroupBand(props: GroupBandProps): React.JSX.Element;
