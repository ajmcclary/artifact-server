import React from 'react';

export interface DiscardDialogProps {
  /** Whether the confirmation is shown. */
  open?: boolean;
  /** What the reader is about to lose — the dialog names it back to them. */
  message?: React.ReactNode;
  /** Dialog title. @default 'Unsaved changes' */
  title?: React.ReactNode;
  /** Stay-on-the-form button label. @default 'Keep Editing' */
  keepLabel?: string;
  /** Discard button label. @default 'Discard Changes' */
  discardLabel?: string;
  /** Dismisses the dialog — Keep Editing and the close button. */
  onClose: () => void;
  /** Runs after the dismiss — the host's close continuation. */
  onDiscard: () => void;
  /** `bi-*` icon class for the navy title tile. @default 'bi-exclamation-triangle' */
  icon?: string;
  /** The backdrop's z-index; the frame sits one above. @default 1050 */
  zIndex?: number;
  /** Style overrides for the DiscardDialog root. */
  style?: React.CSSProperties;
}

/**
 * The unsaved-changes confirmation every host raises before a dirty close:
 * a small Modal with the message, Keep Editing (outline) and Discard Changes
 * (danger, last). The discard continuation runs after the dismiss so a partial
 * embedded in a host can forward the ask across the boundary first and still
 * run its own close when Discard Changes is pressed.
 *
 * @startingPoint section="App" subtitle="Unsaved-changes confirmation" viewport="700x150"
 */
export function DiscardDialog(props: DiscardDialogProps): React.JSX.Element | null;
