import React from 'react';
import { Modal } from '../overlays/Modal.jsx';
import { Button } from '../actions/Button.jsx';

/**
 * ArkCase DiscardDialog — the unsaved-changes confirmation every host raises
 * before a dirty close, so a partial that edits a record asks rather than
 * announces. One small Modal: the message naming what is about to be lost,
 * Keep Editing (outline) and Discard Changes (danger, last, on the footer
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
  if (!open) return null;
  const discard = () => {
    if (onClose) onClose();
    if (onDiscard) onDiscard();
  };
  return (
    <Modal
      open={open}
      title={title}
      icon={icon}
      size="sm"
      onClose={onClose}
      zIndex={zIndex}
      style={style}
      footer={
        <>
          <Button variant="outline-secondary" onClick={onClose}>
            {keepLabel}
          </Button>
          <Button variant="danger" onClick={discard}>
            {discardLabel}
          </Button>
        </>
      }
      {...rest}
    >
      <p
        style={{
          margin: 0,
          fontSize: 'var(--font-size-sm, 14px)',
          lineHeight: 'var(--line-height-normal, 1.5)',
          color: 'var(--text-body, #212529)',
        }}
      >
        {message}
      </p>
    </Modal>
  );
}
