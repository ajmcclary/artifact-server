import React from 'react';
import { MetaChainItem } from './MetaChain';

export interface StateRowProps {
  /** State label for the StatusPill pinned right on line 1 — the row's own recorded condition.
   *  Ellipsised when the row is narrow; a string label is repeated in the pill's `title`. */
  state?: React.ReactNode;
  /** Tone of that state: what the row wants from the reader. Drawn in StatusPill's tones:
   *  attention → warning, running → primary, settled → success, failed → danger. */
  tone?: 'attention' | 'running' | 'settled' | 'failed' | 'neutral';
  /** The record's identifier, drawn in the data font. It never shrinks: a long `state` ellipsises instead. */
  id?: React.ReactNode;
  /** Short coded text right after the identifier, in the data font — a version such as '1.0.0'. */
  qualifier?: React.ReactNode;
  /** Where it sits — 'step 06 · review', 'stage 0'. Leads the meta line in the data font. */
  position?: React.ReactNode;
  /** The one sentence this state implies, clamped at two lines. */
  sentence?: React.ReactNode;
  /** Meta chain beneath, after `position` — see MetaChain. One line, ellipsised at the end. */
  meta?: MetaChainItem[];
  /** Selected: lights the 3px rail and tints the row. */
  selected?: boolean;
  /** Called on click, Enter and Space — the row is a SelectableRow. */
  onClick?: (e: React.SyntheticEvent) => void;
  /** Drops the role and the tab stop and sets aria-disabled. */
  disabled?: boolean;
  /** Style overrides for the StateRow root. */
  style?: React.CSSProperties;
  /** Content rendered inside the StateRow. */
  children?: React.ReactNode;
}

/** The record list row — identifier and state pill, sentence, then position and the meta chain on one line. */
export function StateRow(props: StateRowProps): React.JSX.Element;
