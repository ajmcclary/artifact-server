import React from 'react';

export interface SwitchProps {
  /** Visible label naming the Switch. On a two-sided switch it is kept for assistive technology only (e.g. "Bill annually"), since the side words are the visible text. */
  label?: React.ReactNode;
  /** Controlled checked state. */
  checked?: boolean;
  /** Initial checked state when uncontrolled. */
  defaultChecked?: boolean;
  /** Disables interaction with the Switch. */
  disabled?: boolean;
  /** HTML id that associates the switch with its label. */
  id?: string;
  /** Called with the native input change event after toggling. */
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Accessible name when there is no visible label, e.g. a switch in a settings row whose title sits in another column. */
  'aria-label'?: string;
  /** Ids of elements that name the switch, e.g. the settings row's title. */
  'aria-labelledby'?: string;
  /** Ids of elements that describe the switch, e.g. the row's help sentence. */
  'aria-describedby'?: string;
  /** Form field name forwarded to the input. */
  name?: string;
  /** `on-navy` redraws the switch for the navy header band: the off track is `surface-navy-strong` with a `text-on-navy-secondary` outline, the on track stays `bs-primary`, the knob stays white and text turns `text-on-navy`. @default 'default' */
  tone?: 'default' | 'on-navy';
  /** Word before the track naming the off side, e.g. "Monthly". With `offLabel` or `onLabel` the switch is two-sided: the side in effect is drawn in full ink at weight 600, the other in secondary ink, and clicking a word selects that side. */
  offLabel?: React.ReactNode;
  /** Word after the track naming the on side, e.g. "Annual". Names the switch when there is no `label`, `aria-label` or `aria-labelledby`. */
  onLabel?: React.ReactNode;
  /** Node after `onLabel`, e.g. a StatusPill "Save 10%". */
  badge?: React.ReactNode;
  /** Style overrides for the Switch root. */
  style?: React.CSSProperties;
}

/**
 * Toggle switch — Bootstrap `.form-switch`, cyan track when on; optionally two-sided
 * ("Monthly / Annual") and toned for the navy band.
 */
export function Switch(props: SwitchProps): React.JSX.Element;
