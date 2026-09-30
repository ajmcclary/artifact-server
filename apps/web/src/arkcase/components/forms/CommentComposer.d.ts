import React from 'react';

export interface CommentComposerProps {
  /** Controlled draft text; the host owns it and clears it after a post. @default "" */
  value?: string;
  /** Called with the new draft string (not the change event) on every edit. */
  onChange?: (value: string) => void;
  /** Called with the trimmed draft when the button, Cmd/Ctrl+Enter or (inline) Enter posts; never called while the draft is blank. */
  onSubmit?: (value: string) => void;
  /** Hint shown in the empty field. */
  placeholder?: string;
  /** Accessible name of the field, e.g. "Comment on this build". */
  label: string;
  /** Label of the submit button — an imperative verb such as "Comment" or "Send"; in `prompt` it is the icon-only button's accessible name and tooltip. @default "Post" ("Send" for prompt) */
  submitLabel?: string;
  /** Helper line tied to the field by aria-describedby, e.g. an audience note and a ShortcutKey for ⌘↵. */
  hint?: React.ReactNode;
  /** Name of the person posting; shows a leading Avatar (32px block, 24px inline). */
  author?: string;
  /** Visible textarea lines in the block variant. @default 2 */
  rows?: number;
  /** `inline` = one-line field with the button beside it; `block` = textarea with the hint and button under it; `prompt` = the assistant prompt: a bordered box holding a borderless 13px textarea and a 30px icon-only submit, the hint row (11px) under it. @default "block" */
  variant?: 'inline' | 'block' | 'prompt';
  /** Plain Enter posts (Shift+Enter still types a newline in block and prompt). Cmd/Ctrl+Enter always posts. @default true for inline and prompt, false for block */
  submitOnEnter?: boolean;
  /** Called on Escape in the field (default prevented, propagation stopped) — return focus to the control that opened the composer. Without it, Escape calls `onCancel` when that is set. */
  onEscape?: () => void;
  /** Adds an outline Cancel button before submit (block and inline), for editing an existing note; the host leaves edit mode and restores its draft. */
  onCancel?: () => void;
  /** Label of the Cancel button. @default "Cancel" */
  cancelLabel?: string;
  /** `bi-*` glyph leading the submit label (block and inline), e.g. "bi-check2"; in `prompt` it replaces the send arrow. @default "bi-arrow-up" in prompt */
  submitIcon?: string;
  /** Character limit. Nothing is truncated: past it the hint becomes an over-limit message in `--text-overdue`, the field is `aria-invalid` and submit stays disabled until the draft is shortened. */
  maxLength?: number;
  /** Draft length at which the data-face counter ("N left" in `--text-due-soon`, "N over" in `--text-overdue`) appears. @default 75% of maxLength */
  countFrom?: number;
  /** Over-limit message in place of the hint, or a function of the characters over and the limit. @default "{n} characters over the {limit} limit — shorten it; nothing is cleared." */
  overLimitMessage?: React.ReactNode | ((over: number, limit: number) => React.ReactNode);
  /** Quiet 11px note at the right of the hint row, after the counter, e.g. "Draft saved". */
  meta?: React.ReactNode;
  /** In `prompt`: replaces the field with a `surface-secondary` status line (`role="status"`) and a dark Stop button while an answer is produced; submit is blocked. @default false */
  busy?: boolean;
  /** Called by the Stop button shown while `busy`. */
  onStop?: () => void;
  /** Status sentence shown while `busy`, e.g. "Illume is answering". @default "Working" */
  busyLabel?: React.ReactNode;
  /** Label of the Stop button. @default "Stop" */
  stopLabel?: string;
  /** Natively disables the field and the button. @default false */
  disabled?: boolean;
  /** Ref to the native input or textarea for host-managed focus. */
  inputRef?: React.Ref<HTMLInputElement | HTMLTextAreaElement>;
  /** Focus the field on mount — a reply box opened by a Reply action. @default false */
  autoFocus?: boolean;
  /** Style overrides for the composer root. */
  style?: React.CSSProperties;
}

/**
 * Labelled comment field with a submit button that is disabled while the draft is blank.
 */
export function CommentComposer(props: CommentComposerProps): React.JSX.Element;
