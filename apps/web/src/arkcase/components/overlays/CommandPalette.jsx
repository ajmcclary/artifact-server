import React from 'react';
import { Input } from '../forms/Input.jsx';
import { IconButton } from '../actions/IconButton.jsx';
import { Button } from '../actions/Button.jsx';
import { ShortcutKey } from '../data-display/ShortcutKey.jsx';
import { Eyebrow } from '../data-display/Eyebrow.jsx';
import { trapTab } from '../utilities/a11y-keys.jsx';

/* The palette's scrim is the navy at 38% the Artifacts search drew — lighter than a
   Modal's 45% because the page behind stays the thing being searched. */
const SCRIM = 'rgba(7,54,82,.38)';
/* The lighter tint an ask-one-question bar uses, the Modal's `tint` backdrop. */
const SCRIMS = { default: SCRIM, tint: 'rgba(7,54,82,.18)' };

/**
 * ArkCase CommandPalette — the centred global search dialog a workspace opens from
 * anywhere (Cmd/Ctrl-K, "/" outside a field, a rail button). A navy-tinted scrim, a
 * 640px panel 11vh from the top, the DS search Input with a close button, a status row
 * (the count on the left, keyboard hints on the right) and the results as a listbox the
 * input drives (and which is a Tab stop itself): ArrowDown and ArrowUp move the active
 * option, Enter selects it. Focus moves into the field on open, Tab stays inside, Escape
 * and the scrim close, and focus returns to the opener on close. Promoted from the
 * Artifacts App's hand-built palette; the host owns the query, the matching and what a
 * selection does.
 *
 * As a command bar (the Illume "ask one question" form) `onSubmit` takes the free text on
 * Enter when no result row is active, `leading` replaces the search glyph with a mark, and
 * `children` replace the results area with the host's answer or hint.
 */
