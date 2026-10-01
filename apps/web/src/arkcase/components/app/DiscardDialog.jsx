import React from 'react';
import { ConfirmDialog } from './ConfirmDialog.jsx';

/**
 * ArkCase DiscardDialog — the unsaved-changes confirmation every host raises
 * before a dirty close, so a partial that edits a record asks rather than
 * announces. The `ConfirmDialog` preset: the message naming what is about to be
 * lost, Keep Editing (outline) and Discard Changes (danger, last, on the footer
 * band). The discard continuation runs after the dismiss, which is what lets
 * an embedded partial forward the ask to its host first and still run its own
 * close when Discard Changes is pressed.
 */
export function DiscardDialog({
  open = false,
  message,
  title = 'Unsaved changes',
  keepLabel = 'Keep Editing',
  discardLabel = 'Discard Changes',
  onClose,
  onDiscard,
  icon = 'bi-exclamation-triangle',
  zIndex = 1050,
  style,
  ...rest
}) {
  return (
    <ConfirmDialog
      open={open}
      title={title}
      message={message}
      icon={icon}
      cancelLabel={keepLabel}
      confirmLabel={discardLabel}
      tone="danger"
      onClose={onClose}
      onConfirm={onDiscard}
      zIndex={zIndex}
      style={style}
      {...rest}
    />
  );
}
