import React from 'react';
import { Input } from './Input.jsx';
import { IconButton } from '../actions/IconButton.jsx';
import { Popover } from '../overlays/Popover.jsx';

/* Normalise a suggestion to { id, label, description, icon, onSelect }. */
function toSuggestion(s, i) {
  if (s == null) return null;
  if (typeof s === 'string' || typeof s === 'number') return { id: String(s), label: String(s) };
  return { ...s, id: s.id != null ? String(s.id) : String(i) };
}

/* The in-field clear button: a 24px round target on the tertiary surface. */
function ClearButton({ label, onClear, disabled }) {
  const [hover, setHover] = React.useState(false);
  const [ring, setRing] = React.useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClear}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={(e) => setRing(!e.currentTarget.matches || e.currentTarget.matches(':focus-visible'))}
      onBlur={() => setRing(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
        width: 24, height: 24, margin: 0, padding: 0, border: 0,
        borderRadius: 'var(--radius-circle, 50%)',
        background: hover ? 'var(--border-color-strong, #ced4da)' : 'var(--surface-tertiary, #e9ecef)',
        color: 'var(--text-secondary, #5a6268)',
        fontSize: 'var(--icon-xs, 12px)', lineHeight: 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        outline: ring ? 'var(--focus-outline, 2px solid #0079a8)' : 'none',
        outlineOffset: 1,
      }}
    >
      <i className="bi bi-x-lg" aria-hidden="true" />
    </button>
  );
}

const SR_ONLY = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };

/* Focus a freshly mounted field and put the caret back where it was. */
function focusField(el, at) {
  if (!el) return;
  el.focus();
  if (at && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(at.start, at.end, at.direction || 'none'); } catch (_) { /* not a text field */ }
  }
}

/**
 * ArkCase SearchField — a search box with an optional suggestion list, built on Input as
 * an ARIA 1.2 combobox: the input is `role="combobox"` with `aria-autocomplete="list"`,
 * `aria-expanded` and `aria-controls`, and the suggestions are a `listbox` of `option`s
 * whose active one is announced through `aria-activedescendant` while focus stays in the
 * field. A leading search glyph and, once there is text, a clear button sit inside the
 * field border.
 *
 * Typing opens the list when there are suggestions; ArrowDown/ArrowUp move the active
 * option (wrapping), Enter picks it — or, with none active, submits the text — and Escape
 * closes the list. Picking a suggestion calls its own `onSelect`, else `onSuggestionSelect`,
 * else sets the text to its label and submits it. The host owns the text and the list.
 *
 * `suggest={false}` is a plain search box (`role="searchbox"`): no listbox and no combobox
 * attributes, for a toolbar search that filters in place. `collapsed` folds the field to an
 * icon button that opens it in a popover, so a short toolbar row stays one row; while it holds
 * text the icon fills primary and its tooltip quotes the query. The host decides when to fold
 * (promoted from the ArkCase Artifacts page toolbar, which folds when the row is short).
 *
 * Folding never strands the reader: if the field has focus when `collapsed` flips, the field
 * that mounts takes focus with the same caret — folding opens the popover with the field
 * focused, unfolding focuses the inline field and closes the popover. While folded and closed,
 * `inputRef` holds a hidden stand-in input whose `focus()` opens the popover and focuses the
 * field (so a "/" shortcut still works), and `aria-keyshortcuts` moves to the icon button.
 */