export function CommandPalette({
  open = false, onClose, query = '', onQueryChange, placeholder, label = 'Search', closeLabel = 'Close search',
  countLabel, shortcuts, results, idle, emptyTitle = 'Nothing matches', emptyBody, onClear,
  clearLabel = 'Clear the search', onAnnounce, zIndex = 1400, onSubmit, leading, children, scrim = 'default',
  style, ...rest
}) {
  const panelRef = React.useRef(null);
  const inputRef = React.useRef(null);
  const listRef = React.useRef(null);
  const returnTo = React.useRef(null);
  const baseId = React.useId();
  const listId = `${baseId}-results`;
  const items = Array.isArray(results) ? results : [];
  const hasQuery = String(query || '').trim().length > 0;
  const [active, setActive] = React.useState(items.length ? 0 : -1);
  const [listFocus, setListFocus] = React.useState(false);

  /* A new result set starts at its first row. */
  const resultKey = items.map((r) => r && r.id).join('\u0001');
  React.useEffect(() => { setActive(items.length ? 0 : -1); }, [resultKey, items.length]);

  /* The open session owns focus: remember the opener, put the caret in the field, and
     hand focus back when the palette closes or unmounts — if the opener still exists.
     The field is focused here rather than through `autoFocus`, which would move focus
     before the opener could be read. */
  React.useEffect(() => {
    if (!open) return undefined;
    const at = typeof document !== 'undefined' ? document.activeElement : null;
    returnTo.current = at && at !== document.body ? at : null;
    const input = inputRef.current;
    if (input && document.activeElement !== input) input.focus({ preventScroll: true });
    return () => {
      const back = returnTo.current;
      returnTo.current = null;
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, [open]);

  /* A host with its own live region (AppShell `announce`) hears the count through
     `onAnnounce`; otherwise the count text is itself a polite status. */
  React.useEffect(() => {
    if (open && onAnnounce && countLabel) onAnnounce(String(countLabel));
  }, [open, countLabel]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Keep the active option in view as the arrows move it. */
  React.useEffect(() => {
    if (active < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-index="${active}"]`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const select = (i) => {
    const r = items[i];
    if (r && typeof r.onSelect === 'function') r.onSelect(r);
  };

  const onPanelKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (onClose) onClose();
      return;
    }
    if (e.key === 'Tab') trapTab(e, panelRef.current);
  };

  /* The field and the listbox share one key map; only the listbox also takes Home, End
     and Space, which belong to the caret while the field has focus. */
  const onListKeys = (e, inList) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const n = items.length;
    if (!n) return;
    let next = null;
    if (e.key === 'ArrowDown') next = (at) => (at + 1) % n;
    else if (e.key === 'ArrowUp') next = (at) => (at <= 0 ? n - 1 : at - 1);
    else if (inList && e.key === 'Home') next = () => 0;
    else if (inList && e.key === 'End') next = () => n - 1;
    if (next) {
      e.preventDefault();
      setActive(next);
      return;
    }
    if ((e.key === 'Enter' || (inList && e.key === ' ')) && active >= 0 && items[active]) {
      e.preventDefault();
      select(active);
    }
  };
  /* Enter with no active row submits the text itself, when the host takes free text. */
  const onInputKeyDown = (e) => {
    if (e.key === 'Enter' && onSubmit && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.nativeEvent?.isComposing
      && !(items.length && active >= 0 && items[active])) {
      e.preventDefault();
      const text = String(query || '').trim();
      if (text) onSubmit(text);
      return;
    }
    onListKeys(e, false);
  };

  const custom = children != null && children !== false;
  /* A pure command bar (free text, no result list) is a plain field, not a combobox. */
  const combo = !(onSubmit && !Array.isArray(results));
  const showList = !custom && hasQuery && items.length > 0;
  const showEmpty = !custom && hasQuery && items.length === 0 && !onSubmit;
  const hints = Array.isArray(shortcuts) ? shortcuts.filter((s) => s && s.keys) : [];
  const optionId = (i) => `${baseId}-opt-${i}`;

  return (
    <React.Fragment>
      <div aria-hidden="true" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex, background: SCRIMS[scrim] || SCRIM }} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={onPanelKeyDown}
        style={{
          position: 'fixed', zIndex: zIndex + 1, top: '11vh', left: '50%', transform: 'translateX(-50%)',
          width: 'min(640px, calc(100% - 32px))', maxHeight: 'min(70vh, 620px)',
          display: 'flex', flexDirection: 'column',
          background: 'var(--surface-card, #fff)',
          border: '1px solid var(--border-color, #dee2e6)',
          borderRadius: 10, overflow: 'hidden',
          boxShadow: 'var(--shadow-lg, 0 4px 8px rgba(0,0,0,.06), 0 12px 32px rgba(0,0,0,.14))',
          fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
          color: 'var(--text-body, #212529)',
          ...style,
        }}
        {...rest}
      >
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 10px 10px 12px', background: 'var(--surface-secondary, #f8f9fa)', borderBottom: '1px solid var(--border-color, #dee2e6)' }}>
          {leading != null && leading !== false && (
            <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center' }}>{leading}</span>
          )}
          <Input
            icon={leading != null && leading !== false ? undefined : 'bi-search'}
            inputRef={inputRef}
            value={query}
            placeholder={placeholder}
            aria-label={label}
            autoComplete="off"
            {...(combo ? {
              role: 'combobox',
              'aria-expanded': showList ? 'true' : 'false',
              'aria-controls': showList ? listId : undefined,
              'aria-autocomplete': 'list',
              'aria-activedescendant': showList && active >= 0 ? optionId(active) : undefined,
            } : {})}
            onChange={(e) => onQueryChange && onQueryChange(e.target.value)}
            onKeyDown={onInputKeyDown}
            style={{ flex: '1 1 auto', minWidth: 0 }}
          />
          <IconButton icon="bi-x-lg" variant="ghost" size="sm" ariaLabel={closeLabel} onClick={onClose} />
        </div>

        {(countLabel || hints.length > 0) && (
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 14px', fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5a6268)', borderBottom: '1px solid var(--list-divider, #e9ecef)' }}>
            <span role={onAnnounce ? undefined : 'status'}>{countLabel}</span>
            {hints.length > 0 && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {hints.map((s, i) => <ShortcutKey key={i} label={s.label}>{s.keys}</ShortcutKey>)}
              </span>
            )}
          </div>
        )}

        <div ref={listRef} style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
          {showList && (
            /* The field drives this listbox, and it is also a Tab stop of its own (the ARIA
               listbox pattern), so a long list stays keyboard-scrollable. */
            <div
              id={listId}
              role="listbox"
              aria-label={`${label} results`}
              tabIndex={0}
              aria-activedescendant={active >= 0 ? optionId(active) : undefined}
              onKeyDown={(e) => onListKeys(e, true)}
              onFocus={() => setListFocus(true)}
              onBlur={() => setListFocus(false)}
              style={{
                outline: listFocus ? 'var(--focus-outline, 2px solid #0079a8)' : 'none',
                outlineOffset: -2,
              }}
            >
              {items.map((r, i) => {
                const on = i === active;
                return (
                  <div
                    key={r.id != null ? r.id : i}
                    id={optionId(i)}
                    data-index={i}
                    role="option"
                    aria-selected={on ? 'true' : 'false'}
                    onClick={() => { setActive(i); select(i); }}
                    onMouseMove={() => { if (!on) setActive(i); }}
                    style={{
                      display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 16px', cursor: 'pointer',
                      borderBottom: '1px solid var(--list-divider, #e9ecef)',
                      background: on ? 'var(--surface-navy-subtle, #eaf1f6)' : 'transparent',
                      boxShadow: on ? 'inset 3px 0 0 var(--list-rail, #0079a8)' : 'none',
                    }}
                  >
                    {r.kind && <Eyebrow>{r.kind}</Eyebrow>}
                    <span style={{ fontSize: 'var(--font-size-dense, 13px)', fontWeight: 600, lineHeight: 1.4, color: 'var(--text-body, #212529)', textWrap: 'pretty' }}>{r.title}</span>
                    {r.meta && <span style={{ fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5a6268)' }}>{r.meta}</span>}
                    {r.note && <span style={{ fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)', fontSize: 'var(--font-size-label, 11px)', color: 'var(--text-data, #495057)' }}>{r.note}</span>}
                  </div>
                );
              })}
            </div>
          )}
          {showEmpty && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, padding: '22px 16px' }}>
              <i aria-hidden="true" className="bi bi-search" style={{ fontSize: 20, color: 'var(--text-secondary, #5a6268)' }} />
              <span style={{ fontSize: 'var(--font-size-dense, 13px)', fontWeight: 600 }}>{emptyTitle}</span>
              {emptyBody && <span style={{ fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.5, color: 'var(--text-secondary, #5a6268)', textWrap: 'pretty' }}>{emptyBody}</span>}
              {onClear && <Button variant="secondary" outline size="sm" icon="bi-x-circle" onClick={() => { onClear(); if (inputRef.current) inputRef.current.focus(); }}>{clearLabel}</Button>}
            </div>
          )}
          {/* A polite region, so an answer that replaces the hint is read without moving focus. */}
          {custom && <div data-palette-content="" aria-live="polite">{children}</div>}
          {!custom && !hasQuery && idle != null && idle !== false && (
            <div style={{ padding: '22px 16px', fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.5, color: 'var(--text-secondary, #5a6268)', textWrap: 'pretty' }}>{idle}</div>
          )}
        </div>
      </div>
    </React.Fragment>
  );
}
