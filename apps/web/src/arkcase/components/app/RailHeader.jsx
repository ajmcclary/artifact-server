import React from 'react';
import { Input } from '../forms/Input.jsx';
import { IconButton } from '../actions/IconButton.jsx';
import { Menu } from '../overlays/Menu.jsx';
import { splitSlots } from '../utilities/slots.jsx';

const ELLIPSIS = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

/**
 * ArkCase RailHeader — the one header every list panel opens on. Row one names the list
 * (a real heading in the display face) with secondary actions and the single add button hard
 * right; row two is the working row: optional select-all, then the always-present pill search
 * with an optional scope menu inside it. A third row shows the filter slot while it is open,
 * otherwise a one-line summary of what is applied.
 *
 * The count is not part of the header — it changes as the list narrows, so it lives in the
 * Panel footer (`footerMeta`). The add button is drawn here, never by the host, so its shape,
 * size and tonal glyph cannot drift between projects.
 *
 * `search={false}` is for the few lists with no quick filter (an Admin grid that filters in its
 * own toolbar): no pill, no scope menu, no warning; the working row stays only for select-all.
 */
export function RailHeader({
  title, titleWrap = false, headingLevel = 2, actions,
  onAdd, addLabel = 'Add', addDisabled = false,
  selectAll, onSelectAll, selectAllLabel = 'Select All',
  query, onQuery, queryPlaceholder = 'Search', queryLabel, queryKeyShortcuts, inputRef, onQueryKeyDown,
  scope, filter, filters: filtersProp, filtersOpen = false, summary, search = true, children, style, ...rest
}) {
  /* A portable page authors the drawer as page markup: a child with slot="filters" fills it. */
  const filters = filtersProp != null ? filtersProp : children != null ? splitSlots(children).filters : undefined;
  const [scopeOpen, setScopeOpen] = React.useState(false);
  const scopeButton = React.useRef(null);
  const showSearch = search !== false;
  const hasSearch = onQuery != null;
  React.useEffect(() => {
    if (showSearch && !hasSearch && typeof console !== 'undefined')
      console.warn('RailHeader: every list header carries a search — pass `onQuery`.');
  }, [showSearch, hasSearch]);

  const level = Math.min(6, Math.max(1, Number(headingLevel) || 2));
  const Heading = `h${level}`;
  const name = queryLabel || `Search ${typeof title === 'string' ? title.toLowerCase() : 'list'}`;
  const options = (showSearch && scope && scope.options) || [];
  const workingRow = showSearch || !!onSelectAll;
  const current = options.find((o) => String(o.value) === String(scope && scope.value)) || options[0];
  const scopeName = (scope && scope.label) || 'Scope';

  /* Escape belongs to the open menu: consume it here so a host's own Escape (closing a peek or
     dialog around the list) does not fire as well, and hand focus back to the scope button. */
  const onScopeKeyDown = (e) => {
    if (e.defaultPrevented || e.key !== 'Escape' || !scopeOpen) return;
    e.preventDefault();
    e.stopPropagation();
    setScopeOpen(false);
    if (scopeButton.current) scopeButton.current.focus();
  };

  const trailing = options.length ? (
    <span style={{ display: 'inline-flex', alignItems: 'stretch', alignSelf: 'stretch' }}>
      <span aria-hidden="true" style={{ width: 1, margin: '6px 0', background: 'var(--border-color, #dee2e6)' }} />
      <button
        ref={scopeButton}
        type="button"
        aria-haspopup="menu"
        aria-expanded={scopeOpen}
        aria-label={`${scopeName}: ${current ? current.label : ''}`}
        onClick={() => setScopeOpen((o) => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 118, padding: '0 8px 0 10px',
          border: 0, borderRadius: '0 999px 999px 0', background: 'transparent', font: 'inherit',
          fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-body, #212529)', cursor: 'pointer',
        }}
      >
        <span style={ELLIPSIS}>{current ? current.label : ''}</span>
        <i className="bi bi-chevron-down" aria-hidden="true" style={{ flex: 'none', fontSize: 'var(--icon-xs, 12px)', color: 'var(--text-secondary, #5a6268)' }} />
      </button>
    </span>
  ) : undefined;

  return (
    <div
      data-rail-header=""
      style={{ background: 'var(--surface-secondary, #f8f9fa)', borderBottom: '1px solid var(--border-color-strong, #ced4da)', minWidth: 0, ...style }}
      {...rest}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: workingRow ? '12px 14px 8px' : '12px 14px' }}>
        <Heading
          title={typeof title === 'string' ? title : undefined}
          style={{
            flex: '1 1 auto', minWidth: 0, margin: 0, fontFamily: 'var(--font-heading, "Source Serif 4", Georgia, serif)',
            fontSize: 'var(--h4-font-size, 1.25rem)', fontWeight: 600, lineHeight: 1.25, color: 'var(--text-body, #212529)', ...ELLIPSIS, ...(titleWrap ? { whiteSpace: 'normal', overflowWrap: 'anywhere' } : null),
          }}
        >{title}</Heading>
        {(filter || actions || onAdd) && (
          <span style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
            {actions}
            {filter && (
              <IconButton icon={filter.pressed ? 'bi-funnel-fill' : 'bi-funnel'} variant="light" size="sm"
                pressed={!!filter.pressed} count={filter.count || undefined} ariaLabel={filter.label || 'Filters'} onClick={filter.onToggle} />
            )}
            {onAdd && (
              <IconButton icon="bi-plus-lg" variant="primary" shape="circle" size="sm" ariaLabel={addLabel} disabled={addDisabled} onClick={onAdd} />
            )}
          </span>
        )}
      </div>
      {/* The scope menu hangs from this row, inset to its padding, so it never outgrows a narrow rail. */}
      {workingRow && (
      <div onKeyDown={onScopeKeyDown} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px 10px' }}>
        {onSelectAll && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none', fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5a6268)', whiteSpace: 'nowrap', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!selectAll} onChange={onSelectAll} style={{ width: 15, height: 15, margin: 0, accentColor: 'var(--bs-primary, #0079a8)', cursor: 'pointer' }} />
            {selectAllLabel}
          </label>
        )}
        {showSearch && (
        <Input
          type="search"
          variant="pill"
          size="sm"
          icon="bi-search"
          value={query ?? ''}
          onChange={onQuery || (() => {})}
          onKeyDown={onQueryKeyDown}
          inputRef={inputRef}
          placeholder={queryPlaceholder}
          aria-label={name}
          aria-keyshortcuts={queryKeyShortcuts}
          trailing={trailing}
          style={{ flex: '1 1 auto', minWidth: 0 }}
        />
        )}
        {options.length > 0 && (
          <Menu
            open={scopeOpen}
            onClose={() => setScopeOpen(false)}
            onKeyDown={onScopeKeyDown}
            label={scopeName}
            align="end"
            width="auto"
            style={{ left: 14, right: 14, top: 36 }}
            autoFocus
            items={options.map((o) => ({
              type: 'radio',
              checked: !!current && String(o.value) === String(current.value),
              label: o.label,
              meta: o.count != null && o.count !== '' ? String(o.count) : undefined,
              onClick: () => {
                if (scope.onChange) scope.onChange(o.value);
                if (scopeButton.current) scopeButton.current.focus();
              },
            }))}
          />
        )}
      </div>
      )}
      {filtersOpen && filters != null && (
        <div role="group" aria-label="Filters" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '6px 14px 12px' }}>{filters}</div>
      )}
      {!filtersOpen && summary != null && summary !== '' && (
        <div style={{ padding: '5px 14px', borderTop: '1px solid var(--border-color, #dee2e6)', fontSize: 'var(--font-size-label, 11px)', color: 'var(--text-secondary, #5a6268)', ...ELLIPSIS }}>{summary}</div>
      )}
    </div>
  );
}
