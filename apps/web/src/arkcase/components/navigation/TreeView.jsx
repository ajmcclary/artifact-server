import React from 'react';
import { flattenTree } from './tree-model.js';
import { typeahead, typeaheadChar } from '../utilities/a11y-keys.jsx';

export { flattenTree, allBranchIds, countLeaves, ancestorIds } from './tree-model.js';

/**
 * ArkCase TreeView — a data-driven, single-select WAI-ARIA tree: the Designer Storybook
 * prototype's library sidebar promoted to a shared component. Rows are 28px buttons with
 * `role="treeitem"`, a chevron column, an optional `bi-*` icon, an ellipsized label and a
 * trailing count pill; `section: true` nodes are the sticky uppercase section headers. The
 * selected row is the solid primary fill with tonal icons.
 *
 * The rows are flat siblings carrying `aria-level`, `aria-setsize` and `aria-posinset` (the
 * prototype's structure, which lets section headers stick and filtering stay one pass), with
 * exactly one row tabbable (roving tabindex). Up/Down, Home/End, Right (expand, then first
 * child), Left (collapse, then parent), Enter/Space (select a leaf, toggle a branch), `*`
 * (expand sibling branches), first-letter typeahead, and Shift+F10 / ContextMenu for
 * `onContextMenu`. Selection does not follow focus.
 *
 * `expanded` and `selected` are controlled when given, internal otherwise. `query` and
 * `filter` narrow the rows; ancestors of matches are forced open. The pure model lives in
 * `tree-model.js` and is re-exported here.
 *
 * Outline rows (the Form Builder's element tree) add small status `markers` after the label and a
 * trailing data-face `meta` text; both are spoken through the row's description, not its name.
 * `picked` marks the row a host is moving by keyboard (dashed outline, tint, ", moving"), and a
 * host `onKeyDown(event, row)` runs before the built-in keys so it can take them with
 * `preventDefault()`.
 */
const ROW_H = 28;
const SECTION_H = 36;

const MARKER_TONES = {
  neutral: 'var(--text-secondary, #5a6268)',
  info: 'var(--text-info-on-tint, #005a7d)',
  warning: 'var(--pill-warning-fg, #92400e)',
  danger: 'var(--pill-danger-fg, #991b1b)',
  primary: 'var(--text-link, #0079a8)',
};

/** Plain-text description of a row: marker labels, the meta text and the moving state. */
function describe(n) {
  const parts = (n.markers || []).map((m) => m.label).filter(Boolean);
  const hasMeta = n.meta != null && n.meta !== '' && n.meta !== false;
  if (!parts.length && !hasMeta && !n.picked) return null;
  return (
    <>
      {parts.join(', ')}
      {hasMeta && parts.length ? ', ' : null}
      {hasMeta ? n.meta : null}
      {n.picked ? (parts.length || hasMeta ? ', moving' : 'moving') : null}
    </>
  );
}

const srOnly = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
};

function Badge({ badge }) {
  const tone = badge.tone || 'primary';
  const spoken = badge.label;
  return (
    <span
      title={spoken || undefined}
      style={{
        marginLeft: 'auto', flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        gap: 3, minWidth: 18, boxSizing: 'border-box', height: 16, padding: '0 6px',
        borderRadius: 'var(--radius-pill, 10px)',
        background: `var(--pill-${tone}-bg, #e0f2fe)`, color: `var(--pill-${tone}-fg, #0369a1)`,
        fontFamily: 'var(--font-data, "Source Code Pro", monospace)',
        fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)',
        fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, lineHeight: 1,
      }}
    >
      {badge.icon && <i className={`bi ${badge.icon}`} aria-hidden="true" style={{ fontSize: 'var(--font-size-label, 11px)', lineHeight: 1, color: 'currentColor' }} />}
      {badge.value != null && badge.value !== '' && <span aria-hidden={spoken ? 'true' : undefined}>{badge.value}</span>}
      {spoken && <span style={srOnly}>{spoken}</span>}
    </span>
  );
}

