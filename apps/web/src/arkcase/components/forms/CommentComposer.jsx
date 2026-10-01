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
 *
 * In `prompt`, `tools` puts a row of host controls (mention, attach a location) under the
 * field inside the box, with the send button at its end, and `maxRows` lets the field grow
 * with the draft up to that many lines before it scrolls. `inputProps` spreads extra
 * attributes onto the field (a host's combobox wiring), and `onKeyDown` sees each key first:
 * when it calls `preventDefault()` the composer leaves that key alone.
 */
export function CommentComposer({
  value = '', onChange, onSubmit, placeholder, label, submitLabel, hint, author,
  rows = 2, variant = 'block', submitOnEnter, onEscape, disabled = false, inputRef, autoFocus = false,
  onCancel, cancelLabel = 'Cancel', submitIcon, maxLength, countFrom, overLimitMessage, meta,
  busy = false, onStop, busyLabel = 'Working', stopLabel = 'Stop',
  tools, maxRows, inputProps, onKeyDown: onKeyDownProp,
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
  /* The prompt field grows with its draft up to `maxRows` lines, then scrolls. */
  const fieldRef = React.useRef(null);
  const setFieldRef = (node) => {
    fieldRef.current = node;
    if (typeof inputRef === 'function') inputRef(node);
    else if (inputRef) inputRef.current = node;
  };
  const grows = prompt && typeof maxRows === 'number' && maxRows > rows;
  React.useLayoutEffect(() => {
    const el = fieldRef.current;
    if (!grows || !el || typeof window === 'undefined') return;
    const line = parseFloat(window.getComputedStyle(el).lineHeight) || 19.5;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, Math.ceil(line * maxRows));
    el.style.height = Math.max(next, Math.ceil(line * rows)) + 'px';
    el.style.overflowY = el.scrollHeight > next + 1 ? 'auto' : 'hidden';
  }, [grows, text, maxRows, rows]);

  const submit = () => {
    if (blocked || busy) return;
    onSubmit && onSubmit(text.trim());
  };
  const onKeyDown = (event) => {
    if (onKeyDownProp) onKeyDownProp(event);
    if (event.defaultPrevented) return;
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
    ...inputProps,
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
              ...(tools != null ? { flexDirection: 'column', alignItems: 'stretch', padding: '8px 6px 6px 10px' } : null),
              ...(tools != null ? null : { padding: 8 }),
              border: `1px solid ${overLimit ? 'var(--bs-danger, #d83506)' : 'var(--border-color-strong, #ced4da)'}`,
              borderRadius: 'var(--radius-md, 5px)',
              background: disabled ? 'var(--bs-gray-200, #e9ecef)' : 'var(--surface-card, #fff)',
              transition: 'border-color .15s ease, box-shadow .15s ease',
            }}>
              <textarea
                {...inputProps}
                ref={setFieldRef}
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
                  flex: tools != null ? 'none' : 1, minWidth: 0, margin: 0, padding: tools != null ? '0 4px 0 0' : 0,
                  border: 0, outline: 'none', resize: 'none', background: 'transparent',
                  fontFamily: 'inherit', fontSize: 'var(--font-size-dense, 0.8125rem)', lineHeight: 1.5,
                  color: 'var(--text-body, #212529)',
                }}
              />
              {tools != null ? (
                <div data-composer-tools="" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1, 0.25rem)' }}>
                  {tools}
                  <span style={{ flex: 1 }} />
                  <SendButton label={sendLabel} icon={submitIcon || 'bi-arrow-up'} disabled={blocked} onClick={submit} keys={keys} />
                </div>
              ) : <SendButton label={sendLabel} icon={submitIcon || 'bi-arrow-up'} disabled={blocked} onClick={submit} keys={keys} />}
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
