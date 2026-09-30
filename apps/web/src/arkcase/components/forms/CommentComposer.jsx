import { akStyleDocument } from '@/arkcase-style';
import React from 'react';
import { Avatar } from '../data-display/Avatar.jsx';
import { Button } from '../actions/Button.jsx';
import { Input } from './Input.jsx';
import { Textarea } from './Textarea.jsx';

/* The prompt box shows its focus ring while focus is anywhere inside it; the ring lives
   in a sheet so :focus-within applies. Injected once per document. */
function ensureComposerStyles() {
  if (typeof document === 'undefined' || akStyleDocument.getElementById('ak-composer-css')) return;
  const s = akStyleDocument.createElement('style');
  s.id = 'ak-composer-css';
  s.textContent =
    '[data-ak-composer-box]:focus-within{border-color:var(--bs-primary, #0079a8);box-shadow:var(--focus-ring, 0 0 0 0.25rem rgba(0,121,168,0.25))}' +
    '[data-ak-composer-box] textarea::placeholder{color:var(--text-secondary, #5a6268);opacity:1}';
  akStyleDocument.head.appendChild(s);
}

const fmt = (n) => Number(n).toLocaleString();

/**
 * ArkCase CommentComposer — the comment field every discussion surface rebuilt: an optional
 * author avatar, a labelled field and a submit button that stays natively disabled until
 * there is text. `inline` is one row (field + button, Enter posts — a reply box); `block` is
 * a textarea with a hint and the button under it (Cmd/Ctrl+Enter posts, Enter is a newline).
 * Escape hands focus back through `onEscape`. The host owns the value and clears it after
 * a post; the composer never edits it.
 *
 * `onCancel` adds a Cancel button before submit (editing an existing note). `submitIcon`
 * leads the submit label. `variant="prompt"` is the assistant prompt: one bordered box
 * holding a borderless textarea and a 30px icon-only submit, with the hint row under it.
 * `maxLength` adds a remaining/over counter once the draft reaches `countFrom` and, over the
 * limit, swaps the hint for an error and blocks submit (nothing is truncated); `meta` sits at
 * the right of the hint row ("Draft saved"). `busy` replaces the field with a status line
 * and a Stop button (`onStop`) while an answer is being produced.
 */
