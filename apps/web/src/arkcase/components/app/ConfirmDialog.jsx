import React from 'react';
import { Modal } from '../overlays/Modal.jsx';
import { Button } from '../actions/Button.jsx';

/**
 * ArkCase ConfirmDialog — the small Modal every host raises before an action it cannot
 * take back: delete an artifact, revoke a key, deactivate a member, make a link private.
 * The title asks the question ("Revoke the CI key?"), the message names what changes,
 * and the footer band carries Cancel (outline) and the confirm verb last — `danger` for
 * a destructive change, `primary` for a weighty one that loses nothing. The confirm
 * continuation runs after the dismiss, so a host may close first and then act.
 */
export function ConfirmDialog({
  open = false,
  title,
  message,
  confirmLabel = 'Confirm',
  confirmIcon,
  cancelLabel = 'Cancel',
  tone = 'danger',
  icon,
  onClose,
  onConfirm,
  disabled = false,
  zIndex = 1050,
  style,
  children,
  ...rest
}) {
  if (!open) return null;
  const confirm = () => {
    if (disabled) return;
    if (onClose) onClose();
    if (onConfirm) onConfirm();
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
          <Button variant="outline-secondary" onClick={onClose}>{cancelLabel}</Button>
          <Button variant={tone === 'primary' ? 'primary' : 'danger'} icon={confirmIcon} disabled={disabled} onClick={confirm}>{confirmLabel}</Button>
        </>
      }
      {...rest}
    >
      {message != null && message !== '' && (
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
      )}
      {children}
    </Modal>
  );
}
