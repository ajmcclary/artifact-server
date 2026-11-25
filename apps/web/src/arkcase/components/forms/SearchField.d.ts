import React from 'react';

export interface SearchSuggestion {
  /** Stable key; defaults to the suggestion's position. */
  id?: string;
  /** Text of the suggestion, e.g. a completed query. */
  label: string;
  /** Optional second line in 12px `text-secondary`, e.g. "Saved search · 14 matches". */
  description?: React.ReactNode;
  /** `bi-*` glyph before the label. @default the field's `icon` */
  icon?: string;
  /** Called when this suggestion is picked; takes precedence over `onSuggestionSelect`. */
  onSelect?: (suggestion: SearchSuggestion) => void;
}

export interface SearchFieldProps {
  /** Controlled text of the field. @default "" */
  value?: string;
  /** Called with the new text (a string, not the event) on every edit, and with a picked suggestion's label when no select handler is given. */
  onChange?: (value: string) => void;
  /** Called with the trimmed text when Enter is pressed with no suggestion active, or with a picked suggestion's label when no select handler is given. */
  onSubmit?: (value: string) => void;
  /** Called by the clear button; without it the clear button calls `onChange('')`. Focus returns to the field either way. */
  onClear?: () => void;
  /** Suggestions for the current text, as strings or objects; the host filters them. Shown as a listbox while the field is being edited. @default [] */
  suggestions?: (string | SearchSuggestion)[];
  /** Called with a picked suggestion that has no `onSelect` of its own. */
  onSuggestionSelect?: (suggestion: SearchSuggestion) => void;
  /** Visible label above the field (a node is allowed); omit it and pass `aria-label` in a toolbar. */
  label?: React.ReactNode;
  /** Accessible name when there is no visible label, e.g. "Search term". */
  'aria-label'?: string;
  /** Hint shown in the empty field. */
  placeholder?: string;
  /** Input size: `sm` is the 32px results bar, `md` the 38px landing field, `lg` a hero search. @default "sm" */
  size?: 'sm' | 'md' | 'lg';
  /** Leading `bi-*` glyph inside the field. @default "bi-search" */
  icon?: string;
  /** Accessible name and tooltip of the clear button, shown while the field has text. @default "Clear search term" */
  clearLabel?: string;
  /** Accessible name of the suggestion listbox. @default "{label or aria-label} suggestions", else "Suggestions" */
  suggestionsLabel?: string;
  /** Natively disables the field; the list stays closed. @default false */
  disabled?: boolean;
  /** Focus the field on mount. @default false */
  autoFocus?: boolean;
  /** Id of the input; the listbox takes `{id}-listbox`. Generated when omitted. */
  id?: string;
  /** Ref to the native input, e.g. to focus it from a "/" shortcut. While `collapsed` and the popover is closed it holds a hidden, untabbable stand-in input (same value) whose `focus()` opens the popover and focuses the field; once the popover opens it holds the field itself. */
  inputRef?: React.Ref<HTMLInputElement>;
  /** Called before the field's own key handling; call `preventDefault()` to skip it. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Called when the field gains focus. */
  onFocus?: (e: React.FocusEvent<HTMLInputElement>) => void;
  /** Called when the field loses focus. */
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  /** Most suggestions listed at once. @default 8 */
  maxSuggestions?: number;
  /** Field shape: standard radius or a rounded pill. @default "default" */
  variant?: 'default' | 'pill';
  /** `false` makes a plain search box (`role="searchbox"`) with no suggestion listbox or combobox attributes — a toolbar search that filters in place; `suggestions` are then ignored. @default true */
  suggest?: boolean;
  /** Fold the field to a small icon button that opens it in a popover (bottom end), so a short toolbar row stays one row. While the field holds text the icon fills primary and its tooltip quotes the query. The host decides when to fold. If the field has focus when this flips, the field that mounts takes focus with the same caret: folding opens the popover, unfolding focuses the inline field. Unfolding always closes the popover. Keep the SearchField at the same place in the host's tree across the flip so it is not remounted. @default false */
  collapsed?: boolean;
  /** Width of the folded field's popover, in px. @default 284 */
  popoverWidth?: number;
  /** Keyboard shortcut that focuses the field, e.g. "/". While folded it is also set on the icon button. The host still handles the key, e.g. by focusing `inputRef`. */
  'aria-keyshortcuts'?: string;
  /** Style overrides for the SearchField root (the positioned wrapper). */
  style?: React.CSSProperties;
}

/** Search box with a suggestion listbox (ARIA 1.2 combobox), a leading glyph and a clear button; `suggest={false}` is a plain searchbox and `collapsed` folds it to an icon that opens it in a popover. */
export function SearchField(props: SearchFieldProps): React.JSX.Element;
