import React from 'react';

export interface CheckboxProps {
  /** Visible label naming the Checkbox; a node may carry inline emphasis, e.g. a consent sentence with a `<strong>` name. */
  label?: React.ReactNode;
  /** Controlled checked state. */
  checked?: boolean;
  /** Initial checked state when uncontrolled. */
  defaultChecked?: boolean;
  /** Disables interaction with the Checkbox. */
  disabled?: boolean;
  /** Render as a radio control instead of a checkbox. @default false */
  radio?: boolean;
  /** HTML id that associates the input with its label. */
  id?: string;
  /** Called with the native input change event after toggling. */
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Secondary line under the label (12px `--text-secondary`); wired to the input with aria-describedby, not part of its name. */
  description?: React.ReactNode;
  /** Data-font value inline after the label (11px `--font-data`, `--text-data`), e.g. a scope such as `artifact:read`; also an accessible description. */
  meta?: React.ReactNode;
  /** Additional ids describing the input, merged with `meta` and `description`. */
  'aria-describedby'?: string;
  /** Accessible name when there is no visible label. */
  'aria-label'?: string;
  /** Form field name forwarded to the input; radios in one group share it. */
  name?: string;
  /** Style overrides for the Checkbox root. */
  style?: React.CSSProperties;
}

/**
 * Checkbox / radio — Bootstrap `.form-check-input`, ArkCase blue when active, with an
 * optional inline data `meta` and a secondary `description` line.
 */
export function Checkbox(props: CheckboxProps): React.JSX.Element;
