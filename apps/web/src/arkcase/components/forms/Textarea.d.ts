import React from 'react';

export interface TextareaProps {
  /** Visible label naming the Textarea; a node may carry an accessory after the text. */
  label?: React.ReactNode;
  /** Controlled field value. */
  value?: string;
  /** Initial field value when uncontrolled. */
  defaultValue?: string;
  /** Hint shown before the field has a value. */
  placeholder?: string;
  /** Visible text lines. @default 4 */
  rows?: number;
  /** Marks the field required: native `required` plus `aria-required`, and a trailing `*` in `--text-overdue` after the visible label (hidden from assistive tech). @default false */
  required?: boolean;
  /** Helper text below the field. */
  helper?: string;
  /** Error text — turns border + text red, overrides helper. */
  error?: string;
  /** Disables interaction with the Textarea. */
  disabled?: boolean;
  /** HTML id that associates the textarea with its label. */
  id?: string;
  /** Called with the native textarea change event after editing. */
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  /** Forwarded after the internal focus state updates. */
  onFocus?: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
  /** Called when the field loses focus. */
  onBlur?: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
  /** Style overrides for the Textarea root. */
  style?: React.CSSProperties;
  /** Ref to the native textarea for host-managed composer focus. */
  inputRef?: React.Ref<HTMLTextAreaElement>;
  /** Native field style overrides; root layout remains controlled by style. */
  inputStyle?: React.CSSProperties;
  /** Set the value in the data font (`--font-data`) at 12px in `--text-data` ink, for tokens, keys and code. @default false */
  mono?: boolean;
  /** Native keyboard events for host commands such as Command+Enter. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

/**
 * Labelled multiline input — Bootstrap `.form-control` with cyan focus ring.
 */
export function Textarea(props: TextareaProps): React.JSX.Element;