export function SearchField(props) {
  const { collapsed = false, popoverWidth = 284, value = '', icon = 'bi-search', label, disabled = false } = props;
  const [open, setOpen] = React.useState(false);
  const live = React.useRef(props);
  live.current = props;
  const fieldEl = React.useRef(null);
  /* The caret while the field has focus, else null; read when a fold remounts the field. */
  const caret = React.useRef(null);
  /* The caret the folded field restores once its popover has opened. */
  const handoff = React.useRef(null);
  const forward = React.useCallback((el) => {
    const r = live.current.inputRef;
    if (typeof r === 'function') r(el);
    else if (r && typeof r === 'object') r.current = el;
  }, []);
  const setField = React.useCallback((el) => { fieldEl.current = el; forward(el); }, [forward]);
  const snap = (el) => {
    if (el && el === fieldEl.current) caret.current = { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0, direction: el.selectionDirection || 'none' };
  };
  const tracked = {
    inputRef: setField,
    onFocus: (e) => { snap(e.target); if (live.current.onFocus) live.current.onFocus(e); },
    onBlur: (e) => { caret.current = null; if (live.current.onBlur) live.current.onBlur(e); },
    onSelect: (e) => { snap(e.target); if (live.current.onSelect) live.current.onSelect(e); },
  };
  /* A flip of `collapsed` remounts the field. When it held focus (focus fell to the body with
     it), the new field takes it; unfolding always closes the folded popover, so folding again
     never reopens it on its own. */
  const was = React.useRef(collapsed);
  React.useLayoutEffect(() => {
    if (was.current === collapsed) return;
    was.current = collapsed;
    const had = caret.current;
    caret.current = null;
    const a = typeof document !== 'undefined' ? document.activeElement : null;
    const lost = !!had && (!a || a === document.body);
    if (!collapsed) {
      setOpen(false);
      if (lost) focusField(fieldEl.current, had);
    } else if (lost && !disabled) {
      handoff.current = had;
      setOpen(true);
    }
  }, [collapsed]);
  /* After the popover has opened (and been shown), hand the caret to its field. */
  React.useEffect(() => {
    if (!open || !handoff.current) return;
    const at = handoff.current;
    handoff.current = null;
    focusField(fieldEl.current, at);
  }, [open]);
  if (!collapsed) return <SearchFieldBox {...props} {...tracked} />;
  const { collapsed: _c, popoverWidth: _w, style, ...field } = props;
  const name = props['aria-label'] || (typeof label === 'string' ? label : 'Search');
  const text = String(value == null ? '' : value);
  const active = text.trim().length > 0;
  const shown = open && !disabled;
  return (
    <span data-search-field="collapsed" style={{ display: 'inline-flex', ...style }}>
      {!shown && (
        <input ref={forward} type="text" tabIndex={-1} aria-hidden="true" aria-label={name} readOnly value={text} disabled={disabled}
          data-search-field-standin="" style={SR_ONLY}
          onFocus={() => { handoff.current = { start: text.length, end: text.length }; setOpen(true); }} />
      )}
      <Popover open={shown} onOpenChange={(o) => { if (!o) caret.current = null; setOpen(o); }} label={name} placement="bottom-end" width={popoverWidth}
        contentStyle={{ padding: 12 }}
        trigger={<IconButton icon={icon} size="sm" variant={active ? 'primary' : 'ghost'} ariaLabel={name} disabled={disabled}
          keyshortcuts={props['aria-keyshortcuts']}
          title={active ? `${name}: \u201c${text}\u201d` : name} />}>
        <SearchFieldBox {...field} {...tracked} autoFocus style={{ width: '100%' }} />
      </Popover>
    </span>
  );
}

