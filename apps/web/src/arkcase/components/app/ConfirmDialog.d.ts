import React from 'react';

export interface ConfirmDialogProps {
  /** Whether the confirmation is shown. */
  open?: boolean;
  /** The question, naming the object: "Delete Inspector docking study?". */
  title?: React.ReactNode;
  /** What changes and what cannot be undone, in one or two sentences. */
  message?: React.ReactNode;
  /** The confirm verb, last in the footer band. @default 'Confirm' */
  confirmLabel?: string;
  /** `bi-*` studio icon class leading the confirm verb. */
  confirmIcon?: string;
  /** The stay button. @default 'Cancel' */
  cancelLabel?: string;
  /** `danger` for a destructive change; `primary` for a weighty one that loses nothing. @default 'danger' */
  tone?: 'danger' | 'primary';
  /** `bi-*` studio icon class for the navy title tile. */
  icon?: string;
  /** Dismisses the dialog — Cancel, the close button and Escape. */
  onClose: () => void;
  /** Runs after the dismiss when the confirm verb is pressed. */
  onConfirm: () => void;
  /** Natively disables the confirm verb, e.g. while a typed confirmation is incomplete. @default false */
  disabled?: boolean;
  /** The backdrop's z-index; the frame sits one above. @default 1050 */
  zIndex?: number;
  /** Style overrides for the dialog frame. */
  style?: React.CSSProperties;
  /** Extra content under the message, e.g. a FieldGrid of what moves. */
  children?: React.ReactNode;
}

/**
 * The confirmation before an action the host cannot take back: a small Modal whose title
 * asks the question, a message naming what changes, then Cancel (outline) and the confirm
 * verb (danger, or primary), last on the footer band. Confirming dismisses first and then
 * runs `onConfirm`. `DiscardDialog` is its unsaved-changes preset.
 *
 * @startingPoint section="App" subtitle="Confirmation before an irreversible action" viewport="700x150"
 */
export function ConfirmDialog(props: ConfirmDialogProps): React.JSX.Element | null;
