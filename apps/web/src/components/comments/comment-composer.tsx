import {useRef, useState, type ComponentProps, type CSSProperties} from "react";

import {Button, CommentComposer as ComposerField} from "@/arkcase";

export interface CommentComposerProps {
  readonly autoFocus?: boolean;
  readonly cancelLabel: string | null;
  /** True when `initialBody` came out of the draft store, not the caller. */
  readonly draftRestored?: boolean;
  readonly initialBody: string;
  readonly label: string;
  readonly maximumCharacters: number;
  /** Draft wiring: hears every edit, including the clearing submit/discard. */
  readonly onBodyChange?: (body: string) => void;
  readonly onCancel: (() => void) | null;
  readonly onDiscardDraft?: () => void;
  readonly onSubmit: (body: string, idempotencyKey: string) => Promise<boolean>;
  readonly submitLabel: string;
}

const draftMetaStyle = {alignItems: "center", display: "inline-flex", gap: 6} satisfies CSSProperties;

/**
 * Bounded comment body editor.
 *
 * One mounted composer is one compose attempt: its idempotency key is minted
 * on the first submission and reused for every retry until the server accepts
 * the text, so a retried create can never duplicate a comment.
 */
export function CommentComposer({
  autoFocus = false,
  cancelLabel,
  draftRestored = false,
  initialBody,
  label,
  maximumCharacters,
  onBodyChange,
  onCancel,
  onDiscardDraft,
  onSubmit,
  submitLabel,
}: CommentComposerProps) {
  const [body, setBody] = useState(initialBody);
  const [pending, setPending] = useState(false);
  const attemptKey = useRef<string | null>(null);
  const trimmed = body.trim();

  const submit = async (value: string): Promise<void> => {
    if (value === "" || value.length > maximumCharacters) return;
    attemptKey.current ??= crypto.randomUUID();
    setPending(true);
    const accepted = await onSubmit(value, attemptKey.current);
    setPending(false);
    if (!accepted) return;
    attemptKey.current = null;
    setBody("");
    onBodyChange?.("");
  };

  const discardDraft = (): void => {
    setBody("");
    onDiscardDraft?.();
  };

  const field: ComponentProps<typeof ComposerField> = {
    autoFocus,
    disabled: pending,
    label,
    maxLength: maximumCharacters,
    onChange: (value) => {
      setBody(value);
      onBodyChange?.(value);
    },
    onSubmit: (value) => void submit(value),
    overLimitMessage: (over, limit) => `A comment holds at most ${limit} characters. Remove ${over}.`,
    placeholder: "Describe what should change and why.",
    rows: 3,
    submitLabel: pending ? "Saving…" : submitLabel,
    value: body,
    variant: "block",
  };
  if (onCancel !== null && cancelLabel !== null) {
    field.cancelLabel = cancelLabel;
    field.onCancel = onCancel;
  }
  if (draftRestored && trimmed !== "") {
    field.meta = (
      <span style={draftMetaStyle}>
        <span data-draft-marker="">Draft</span>
        {onDiscardDraft === undefined ? null : (
          <Button flush onClick={discardDraft} size="xs" variant="link">Discard</Button>
        )}
      </span>
    );
  }
  // The DS marks only its prompt variant; the block root forwards the hook for tests and styling.
  return <ComposerField {...field} data-comment-composer="block" />;
}
