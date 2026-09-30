import React from 'react';

export interface SelectOption {
  value: string;
  label: string;
}
export interface SelectProps {
  /** Visible label naming the Select; a node may carry an accessory after the text. */
  label?: React.ReactNode;
  /** Controlled field value. */
  value?: string;
  /** Initial field value when uncontrolled. */
  defaultValue?: string;
  /** Options as strings or {value,label} objects. */
  options?: (string | SelectOption)[];
  /** Children <option> elements, supported alongside or in place of options prop. */
  children?: React.ReactNode;
  /** @default "md" */
  /**
   * Visual size of the Select. `viewer` is the document-toolbar control: 30px tall, 12px text
   * (11px under 576px), 10px left and 30px right padding. `dock` is the footer-dock control:
   * 24px tall, 11px text, 6px left padding. Both draw a 10px chevron 9px from the end.
   */
  size?: 'viewer' | 'dock' | 'sm' | 'md' | 'lg';
  /**
   * `true` fits the width to the options (the native widest-option width) rather than 100%.
   * `"selected"` sizes the closed control to the option it currently shows, so a toolbar does
   * not reserve room for its longest choice: a hidden copy of that label, in the same font and
   * padding, shares one inline-grid cell with the select and sets its width (never wider than
   * the container; a longer label ellipsizes). It follows controlled values, user picks and form
   * resets. @default false
   */
  fit?: boolean | 'selected';
  /**
   * `bare` drops border, fill and own focus ring to sit inside another field (Input `trailing`);
   * it fits its contents and inherits font size. `flush` keeps the size's geometry, fill and a
   * focus indicator (an inset 2px `focus-ring-color` ring) but drops border and radius, for a
   * segment of a joined tool group whose container draws the outline. `navy` is the app bar's select on
   * `surface-header` (a language picker): `text-on-navy` ink and chevron, a `text-on-navy-secondary` hairline
   * (white on focus) and an 18% white fill; its options keep body ink on the popup. @default "default"
   */
  variant?: 'default' | 'bare' | 'flush' | 'navy';
  /** Helper text below the field, linked through aria-describedby. */
  helper?: string;
  /** Error text — turns the border red, sets aria-invalid, overrides helper. */
  error?: string;
  /** Disables interaction with the Select. */
  disabled?: boolean;
  /** Marks the field required: native `required` plus `aria-required`, and a trailing `*` in `--text-overdue` after the visible label (hidden from assistive tech). @default false */
  required?: boolean;
  /** Text of a leading empty-value option (`value=""`), e.g. "Select…", drawn before `options` or `children`; with `required`, native validation treats it as no choice. */
  placeholder?: string;
  /** HTML id that associates the select with its label. */
  id?: string;
  /** Accessible name when no visible label is available. */
  'aria-label'?: string;
  /** Called with the native select change event after choosing an option. */
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  /** Forwarded after the internal focus state updates. */
  onFocus?: (e: React.FocusEvent<HTMLSelectElement>) => void;
  /** Called when the field loses focus. */
  onBlur?: (e: React.FocusEvent<HTMLSelectElement>) => void;
  /** Additional CSS classes for the Select root — the wrapper `<div>` that also holds the label, the helper and `style` — not the `<select>` itself. Other unlisted props (`name`, `aria-*`, `data-*`) are forwarded to the `<select>`. */
  className?: string;
  /** Style overrides for the Select root wrapper (as `className`). */
  style?: React.CSSProperties;
}

/**
 * Dropdown select — Bootstrap `.form-select` with the brand chevron.
 */
export function Select(props: SelectProps): React.JSX.Element;