function SearchFieldBox({
  value = '', onChange, onSubmit, onClear, suggestions = [], onSuggestionSelect,
  label, placeholder, size = 'sm', icon = 'bi-search', clearLabel = 'Clear search term',
  suggestionsLabel, disabled = false, autoFocus = false, id, inputRef, onKeyDown, onFocus, onBlur,
  maxSuggestions = 8, variant = 'default', suggest = true, collapsed: _collapsed, popoverWidth: _popoverWidth, style, ...rest
}) {
  const auto = React.useId().replace(/[^A-Za-z0-9_-]/g, '');
  const fieldId = id || 'sf-' + auto;
  const listId = fieldId + '-listbox';
  const text = String(value == null ? '' : value);
  const list = suggest ? (suggestions || []).map(toSuggestion).filter(Boolean).slice(0, maxSuggestions) : [];
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const ownRef = React.useRef(null);
  const rootRef = React.useRef(null);
  const setRefs = (el) => {
    ownRef.current = el;
    if (typeof inputRef === 'function') inputRef(el);
    else if (inputRef && typeof inputRef === 'object') inputRef.current = el;
  };
  const expanded = open && list.length > 0 && !disabled;
  const listKey = list.map((s) => s.id).join('\u0001');
  // A new list (the host filtered on the new text) starts with nothing active.
  React.useEffect(() => { setActive(-1); }, [listKey]);

  const close = () => { setOpen(false); setActive(-1); };
  const pick = (s) => {
    close();
    if (typeof s.onSelect === 'function') s.onSelect(s);
    else if (onSuggestionSelect) onSuggestionSelect(s);
    else {
      if (onChange) onChange(s.label);
      if (onSubmit) onSubmit(s.label);
    }
  };
  const clear = () => {
    close();
    if (onClear) onClear();
    else if (onChange) onChange('');
    if (ownRef.current) ownRef.current.focus();
  };
  const keyDown = (e) => {
    if (onKeyDown) onKeyDown(e);
    if (e.defaultPrevented || (e.nativeEvent && e.nativeEvent.isComposing)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!list.length) return;
      e.preventDefault();
      if (!expanded) { setOpen(true); setActive(e.key === 'ArrowDown' ? 0 : list.length - 1); return; }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((at) => (at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (expanded && active >= 0 && list[active]) { pick(list[active]); return; }
      close();
      if (onSubmit) onSubmit(text.trim());
    } else if (e.key === 'Escape') {
      if (expanded) { e.preventDefault(); e.stopPropagation(); close(); }
    }
  };

  const activeId = expanded && active >= 0 ? `${listId}-${active}` : undefined;
  const hasText = text !== '';
  const trailing = (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {hasText && <ClearButton label={clearLabel} onClear={clear} disabled={disabled} />}
    </span>
  );

  return (
    <div
      ref={rootRef}
      data-search-field=""
      style={{ position: 'relative', minWidth: 0, ...style }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) close(); }}
    >
      <Input
        {...rest}
        id={fieldId}
        label={label}
        type="text"
        size={size}
        icon={icon}
        variant={variant}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        inputRef={setRefs}
        trailing={trailing}
        {...(suggest ? {
          role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': expanded, 'aria-controls': listId, 'aria-activedescendant': activeId,
        } : { role: 'searchbox' })}
        onKeyDown={keyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        onChange={(e) => { setOpen(true); if (onChange) onChange(e.target.value); }}
      />
      {suggest && <ul
        id={listId}
        role="listbox"
        aria-label={suggestionsLabel || (typeof label === 'string' ? label + ' suggestions' : rest['aria-label'] ? rest['aria-label'] + ' suggestions' : 'Suggestions')}
        hidden={!expanded}
        data-search-field-list=""
        style={{
          position: 'absolute', left: 0, right: 0, top: 'calc(100% + 2px)', zIndex: 1050,
          margin: 0, padding: '4px 0', listStyle: 'none',
          background: 'var(--surface-card, #fff)',
          border: '1px solid var(--border-color, #dee2e6)',
          borderRadius: 'var(--radius-md, 5px)',
          boxShadow: 'var(--shadow-md, 0 2px 4px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.10))',
          maxHeight: 320, overflowY: 'auto',
        }}
      >
        {expanded && list.map((s, i) => {
          const on = i === active;
          return (
            <li
              key={s.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={on}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(s)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px',
                fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
                fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.5,
                background: on ? 'var(--tint-primary-hover, rgba(0,121,168,.05))' : 'transparent',
                color: on ? 'var(--text-link-hover, #005a7d)' : 'var(--text-body, #212529)',
                cursor: 'pointer',
              }}
            >
              <i className={`bi ${s.icon || icon || 'bi-search'}`} aria-hidden="true" style={{ flex: 'none', fontSize: 'var(--icon-xs, 12px)', color: 'var(--text-secondary, #5a6268)' }} />
              <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span style={{ overflowWrap: 'anywhere' }}>{s.label}</span>
                {s.description != null && s.description !== '' && (
                  <span style={{ fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5a6268)' }}>{s.description}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>}
    </div>
  );
}