export function TreeView({
  nodes = [], label, expanded, defaultExpanded = [], onExpandedChange, selected, onSelect,
  selectBranches = false, query = '', filter, emptyMessage = 'No items match.',
  onContextMenu, onMore, moreLabel = (node) => `More actions for ${node.label}`,
  onKeyDown: onHostKeyDown, metaWidth = 90, treeRef, style, ...rest
}) {
  const uid = React.useId();
  const [innerExpanded, setInnerExpanded] = React.useState(defaultExpanded);
  const [innerSelected, setInnerSelected] = React.useState(null);
  const [focusId, setFocusId] = React.useState(null);
  const [hoverId, setHoverId] = React.useState(null);
  const [withinId, setWithinId] = React.useState(null);
  const rootRef = React.useRef(null);

  const openIds = expanded !== undefined ? expanded : innerExpanded;
  const current = selected !== undefined ? selected : innerSelected;
  const rows = React.useMemo(() => flattenTree(nodes, { expanded: openIds, query, filter }), [nodes, openIds, query, filter]);

  const has = (id) => id != null && rows.some((r) => r.id === id);
  const tabId = has(focusId) ? focusId : has(current) ? current : rows[0] && rows[0].id;

  const setTreeRef = React.useCallback((el) => {
    rootRef.current = el;
    if (typeof treeRef === 'function') treeRef(el);
    else if (treeRef && typeof treeRef === 'object') treeRef.current = el;
  }, [treeRef]);

  const setOpen = (ids) => { if (expanded === undefined) setInnerExpanded(ids); onExpandedChange && onExpandedChange(ids); };
  const toggle = (row) => setOpen(row.open ? openIds.filter((x) => x !== row.id) : openIds.concat(row.id));
  const expand = (ids) => { const add = ids.filter((x) => openIds.indexOf(x) < 0); if (add.length) setOpen(openIds.concat(add)); };
  const select = (row) => { if (selected === undefined) setInnerSelected(row.id); onSelect && onSelect(row.node); };

  const activate = (row, e) => {
    setFocusId(row.id);
    if (row.node.disabled) return;
    if (row.section) { if (row.hasChildren) toggle(row); return; }
    const onChevron = !!(e && e.target && e.target.closest && e.target.closest('[data-tree-chevron]'));
    if (row.hasChildren && (!selectBranches || onChevron)) toggle(row);
    else select(row);
  };

  const rowEl = (id) => {
    const root = rootRef.current;
    if (!root) return null;
    return Array.from(root.querySelectorAll('[data-tree-id]')).find((el) => el.getAttribute('data-tree-id') === id) || null;
  };
  const moveTo = (row) => { if (!row) return; setFocusId(row.id); const el = rowEl(row.id); el && el.focus(); };

  const onKeyDown = (e) => {
    const host = e.target && e.target.closest ? e.target.closest('[data-tree-id]') : null;
    const i = host ? rows.findIndex((r) => r.id === host.getAttribute('data-tree-id')) : -1;
    const row = i < 0 ? null : rows[i];
    if (onHostKeyDown) onHostKeyDown(e, row);
    if (e.defaultPrevented) return;
    if (!row || e.target !== host) return;
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      if (!row.section && onContextMenu) onContextMenu(row.node, host.getBoundingClientRect());
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    let target = null;
    switch (e.key) {
      case 'ArrowDown': target = rows[i + 1]; break;
      case 'ArrowUp': target = rows[i - 1]; break;
      case 'Home': target = rows[0]; break;
      case 'End': target = rows[rows.length - 1]; break;
      case 'ArrowRight':
        if (row.hasChildren && !row.open) { e.preventDefault(); toggle(row); return; }
        if (row.hasChildren && rows[i + 1] && rows[i + 1].parentId === row.id) target = rows[i + 1];
        break;
      case 'ArrowLeft':
        if (row.hasChildren && row.open && !row.forced) { e.preventDefault(); toggle(row); return; }
        target = rows.find((r) => r.id === row.parentId);
        break;
      case '*':
        e.preventDefault();
        expand(rows.filter((r) => r.parentId === row.parentId && r.hasChildren).map((r) => r.id));
        return;
      default: {
        const ch = typeaheadChar(e);
        if (!ch) return;
        const hit = typeahead(rows.map((r) => r.label), i, ch);
        if (hit < 0) return;
        target = rows[hit];
      }
    }
    e.preventDefault();
    moveTo(target);
  };

  if (!rows.length) {
    return (
      <div style={{ overflowY: 'auto', background: 'var(--surface-card, #fff)', ...style }} {...rest}>
        <div role="status" style={{ padding: '12px 16px', fontFamily: 'var(--font-body, "Public Sans", sans-serif)', fontSize: 'var(--font-size-dense, 13px)', color: 'var(--text-secondary, #5a6268)' }}>
          {emptyMessage}
        </div>
      </div>
    );
  }

  const popup = onContextMenu ? 'menu' : undefined;
  const keys = onContextMenu ? 'Shift+F10' : undefined;

  return (
    <div style={{ overflowY: 'auto', background: 'var(--surface-card, #fff)', ...style }} {...rest}>
      <div role="tree" aria-label={label} ref={setTreeRef} onKeyDown={onKeyDown}
        style={{ fontFamily: 'var(--font-body, "Public Sans", sans-serif)' }}>
        {rows.map((row, idx) => {
          const n = row.node;
          const tabIndex = row.id === tabId ? 0 : -1;
          const chevron = row.open ? 'bi-chevron-down' : 'bi-chevron-right';
          if (row.section) {
            return (
              <button key={row.id} type="button" role="treeitem" data-tree-id={row.id}
                aria-level={row.level} aria-setsize={row.setsize} aria-posinset={row.posinset}
                aria-expanded={row.hasChildren ? row.open : undefined}
                aria-disabled={n.disabled ? 'true' : undefined}
                tabIndex={tabIndex}
                onFocus={() => setFocusId(row.id)}
                onClick={() => activate(row)}
                onMouseEnter={() => setHoverId(row.id)} onMouseLeave={() => setHoverId(null)}
                style={{
                  '--focus-outline-offset': '-2px',
                  position: 'sticky', top: 0, zIndex: 2, width: '100%', display: 'flex', alignItems: 'center',
                  justifyContent: 'space-between', height: SECTION_H, padding: '0 12px 0 16px', margin: 0,
                  border: 0, borderTop: idx > 0 ? '1px solid var(--border-color, #dee2e6)' : 0,
                  borderBottom: '1px solid var(--border-color, #dee2e6)', boxSizing: 'border-box',
                  background: hoverId === row.id ? 'var(--surface-tertiary, #e9ecef)' : 'var(--surface-secondary, #f8f9fa)',
                  color: hoverId === row.id ? 'var(--text-emphasis, #374151)' : 'var(--text-secondary, #5a6268)',
                  cursor: 'pointer', font: 'inherit', fontSize: 'var(--font-size-xs, 12px)', fontWeight: 600,
                  letterSpacing: 'var(--letter-spacing-wide, 0.025em)', textTransform: 'uppercase', textAlign: 'left',
                }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.label}</span>
                {row.hasChildren && <i className={`bi ${row.open ? 'bi-chevron-up' : 'bi-chevron-down'}`} aria-hidden="true" style={{ fontSize: 'var(--font-size-label, 11px)', color: 'currentColor' }} />}
              </button>
            );
          }
          const on = row.id === current;
          const picked = !!n.picked;
          const solid = on && !picked;
          const disabled = !!n.disabled;
          const showMore = !!onMore && (on || hoverId === row.id || withinId === row.id);
          const fg = solid ? 'var(--text-on-primary, #fff)' : disabled ? 'var(--text-secondary, #5a6268)' : 'var(--text-body, #212529)';
          const markers = (n.markers || []).filter((m) => m && m.icon);
          const hasMeta = n.meta != null && n.meta !== '' && n.meta !== false;
          const description = describe(n);
          const descId = description ? `${uid}-d${idx}` : undefined;
          return (
            <div key={row.id} role="none" style={{ position: 'relative' }}
              onMouseEnter={() => setHoverId(row.id)} onMouseLeave={() => setHoverId(null)}
              onFocus={() => setWithinId(row.id)}
              onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setWithinId((w) => (w === row.id ? null : w)); }}>
              <button type="button" role="treeitem" data-tree-id={row.id}
                aria-level={row.level} aria-setsize={row.setsize} aria-posinset={row.posinset}
                aria-expanded={row.hasChildren ? row.open : undefined}
                aria-selected={on}
                aria-disabled={disabled ? 'true' : undefined}
                aria-haspopup={popup} aria-keyshortcuts={keys}
                aria-describedby={descId}
                data-icon-tone={solid ? 'current' : undefined}
                data-tree-picked={picked ? '' : undefined}
                tabIndex={tabIndex}
                onFocus={() => setFocusId(row.id)}
                onClick={(e) => activate(row, e)}
                style={{
                  '--focus-outline-offset': '-2px',
                  ...(solid ? { '--focus-outline': '2px solid var(--text-on-primary, #fff)' } : null),
                  ...(picked ? { '--focus-outline': '2px dashed var(--bs-primary, #0079a8)' } : null),
                  position: 'relative',
                  scrollMarginTop: SECTION_H, width: '100%', display: 'flex', alignItems: 'center', gap: 6,
                  height: ROW_H, padding: `0 ${onMore ? 28 : 12}px 0 ${8 + row.depth * 14}px`, margin: 0, boxSizing: 'border-box',
                  border: 0, borderRadius: 0,
                  background: solid ? 'var(--bs-primary, #0079a8)' : picked || (hoverId === row.id && !disabled) ? 'var(--tint-primary-selected, rgba(0,121,168,0.10))' : 'transparent',
                  color: fg, font: 'inherit', fontSize: 'var(--font-size-dense, 13px)', fontWeight: on ? 600 : 400,
                  cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'left',
                }}>
                <i className={`bi ${chevron}`} aria-hidden="true" data-tree-chevron=""
                  style={{ flex: 'none', fontSize: 'var(--font-size-label, 11px)', width: 12, textAlign: 'center', visibility: row.hasChildren ? 'visible' : 'hidden', color: solid ? 'currentColor' : 'var(--text-secondary, #5a6268)' }} />
                {n.icon && <i className={`bi ${n.icon}`} aria-hidden="true"
                  style={{ flex: 'none', fontSize: 'var(--font-size-dense, 13px)', ...(solid ? { color: 'currentColor' } : n.iconColor ? { color: n.iconColor } : null) }} />}
                <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...(markers.length || hasMeta ? { flex: '1 1 auto' } : null) }}>{n.label}</span>
                {markers.map((m, k) => (
                  <i key={k} className={`bi ${m.icon}`} aria-hidden="true" title={m.label} data-tree-marker=""
                    style={{ flex: 'none', fontSize: 'var(--font-size-label, 11px)', lineHeight: 1, color: solid ? 'currentColor' : MARKER_TONES[m.tone] || MARKER_TONES.neutral }} />
                ))}
                {hasMeta && (
                  <span aria-hidden="true" data-tree-meta=""
                    style={{
                      flex: 'none', maxWidth: metaWidth, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontFamily: 'var(--font-data, "Source Code Pro", monospace)', fontSize: 'var(--font-size-label, 11px)', fontWeight: 400,
                      color: solid ? 'currentColor' : 'var(--text-secondary, #5a6268)',
                    }}>
                    {n.meta}
                  </span>
                )}
                {n.badge && <Badge badge={n.badge} />}
                {picked && (
                  <span aria-hidden="true" style={{ position: 'absolute', inset: 0, border: '1px dashed var(--bs-primary, #0079a8)', pointerEvents: 'none' }} />
                )}
              </button>
              {description && <span id={descId} hidden>{description}</span>}
              {showMore && (
                <button type="button" aria-hidden="true" tabIndex={-1} title={moreLabel(n)}
                  onClick={(e) => { e.stopPropagation(); onMore(n, e.currentTarget.getBoundingClientRect()); }}
                  style={{
                    position: 'absolute', right: 8, top: 5, width: 18, height: 18, display: 'grid', placeItems: 'center',
                    padding: 0, border: 0, borderRadius: 'var(--radius-sm, 4px)', background: 'transparent',
                    color: solid ? 'var(--text-on-primary, #fff)' : 'var(--text-secondary, #5a6268)',
                    cursor: 'pointer', fontSize: 'var(--font-size-sm, 14px)',
                  }}>
                  <i className="bi bi-three-dots" aria-hidden="true" style={{ color: 'currentColor' }} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
