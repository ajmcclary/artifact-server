import React from 'react';

export interface InputProps {
  /** Visible label naming the Input; a node may carry an accessory such as a "Pre-filled" Tag after the text. */
  label?: React.ReactNode;
  /** Controlled field value. */
  value?: string;
  /** Initial field value when uncontrolled. */
  defaultValue?: string;
  /** Hint shown before the field has a value. */
  placeholder?: string;
  /** @default "text" */
  /** Native HTML input type used for editing and validation. */
  type?: string;
  /** @default "md" */
  /** Visual size of the Input. */
  size?: 'sm' | 'md' | 'lg';
  /** Leading `bi-*` studio icon class, e.g. "bi-search". */
  icon?: string;
  /** Helper text below the field. */
  helper?: string;
  /** Error text — turns border + text red, overrides helper. */
  error?: string;
  /** Disables interaction with the Input. */
  disabled?: boolean;
  /** Marks the field required: native `required` plus `aria-required`, and a trailing `*` in `--text-overdue` after the visible label (hidden from assistive tech, which announces the required state). @default false */
  required?: boolean;
  /** Read-only state forwarded to the input element. */
  readOnly?: boolean;
  /** Move focus into the field on mount — a dialog's search field. @default false */
  autoFocus?: boolean;
  /** HTML id that associates the input with its label. */
  id?: string;
  /** Called with the native input change event after editing. */
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Forwarded after the internal focus state updates. */
  onFocus?: (e: React.FocusEvent<HTMLInputElement>) => void;
  /** Called when the field loses focus. */
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  /** Called for key presses in the field, e.g. Escape to clear a search. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Ref to the native input element, e.g. to focus it from a "/" shortcut. */
  inputRef?: React.Ref<HTMLInputElement>;
  /** Content inside the field border after the input, e.g. a divider and compact select or a clear button. */
  trailing?: React.ReactNode;
  /** Field shape: the standard radius, a fully rounded search pill, or `navy` — the app bar's search field (on-navy ink and placeholder over a faint white fill; use with `icon`, not `leading`/`trailing`). @default "default" */
  variant?: 'default' | 'pill' | 'navy';
  /** Content inside the field border before the input, after `icon`, e.g. a ColorSwatch. */
  leading?: React.ReactNode;
  /** Validation tone for border and status glyph; `error` text implies "error". Only "error" sets aria-invalid. */
  status?: 'error' | 'warning' | 'success' | 'info';
  /** Show the in-field status glyph. @default true when `status` is set, false for `error` text alone */
  statusIcon?: boolean;
  /** Set the value in the data font (`--font-data`) with tabular numerals, for token values and ids. @default false */
  mono?: boolean;
  /** Touch measure for phone columns: a 44px control, 0 × 12px padding and a 15px value. @default false */
  touch?: boolean;
  /** With `type="password"`, adds a trailing Show/Hide text button (`aria-pressed`) that switches the field between password and text; it follows any `trailing` content. Ignored for other types. @default false */
  revealable?: boolean;
  /** Visible labels of the reveal toggle as [show, hide]. @default ["Show", "Hide"] */
  revealLabels?: [React.ReactNode, React.ReactNode];
  /** Form field name forwarded to the input element. */
  name?: string;
  /** Native autocomplete hint forwarded to the input element, e.g. "off". */
  autoComplete?: string;
  /** Accessible name when there is no visible label. */
  'aria-label'?: string;
  /** Additional ids describing the input, merged with helper or error text. */
  'aria-describedby'?: string;
  /** Keyboard shortcut that focuses the field, e.g. "/". */
  'aria-keyshortcuts'?: string;
  /** Style overrides for the Input root. */
  style?: React.CSSProperties;
}

/**
 * Text input — Bootstrap `.form-control` with cyan focus ring, optional pill
 * shape, leading/trailing in-field content, validation status, data font, a
 * 44px touch measure and a Show/Hide toggle for password fields.
 */
export function Input(props: InputProps): React.JSX.Element;
