import React from 'react';

/* Private field chrome shared by Input, Textarea and Select: the control/label/message
   IDs, the visible label with its required mark, and the helper/error line. Each field
   keeps its own native control, events, ref, sizes and wrappers. Not a public export. */

// The text-side padding of a normal-size field (Input md, Textarea, Select md).
export const FIELD_PAD_Y = 'var(--space-input-padding-y, 0.375rem)';
export const FIELD_PAD_X = 'var(--space-input-padding-x, 0.625rem)';

/** The control ID: the caller's `id`, else a generated one. */
export function useFieldId(id) {
  const generatedId = React.useId();
  return id || generatedId;
}

/** The label's own ID, for a group the label names (Textarea's toolbar box). */
export function fieldLabelId(controlId) {
  return `${controlId}-label`;
}

/**
 * The helper/error message ID and the control's `aria-describedby`: the caller's
 * own description first, then the message when there is one.
 */
export function fieldDescription(controlId, { helper, error, describedBy }) {
  const messageId = `${controlId}-${error ? 'error' : 'helper'}`;
  return {
    messageId,
    describedBy: [describedBy, (error || helper) ? messageId : null].filter(Boolean).join(' ') || undefined,
  };
}

/* Label: 14px/500 body ink, a space-1 gap to the control. `inheritInk` leaves the
   color to the surrounding text (Select's historical label). */
const LABEL_STYLE = {
  display: 'block',
  fontSize: 'var(--font-size-sm, 0.875rem)',
  fontWeight: 500,
  marginBottom: 'var(--space-1, 0.25rem)',
};
const LABEL_INK = { color: 'var(--text-body, #212529)' };

export function FieldLabel({ htmlFor, id, required = false, inheritInk = false, children }) {
  return (
    <label htmlFor={htmlFor} id={id} style={inheritInk ? LABEL_STYLE : { ...LABEL_STYLE, ...LABEL_INK }}>
      {children}
      {required && <span aria-hidden="true" data-required-mark="" style={{ color: 'var(--text-overdue, #991b1b)' }}> *</span>}
    </label>
  );
}

/* Message: 13px helper or error line a space-1 below the control. Error text is an
   alert in overdue ink; helper text is secondary ink unless the field passes `color`. */
export function FieldMessage({ id, helper, error, color }) {
  if (!(helper || error)) return null;
  return (
    <div
      id={id}
      role={error ? 'alert' : undefined}
      style={{
        fontSize: 'var(--font-size-dense, 0.8125rem)',
        marginTop: 'var(--space-1, 0.25rem)',
        color: color || (error ? 'var(--text-overdue, #991b1b)' : 'var(--text-secondary, #5a6268)'),
      }}
    >
      {error || helper}
    </div>
  );
}
