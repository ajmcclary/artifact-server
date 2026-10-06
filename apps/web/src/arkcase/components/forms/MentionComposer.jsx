import React from 'react';
import { CommentComposer } from './CommentComposer.jsx';
import { Avatar } from '../data-display/Avatar.jsx';
import { Eyebrow } from '../data-display/Eyebrow.jsx';
import { Button } from '../actions/Button.jsx';
import { IconButton } from '../actions/IconButton.jsx';
import { ShortcutKey } from '../data-display/ShortcutKey.jsx';

const SECONDARY = { fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5a6268)' };

/* The line above the box that says what is being written: an icon, the sentence (truncating),
   and an optional × that cancels it — "Replying to Dana · #1", "Click the artifact to place pin 3". */
function ComposerContext({ icon, text, cancel }) {
  return (
    <div data-composer-context="" style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 24, ...SECONDARY }}>
      {icon && <i className={'bi ' + icon} aria-hidden="true" style={{ fontSize: 14 }} />}
      <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
      {cancel && <IconButton icon="bi-x-lg" size="xs" ariaLabel={cancel.label} onClick={cancel.onClick} />}
    </div>
  );
}

/**
 * ArkCase MentionComposer — the comment input docked at the foot of a discussion panel, like a
 * chat: the `prompt` CommentComposer with @mentions. Typing "@" (or pressing the @ tool) opens
 * the people list above the box, matched on the start of any word of a name; ↑↓ move, Enter or
 * Tab inserts, Escape closes. The field names the list (`aria-controls`, `aria-autocomplete`,
 * `aria-activedescendant`) and the line under the box says who will be notified. A `context`
 * line above the box says what is being written — a node, or `{ icon, text, cancel }`.
 */
export function MentionComposer({ value, onChange, onSubmit, label, placeholder, submitLabel = 'Post comment', people = [],
  context, tools, onEscape, rows = 2, maxRows = 6, autoFocus = false, onAnnounce, style }) {
  const fieldRef = React.useRef(null);
  const listId = React.useId();
  const [caret, setCaret] = React.useState(null);
  const [active, setActive] = React.useState(0);
  const [dismissed, setDismissed] = React.useState(null);
  const pendingCaret = React.useRef(null);
  React.useLayoutEffect(() => {
    const el = fieldRef.current;
    if (el && pendingCaret.current != null) {
      el.focus();
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);
  const text = value || '';
  const at = caret == null || caret > text.length ? text.length : caret;
  const before = text.slice(0, at);
  const hit = /(^|\s)@([^\s@]*)$/.exec(before);
  const q = hit ? hit[2].toLowerCase() : null;
  const matches = q == null || dismissed === text ? [] : people.filter((p) => {
    const name = p.name.toLowerCase();
    return name.startsWith(q) || name.split(/[\s.]+/).some((word) => word && word.startsWith(q));
  });
  const open = matches.length > 0;
  const index = Math.min(active, Math.max(matches.length - 1, 0));
  const optId = (i) => listId + '-' + i;
  const write = (next, caretAt) => { pendingCaret.current = caretAt; setActive(0); setDismissed(null); onChange && onChange(next); };
  const insert = (person) => {
    const start = at - hit[2].length - 1;
    const next = text.slice(0, start) + '@' + person.name + ' ' + text.slice(at);
    write(next, start + person.name.length + 2);
    onAnnounce && onAnnounce(person.name + ' mentioned.');
  };
  const startMention = () => {
    const lead = before && !/\s$/.test(before) ? ' @' : '@';
    write(before + lead + text.slice(at), at + lead.length);
  };
  const onKeyDown = (event) => {
    if (!open) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
    } else if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) || event.key === 'Tab') {
      event.preventDefault();
      insert(matches[index]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(text);
    }
  };
  React.useEffect(() => { if (open && onAnnounce) onAnnounce(matches.length + (matches.length === 1 ? ' person matches.' : ' people match.')); }, [open, matches.length]);
  const tagged = people.filter((p) => text.includes('@' + p.name)).map((p) => p.name);
  const notify = tagged.length ? tagged.join(', ').replace(/, ([^,]*)$/, ' and $1') + ' will be notified.' : null;
  const contextNode = context && typeof context === 'object' && !React.isValidElement(context) && 'text' in context
    ? <ComposerContext {...context} /> : context;
  return (
    <div data-mention-composer="" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 6, ...style }}>
      {open && (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: '100%', marginBottom: 4, zIndex: 4,
          background: 'var(--surface-card, #fff)', border: '1px solid var(--border-color, #dee2e6)', borderRadius: 'var(--radius-md, 5px)',
          boxShadow: 'var(--shadow-up, 0 -6px 16px rgba(0, 0, 0, 0.14))', padding: '4px 0' }}>
          <Eyebrow as="div" style={{ padding: '6px 12px 4px' }}>Mention</Eyebrow>
          <div role="listbox" id={listId} aria-label="People to mention">
            {matches.map((person, i) => (
              <div key={person.name} role="option" id={optId(i)} aria-selected={i === index}
                onMouseDown={(e) => { e.preventDefault(); insert(person); }} onMouseEnter={() => setActive(i)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', cursor: 'pointer',
                  background: i === index ? 'var(--tint-primary-selected, rgba(0,121,168,.10))' : 'transparent' }}>
                <Avatar name={person.name} icon={person.icon} size={24} />
                <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: 'var(--font-size-dense, 13px)', fontWeight: 600, color: 'var(--text-strong, #111827)' }}>{person.name}</span>
                {person.detail && <span style={{ ...SECONDARY, flex: 'none' }}>{person.detail}</span>}
              </div>
            ))}
          </div>
          <div aria-hidden="true" style={{ ...SECONDARY, fontSize: 'var(--font-size-label, 11px)', padding: '6px 12px 4px', marginTop: 4, borderTop: '1px solid var(--list-divider, #e9ecef)' }}>
            ↑↓ to move · ↵ to mention · Esc to close
          </div>
        </div>
      )}
      {contextNode}
      <CommentComposer variant="prompt" label={label} placeholder={placeholder} submitLabel={submitLabel} submitIcon="bi-send"
        submitOnEnter={false} rows={rows} maxRows={maxRows} autoFocus={autoFocus} value={text} inputRef={fieldRef}
        onChange={(next) => { setActive(0); setDismissed(null); onChange && onChange(next); }}
        onSubmit={onSubmit} onEscape={onEscape} onKeyDown={onKeyDown}
        inputProps={{ 'aria-autocomplete': 'list', 'aria-controls': open ? listId : undefined,
          'aria-activedescendant': open ? optId(index) : undefined,
          onSelect: (e) => setCaret(e.currentTarget.selectionStart), onClick: (e) => setCaret(e.currentTarget.selectionStart) }}
        hint={notify} meta={<><ShortcutKey label="Command Enter">⌘↵</ShortcutKey> to post</>}
        tools={<>{tools}<Button variant="ghost" size="xs" aria-label="Mention someone" title="Mention someone" hasPopup="listbox"
          expanded={open} onClick={startMention} style={{ fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)', fontWeight: 600 }}>@</Button></>} />
    </div>
  );
}