export function CommentComposer({
  value = '', onChange, onSubmit, placeholder, label, submitLabel, hint, author,
  rows = 2, variant = 'block', submitOnEnter, onEscape, disabled = false, inputRef, autoFocus = false,
  onCancel, cancelLabel = 'Cancel', submitIcon, maxLength, countFrom, overLimitMessage, meta,
  busy = false, onStop, busyLabel = 'Working', stopLabel = 'Stop',
  style, ...rest
}) {
  const inline = variant === 'inline';
  const prompt = variant === 'prompt';
  const enterPosts = submitOnEnter == null ? (inline || prompt) : submitOnEnter;
  const hintId = React.useId();
  const text = String(value == null ? '' : value);
  const empty = text.trim() === '';
  const limit = typeof maxLength === 'number' && maxLength > 0 ? maxLength : null;
  const over = limit != null ? text.length - limit : 0;
  const overLimit = over > 0;
  const countAt = countFrom != null ? countFrom : limit != null ? Math.floor(limit * 0.75) : null;
  const showCount = limit != null && text.length >= countAt;
  const blocked = disabled || empty || overLimit;
  const sendLabel = submitLabel || (prompt ? 'Send' : 'Post');
  React.useEffect(() => { if (prompt) ensureComposerStyles(); }, [prompt]);

  const submit = () => {
    if (blocked || busy) return;
    onSubmit && onSubmit(text.trim());
  };
  const onKeyDown = (event) => {
    if (event.nativeEvent && event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || (enterPosts && !event.shiftKey))) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape' && (onEscape || onCancel)) {
      event.preventDefault();
      event.stopPropagation();
      (onEscape || onCancel)();
    }
  };
  const change = (event) => onChange && onChange(event.target.value);

  const overText = overLimit
    ? (typeof overLimitMessage === 'function' ? overLimitMessage(over, limit)
      : overLimitMessage != null ? overLimitMessage
      : `${fmt(over)} character${over === 1 ? '' : 's'} over the ${fmt(limit)} limit — shorten it; nothing is cleared.`)
    : null;
  const hintContent = overLimit ? overText : hint;
  const hasHint = hintContent != null && hintContent !== false && hintContent !== '';
  const hasMeta = meta != null && meta !== false && meta !== '';

  const fieldProps = {
    value: text, onChange: change, onKeyDown, placeholder, disabled, inputRef, autoFocus,
    'aria-label': label, 'aria-describedby': hasHint ? hintId : undefined,
    'aria-invalid': overLimit ? true : undefined,
  };
  const keys = enterPosts ? 'Enter' : 'Control+Enter Meta+Enter';
  const button = (
    <Button variant="primary" size="sm" icon={submitIcon} disabled={blocked} onClick={submit}
      keyshortcuts={keys} style={{ flex: 'none' }}>
      {sendLabel}
    </Button>
  );
  const cancel = onCancel ? (
    <Button variant="secondary" outline size="sm" onClick={onCancel} disabled={disabled} style={{ flex: 'none' }}>{cancelLabel}</Button>
  ) : null;
  const hintNode = hasHint ? (
    <span id={hintId} data-composer-hint={overLimit ? 'over' : ''} style={{
      minWidth: 0,
      fontSize: prompt ? 'var(--font-size-label, 0.6875rem)' : 'var(--font-size-xs, 0.75rem)',
      lineHeight: 'var(--line-height-normal, 1.5)',
      color: overLimit ? 'var(--text-overdue, #991b1b)' : 'var(--text-secondary, #5a6268)',
    }}>{hintContent}</span>
  ) : null;
  const countNode = showCount ? (
    <span data-composer-count="" aria-live="polite" style={{
      fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)',
      fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)',
      fontSize: 'var(--font-size-label, 0.6875rem)',
      color: overLimit ? 'var(--text-overdue, #991b1b)' : 'var(--text-due-soon, #92400e)',
      whiteSpace: 'nowrap',
    }}>{overLimit ? `${fmt(over)} over` : `${fmt(limit - text.length)} left`}</span>
  ) : null;
  const metaNode = hasMeta ? (
    <span data-composer-meta="" style={{ fontSize: 'var(--font-size-label, 0.6875rem)', color: 'var(--text-secondary, #5a6268)', whiteSpace: 'nowrap' }}>{meta}</span>
  ) : null;
  const trailingInfo = countNode || metaNode ? (
    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2, 0.5rem)', flexShrink: 0 }}>{countNode}{metaNode}</span>
  ) : null;

  if (prompt) {
    return (
      <div data-comment-composer="prompt" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)', ...style }} {...rest}>
        {busy ? (
          <div data-composer-busy="" style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-2, 0.5rem)',
            padding: '8px 10px',
            border: '1px solid var(--border-color, #dee2e6)', borderRadius: 'var(--radius-md, 5px)',
            background: 'var(--surface-secondary, #f8f9fa)',
          }}>
            <span role="status" style={{ flex: 1, minWidth: 0, fontSize: 'var(--font-size-dense, 0.8125rem)', color: 'var(--text-secondary, #5a6268)' }}>{busyLabel}</span>
            {onStop && <Button variant="dark" size="sm" icon="bi-stop-fill" onClick={onStop}>{stopLabel}</Button>}
          </div>
        ) : (
          <>
            <div data-ak-composer-box="" style={{
              display: 'flex', alignItems: 'flex-end', gap: 'var(--space-2, 0.5rem)',
              padding: 8,
              border: `1px solid ${overLimit ? 'var(--bs-danger, #d83506)' : 'var(--border-color-strong, #ced4da)'}`,
              borderRadius: 'var(--radius-md, 5px)',
              background: disabled ? 'var(--bs-gray-200, #e9ecef)' : 'var(--surface-card, #fff)',
              transition: 'border-color .15s ease, box-shadow .15s ease',
            }}>
              <textarea
                ref={inputRef}
                rows={rows}
                value={text}
                onChange={change}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                disabled={disabled}
                autoFocus={autoFocus || undefined}
                aria-label={label}
                aria-describedby={fieldProps['aria-describedby']}
                aria-invalid={fieldProps['aria-invalid']}
                style={{
                  flex: 1, minWidth: 0, margin: 0, padding: 0,
                  border: 0, outline: 'none', resize: 'none', background: 'transparent',
                  fontFamily: 'inherit', fontSize: 'var(--font-size-dense, 0.8125rem)', lineHeight: 1.5,
                  color: 'var(--text-body, #212529)',
                }}
              />
              <SendButton label={sendLabel} icon={submitIcon || 'bi-arrow-up'} disabled={blocked} onClick={submit} keys={keys} />
            </div>
            {(hintNode || trailingInfo) && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2, 0.5rem)' }}>
                {hintNode || <span />}
                {trailingInfo}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2, 0.5rem)', fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)', ...style }} {...rest}>
      {author && (
        <span aria-hidden="true" style={{ display: 'inline-flex', flex: 'none', marginTop: inline ? 4 : 0 }}>
          <Avatar name={author} size={inline ? 24 : 32} />
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2, 0.5rem)' }}>
        {inline ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2, 0.5rem)' }}>
              <Input {...fieldProps} size="sm" autoComplete="off" style={{ flex: 1, minWidth: 0 }} />
              {cancel}
              {button}
            </div>
            {trailingInfo ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2, 0.5rem)' }}>
                {hintNode || <span />}
                {trailingInfo}
              </div>
            ) : hintNode}
          </>
        ) : (
          <>
            <Textarea {...fieldProps} rows={rows} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: hasHint ? 'space-between' : 'flex-end', gap: 'var(--space-2, 0.5rem)', flexWrap: cancel || trailingInfo ? 'wrap' : undefined }}>
              {hintNode}
              {(trailingInfo || cancel) ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2, 0.5rem)', marginLeft: 'auto' }}>
                  {trailingInfo}
                  {cancel}
                  {button}
                </span>
              ) : button}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* The prompt's 30px icon-only submit: primary fill when ready, the strong hairline grey
   (still natively disabled) while blank or over the limit. */
function SendButton({ label, icon, disabled, onClick, keys }) {
  const [hover, setHover] = React.useState(false);
  const [ring, setRing] = React.useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-keyshortcuts={keys}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={(e) => setRing(!e.currentTarget.matches || e.currentTarget.matches(':focus-visible'))}
      onBlur={() => setRing(false)}
      data-icon-tone="current"
      style={{
        width: 30, height: 30, flex: 'none', margin: 0, padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 0, borderRadius: 'var(--radius-md, 5px)',
        background: disabled ? 'var(--border-color-strong, #ced4da)' : hover ? 'var(--bs-primary-hover, #00668f)' : 'var(--bs-primary, #0079a8)',
        color: 'var(--text-on-primary, #fff)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        outline: ring ? 'var(--focus-outline, 2px solid #0079a8)' : 'none',
        outlineOffset: 'var(--focus-outline-offset, 2px)',
        transition: 'background-color .15s ease',
      }}
    >
      <i className={`bi ${icon}`} aria-hidden="true" style={{ fontSize: 'var(--icon-sm, 14px)' }} />
    </button>
  );
}
