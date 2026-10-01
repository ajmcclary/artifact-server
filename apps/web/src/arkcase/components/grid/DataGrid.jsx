import { akStyleDocument } from '@/arkcase-style';
import React from 'react';
import { usesDataFont, filterRows, sortRows, orderColumns } from './data-grid-model.js';
import { nextSort, toggleSelection, toggleAllIn } from './data-grid-controller.js';
import { GridCheck, GridRadio, rowKey, fmt, stickyOffset } from './data-grid-view.jsx';
import { Menu } from '../overlays/Menu.jsx';
import { Button } from '../actions/Button.jsx';
import { IconButton } from '../actions/IconButton.jsx';
export { usesDataFont, comparatorFor } from './data-grid-model.js';

/**
 * ArkCase DataGrid — a faithful recreation of the app's AG Grid Enterprise
 * surface (Quartz/Alpine theme tuned to brand tokens). Sortable headers,
 * checkbox selection, pinned columns, striped rows, cyan hover, a toolbar,
 * a quick filter, and a status bar. Cell renderers are plain functions.
 *
 * Accessibility (WCAG 2.1.1 / 1.3.1 / 4.1.3): the grid is a proper
 * role="grid" with roving-tabindex keyboard navigation (arrow keys, Home/End,
 * Ctrl+Home/End), Enter/Space to sort a header or toggle a selection,
 * scope + aria-sort on headers, and a polite live region for async/row-count
 * changes.
 *
 * Column: { field, headerName, width?, pinned?: 'left'|'right', align?,
 *           sortable?, dataFont?, type?, cellRenderer?: (value,row)=>node }
 *
 * Data font (2026 type pass): opt a column in with `dataFont: true`, or with
 * `type: 'id'|'date'|'money'|'count'|'code'|'contact'` which implies it. Body
 * cells then render in var(--font-data) + var(--font-numeric-feature) at the
 * SAME px as the sans cells beside them (never one step down — Source Code Pro
 * reads optically smaller, so equal numbers is what makes a row look level) and
 * in var(--text-data) #495057, which clears 4.5:1 on white and on the #F8F9FA
 * zebra row. `align: 'right'` applies tabular-nums on its own, so an aligned
 * column can never ship with proportional digits. Use these instead of writing
 * font-family: 'Source Code Pro', monospace inline: the bare monospace keyword
 * drops --font-data's six named fallbacks.
 */
/* Link cells underline on hover; a pseudo-class cannot be inline, so the rule is injected once. */
function ensureDataGridLinkStyles() {
  if (typeof document === 'undefined' || akStyleDocument.getElementById('ak-data-grid-link-css')) return;
  const s = akStyleDocument.createElement('style');
  s.id = 'ak-data-grid-link-css';
  s.textContent = '[data-ak-grid-link]:hover,[data-ak-grid-cap]:hover{text-decoration:underline}' +
    '[data-ak-grid-cap]:focus-visible{outline:var(--focus-outline, 2px solid #0079a8);outline-offset:2px;border-radius:2px}';
  akStyleDocument.head.appendChild(s);
}

/* An anchored Menu is measured before it is shown, so its own autoFocus can land while the sheet
   is still hidden. Once it is visible, move focus into it unless it is already there. */
function useFocusMenuWhenOpen(open, menuAttr) {
  React.useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;
    const id = window.requestAnimationFrame(() => {
      const menu = document.querySelector('[' + menuAttr + ']');
      if (!menu || menu.contains(document.activeElement)) return;
      const first = /** @type {HTMLButtonElement[]} */ (Array.from(menu.querySelectorAll('[role^="menuitem"]'))).find((el) => !el.disabled);
      if (first) first.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open, menuAttr]);
}

/** @type {React.CSSProperties} */
const SR_ONLY = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };
const ACTIONS_W = 60;

/* Hands focus back after a menu closes, unless the close came from a press that has already
   put focus somewhere else on purpose. */
function restoreFocus(el) {
  if (!el || typeof document === 'undefined') return;
  const a = document.activeElement;
  if (!a || a === document.body || (a.closest && a.closest('[role="menu"]'))) el.focus();
}

/**
 * The column chooser: a "Columns" button that opens a Menu of checkbox items, one per column
 * that can be hidden, kept open while the reader toggles. The last visible column cannot be
 * hidden. `onReset` adds a "Reset to default" item. DataGrid draws one in its toolbar with
 * `columnChooser`; a host that lays out its own toolbar mounts this beside its other buttons
 * and passes the same `hiddenColumns` to the grid.
 *
 * @param {import('./DataGrid.d.ts').DataGridColumnChooserProps} props
 */
export function DataGridColumnChooser({ columns = [], hiddenColumns = [], onChange, onReset, label = 'Columns', resetLabel = 'Reset to default', style }) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef(null);
  const menuAttr = 'data-grid-chooser-menu-' + React.useId().replace(/[^A-Za-z0-9_-]/g, '');
  useFocusMenuWhenOpen(open, menuAttr);
  const hidden = new Set(hiddenColumns);
  const listed = columns.filter((c) => c.hideable !== false);
  const visibleAll = columns.filter((c) => !hidden.has(c.field)).length;
  const shown = listed.filter((c) => !hidden.has(c.field)).length;
  const close = () => {
    setOpen(false);
    restoreFocus(anchorRef.current && anchorRef.current.querySelector('button'));
  };
  /** @type {import('../overlays/Menu.d.ts').MenuItem[]} */
  const items = [{ heading: label }];
  items.push(...listed.map((c) => {
    const on = !hidden.has(c.field);
    const last = on && visibleAll <= 1;
    return {
      type: /** @type {'checkbox'} */ ('checkbox'), checked: on, keepOpen: true, disabled: last,
      label: typeof c.headerName === 'string' && c.headerName ? c.headerName : c.field,
      onClick: () => {
        if (last || !onChange) return;
        const next = on ? hiddenColumns.concat([c.field]) : hiddenColumns.filter((f) => f !== c.field);
        onChange(next);
      },
    };
  }));
  if (onReset) items.push({ divider: true }, { label: resetLabel, keepOpen: false, onClick: onReset });
  return (
    <span ref={anchorRef} data-grid-column-chooser="" style={{ display: 'inline-flex', flex: 'none', ...style }}>
      <Button
        variant="secondary" outline size="sm" icon="bi-sliders"
        expanded={open} hasPopup="menu"
        title="Choose columns"
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        <span style={{ marginLeft: 6, fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)', fontVariantNumeric: 'tabular-nums', fontSize: 'var(--font-size-label, 11px)', fontWeight: 400 }}>
          <span style={SR_ONLY}>, showing </span>{shown} of {listed.length}
        </span>
      </Button>
      <Menu open={open} items={items} onClose={close} anchor={open ? anchorRef.current : null} align="end" label={label} autoFocus {...{ [menuAttr]: '' }} />
    </span>
  );
}

/* A column with `onCellClick` or `cellHref` draws its content as a link. The link takes no
   tab stop of its own: the grid's roving focus sits on the cell, and Enter on the cell follows
   the link. A click stops at the link, so it never also activates the row. */
function DataGridLinkCell({ col, row, children }) {
  /** @type {React.CSSProperties} */
  const look = {
    padding: 0, margin: 0, border: 0, background: 'none', font: 'inherit', textAlign: 'inherit', maxWidth: '100%',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle',
    color: 'var(--text-link-on-tint, #00688f)', textDecoration: 'none', cursor: 'pointer',
  };
  const onClick = (e) => { e.stopPropagation(); if (col.onCellClick) col.onCellClick(row, row[col.field]); };
  if (col.cellHref) {
    return <a href={col.cellHref(row)} tabIndex={-1} data-ak-grid-link="" onClick={onClick} style={{ ...look, display: 'inline-block' }}>{children}</a>;
  }
  return <button type="button" tabIndex={-1} data-ak-grid-link="" onClick={onClick} style={look}>{children}</button>;
}

/** @param {import('./DataGrid.d.ts').DataGridProps} props */
export function DataGrid({
  columns = [], rows = [], title, selectable = true,
  quickFilter = true, toolbarActions, statusBar = true,
  rowHeight = null, height = 'auto', loading = false,
  ariaLabel, onRowClick, empty, style,
  selection = 'multiple', selectedIds, defaultSelectedIds, onSelectionChange,
  rowActions, rowActionsLabel,
  hiddenColumns: hiddenProp, defaultHiddenColumns, onHiddenColumnsChange, columnChooser = false,
  rowCap, rowCapExpanded, onRowCapExpandedChange, rowCapLabels, footer,
  ...rest
}) {
  const hasLinks = columns.some((c) => c.onCellClick || c.cellHref);
  React.useEffect(() => { if (hasLinks) ensureDataGridLinkStyles(); }, [hasLinks]);
  /* The grid's geometry is the token layer's, not this file's (Phase 4 item 17). The literal
     stays as each var()'s fallback, so a consumer that has not loaded the token layer draws
     exactly what it drew before -- the substitution cannot move a pixel, only a name. */
  const rowH = rowHeight == null ? 'var(--grid-row-height, 40px)' : rowHeight;
  const headH = 'var(--grid-header-height, 36px)';
  const cellX = '0 var(--grid-cell-padding-x, 0.5rem)';
  const [sort, setSort] = React.useState({ field: null, dir: null });
  const [query, setQuery] = React.useState('');
  const single = selection === 'single';
  /* Selection is owned unless `selectedIds` is given; every change is reported either way. */
  const [ownSelected, setOwnSelected] = React.useState(() => new Set(defaultSelectedIds || []));
  const controlledSel = selectedIds !== undefined && selectedIds !== null;
  const selected = React.useMemo(() => (controlledSel ? new Set(selectedIds) : ownSelected), [controlledSel, selectedIds, ownSelected]);
  const commitSelection = (next) => {
    if (!controlledSel) setOwnSelected(next);
    if (onSelectionChange) onSelectionChange(Array.from(next), rows.filter((r) => r && r.id != null && next.has(r.id)));
  };
  /* Hidden columns are owned unless `hiddenColumns` is given. */
  const [ownHidden, setOwnHidden] = React.useState(() => defaultHiddenColumns || []);
  const hiddenList = hiddenProp !== undefined && hiddenProp !== null ? hiddenProp : ownHidden;
  const setHidden = (next) => {
    if (hiddenProp === undefined || hiddenProp === null) setOwnHidden(next);
    if (onHiddenColumnsChange) onHiddenColumnsChange(next);
  };
  const visibleColumns = React.useMemo(() => {
    const h = new Set(hiddenList);
    return columns.filter((c) => !h.has(c.field));
  }, [columns, hiddenList]);
  /* The row cap's expansion is owned unless `rowCapExpanded` is given. */
  const [ownExpanded, setOwnExpanded] = React.useState(false);
  const expanded = rowCapExpanded !== undefined && rowCapExpanded !== null ? !!rowCapExpanded : ownExpanded;
  const [hoverRow, setHoverRow] = React.useState(null);
  const [pos, setPos] = React.useState({ r: 0, c: 0 });
  const [rowMenu, setRowMenu] = React.useState(null);
  const gridRef = React.useRef(null);

  const filtered = React.useMemo(() => filterRows(rows, visibleColumns, query), [rows, query, visibleColumns]);
  const sorted = React.useMemo(() => sortRows(filtered, columns, sort), [filtered, sort, columns]);
  /* The cap is taken after the filter and the sort, so a header click orders every row before
     the first `rowCap` are shown. */
  const capActive = typeof rowCap === 'number' && rowCap > 0 && sorted.length > rowCap;
  const shownRows = capActive && !expanded ? sorted.slice(0, rowCap) : sorted;
  const capped = shownRows.length < sorted.length;

  const toggleSort = (field, sortable) => {
    if (sortable === false) return;
    setSort((s) => nextSort(s, field));
  };

  const shownKeys = shownRows.map((r, i) => rowKey(r, i));
  const allChecked = shownKeys.length > 0 && shownKeys.every((k) => selected.has(k));
  const toggleAll = () => { if (!single) commitSelection(toggleAllIn(selected, shownKeys, allChecked)); };
  const toggleOne = (key) => {
    if (single) { if (!(selected.size === 1 && selected.has(key))) commitSelection(new Set([key])); return; }
    commitSelection(toggleSelection(selected, key));
  };

  const ordered = orderColumns(visibleColumns);
  const hasActions = typeof rowActions === 'function';
  const actionsName = (row) => (rowActionsLabel ? rowActionsLabel(row) : 'Actions');
  /* A column is a link for a row when it has a destination and, with `cellLinkable`, when the
     column says this row has one. */
  const linksIn = (c, row) => (c.onCellClick || c.cellHref) && row[c.field] != null && (!c.cellLinkable || c.cellLinkable(row));

  // --- Roving keyboard grid model -------------------------------------
  // Column 0 is the checkbox (when selectable); columns then map to `ordered`, and the row
  // actions column (when `rowActions` is given) is last.
  // Row 0 is the header; body rows are 1..shownRows.length.
  const lead = selectable ? 1 : 0;
  const totalCols = ordered.length + lead + (hasActions ? 1 : 0);
  const maxC = Math.max(0, totalCols - 1);
  const maxR = shownRows.length;
  const activeR = Math.min(pos.r, maxR);
  const activeC = Math.min(pos.c, maxC);
  const colAt = (c) => {
    if (selectable && c === 0) return '__check';
    if (hasActions && c === totalCols - 1) return '__actions';
    return ordered[c - lead];
  };

  const openRowMenu = (row, key, cellEl) => {
    const anchor = cellEl && cellEl.querySelector('[data-grid-row-actions]');
    if (!anchor) return;
    setRowMenu((m) => (m && m.key === key ? null : { key, row, anchor, cell: cellEl }));
  };
  const closeRowMenu = () => {
    const cell = rowMenu && rowMenu.cell;
    setRowMenu(null);
    restoreFocus(cell);
  };

  const activate = (r, c) => {
    const col = colAt(c);
    if (r === 0) {
      if (col === '__check') { if (selectable) toggleAll(); }
      else if (col && col !== '__actions') toggleSort(col.field, col.sortable);
    } else if (col === '__check') {
      const row = shownRows[r - 1];
      if (row) toggleOne(rowKey(row, r - 1));
    } else if (col === '__actions') {
      const row = shownRows[r - 1];
      const cell = gridRef.current && gridRef.current.querySelector(`[data-cell="${r}-${c}"]`);
      if (row) openRowMenu(row, rowKey(row, r - 1), cell);
    } else {
      /* A body cell: a link column follows its link; any other cell activates the row. */
      const row = shownRows[r - 1];
      if (!row || !col) return;
      if (linksIn(col, row) && col.cellHref) {
        const link = gridRef.current && gridRef.current.querySelector(`[data-cell="${r}-${c}"] [data-ak-grid-link]`);
        if (link) link.click();
      } else if (linksIn(col, row)) col.onCellClick(row, row[col.field]);
      else if (onRowClick) onRowClick(row);
    }
  };

  const onGridKey = (e) => {
    const cell = e.target.closest && e.target.closest('[data-cell]');
    if (!cell || !gridRef.current || !gridRef.current.contains(cell)) return;
    const [r, c] = cell.dataset.cell.split('-').map(Number);
    let nr = r, nc = c;
    switch (e.key) {
      case 'ArrowRight': nc = Math.min(maxC, c + 1); break;
      case 'ArrowLeft': nc = Math.max(0, c - 1); break;
      case 'ArrowDown': nr = Math.min(maxR, r + 1); break;
      case 'ArrowUp': nr = Math.max(0, r - 1); break;
      case 'Home': nc = 0; if (e.ctrlKey) nr = 0; break;
      case 'End': nc = maxC; if (e.ctrlKey) nr = maxR; break;
      case 'Enter': case ' ':
        /* A control the host rendered inside the cell (a button, a link) keeps its own keys. */
        if (e.target !== cell && e.target.closest('a, button, input, select, textarea')) return;
        activate(r, c); e.preventDefault(); return;
      default: return;
    }
    e.preventDefault();
    const next = gridRef.current.querySelector(`[data-cell="${nr}-${nc}"]`);
    if (next) { next.focus(); setPos({ r: nr, c: nc }); }
  };

  const cellNav = (r, c) => ({
    'data-cell': `${r}-${c}`,
    tabIndex: r === activeR && c === activeC ? 0 : -1,
    onFocus: () => setPos({ r, c }),
  });

  /* ---- scroll edges ----
     A grid narrower than its columns scrolls, and nothing about the last visible column says
     so: a reader takes the columns they can see for the whole table. These two washes are that
     sentence — one at each edge that has content behind it, gone at the end of the travel. The
     wash is a tint rather than a fade to a surface colour because the rows alternate white and
     --surface-secondary, and a gradient to one of them bands on every other row. The tint is
     densest against the edge it is anchored to and clears into the content: the gradient runs
     `to ${side}` from transparent to the tint, never the other way round, or the wash reads as
     a band sitting on the visible columns rather than as the content passing under the edge. */
  const scrollRef = React.useRef(null);
  const [edges, setEdges] = React.useState({ left: 0, right: 0 });
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    /* v8 ignore next */
    if (!el) return undefined;
    /* A pinned column does not scroll, so the edge the content disappears behind is that
       column's inner edge, not the box's. Measured rather than summed from the declared
       widths: a column may declare none, and the header cells know what they were given. */
    const pinned = (side) => {
      let w = 0;
      el.querySelectorAll(`thead [data-pinned="${side}"]`).forEach((th) => { w += th.offsetWidth; });
      return w;
    };
    const read = () => {
      const over = el.scrollWidth - el.clientWidth;
      const at = el.scrollLeft;
      setEdges((prev) => {
        const next = { left: at > 1 ? pinned('left') : -1, right: over > 1 && at < over - 1 ? pinned('right') : -1 };
        return prev.left === next.left && prev.right === next.right ? prev : next;
      });
    };
    read();
    el.addEventListener('scroll', read, { passive: true });
    /* v8 ignore next */
    if (typeof ResizeObserver === 'undefined') return () => el.removeEventListener('scroll', read);
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; read(); }); };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    if (el.firstChild) ro.observe(el.firstChild);
    return () => { el.removeEventListener('scroll', read); if (frame) cancelAnimationFrame(frame); ro.disconnect(); };
  }, [ordered.length, shownRows.length, selectable, hasActions]);
  /** @returns {React.CSSProperties} */
  const edgeWash = (side, offset) => ({
    position: 'absolute', top: 0, bottom: 0, [side]: offset, width: 'var(--grid-scroll-fade-width, 26px)',
    zIndex: 4, pointerEvents: 'none',
    background: `linear-gradient(to ${side}, transparent, var(--grid-scroll-fade, rgba(7, 54, 82, 0.16)))`,
  });

  const B = 'var(--border-color, #dee2e6)';
  const rightBase = hasActions ? ACTIONS_W : 0;
  const headerCell = (c, colIdx) => {
    const active = sort.field === c.field;
    const ariaSort = c.ariaSort || (c.sortable === false ? undefined : active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    return (
      <th
        key={c.field}
        scope="col"
        role="columnheader"
        aria-sort={ariaSort}
        data-pinned={c.pinned || undefined}
        {...cellNav(0, colIdx)}
        onClick={() => toggleSort(c.field, c.sortable)}
        style={{
          position: c.pinned ? 'sticky' : 'static',
          left: c.pinned === 'left' ? stickyOffset(ordered, c, 'left', selectable) : undefined,
          right: c.pinned === 'right' ? stickyOffset(ordered, c, 'right', false, rightBase) : undefined,
          zIndex: c.pinned ? 3 : 1,
          width: c.width, minWidth: c.width,
          textAlign: c.align || 'left',
          padding: cellX, height: headH,
          background: 'var(--surface-secondary, #f8f9fa)',
          color: 'var(--text-emphasis, #374151)', fontWeight: 500, fontSize: 14,
          fontVariantNumeric: c.align === 'right' ? 'var(--font-numeric-feature, tabular-nums)' : undefined,
          borderBottom: `1px solid ${B}`,
          borderRight: c.pinned === 'left' ? `1px solid ${B}` : 'none',
          cursor: c.sortable === false ? 'default' : 'pointer',
          whiteSpace: 'nowrap', userSelect: 'none',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: c.align === 'right' ? 'flex-end' : 'flex-start', width: '100%' }}>
          {c.headerName ?? c.field}
          {active && <i className={`bi ${sort.dir === 'asc' ? 'bi-arrow-up' : 'bi-arrow-down'}`} aria-hidden="true" style={{ fontSize: 12, color: 'var(--text-link, #0079a8)' }} />}
        </span>
      </th>
    );
  };

  const bodyCell = (c, row, rIdx, colIdx) => {
    const dataFont = usesDataFont(c);
    // tabular-nums: automatic for the data font AND for any right-aligned column.
    const tabular = dataFont || c.align === 'right';
    return (
    <td
      key={c.field}
      role="gridcell"
      {...cellNav(rIdx + 1, colIdx)}
      style={{
        position: c.pinned ? 'sticky' : 'static',
        left: c.pinned === 'left' ? stickyOffset(ordered, c, 'left', selectable) : undefined,
        right: c.pinned === 'right' ? stickyOffset(ordered, c, 'right', false, rightBase) : undefined,
        zIndex: c.pinned ? 2 : 0,
        width: c.width, minWidth: c.width,
        textAlign: c.align || 'left',
        padding: cellX, height: rowH,
        borderBottom: `1px solid ${B}`,
        borderRight: c.pinned === 'left' ? `1px solid ${B}` : 'none',
        borderLeft: c.pinned === 'right' ? `1px solid ${B}` : 'none',
        // Same 14px as sans cells — do not step mono down to 13px.
        fontSize: 14,
        fontFamily: dataFont ? "var(--font-data, 'Source Code Pro', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace)" : 'inherit',
        fontVariantNumeric: tabular ? 'var(--font-numeric-feature, tabular-nums)' : undefined,
        color: dataFont ? 'var(--text-data, #495057)' : 'var(--text-body, #212529)',
        background: 'inherit',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        verticalAlign: 'middle',
      }}
    >
      {linksIn(c, row)
        ? <DataGridLinkCell col={c} row={row}>{c.cellRenderer ? c.cellRenderer(row[c.field], row) : fmt(row[c.field])}</DataGridLinkCell>
        : c.cellRenderer ? c.cellRenderer(row[c.field], row) : fmt(row[c.field])}
    </td>
    );
  };

  /** @returns {React.CSSProperties} */
  const checkboxColStyle = (pinned) => ({
    position: 'sticky', left: 0, zIndex: pinned ? 3 : 2,
    width: 44, minWidth: 44, padding: cellX,
    background: pinned ? 'var(--surface-secondary, #f8f9fa)' : 'inherit',
    borderRight: `1px solid ${B}`, textAlign: 'center',
  });
  /** @returns {React.CSSProperties} */
  const actionsColStyle = (head) => ({
    position: 'sticky', right: 0, zIndex: head ? 3 : 2,
    width: ACTIONS_W, minWidth: ACTIONS_W, padding: '0 4px', boxSizing: 'border-box',
    background: head ? 'var(--surface-secondary, #f8f9fa)' : 'inherit',
    borderLeft: `1px solid ${B}`, textAlign: 'center',
  });

  const capLabel = (which) => {
    const custom = rowCapLabels && rowCapLabels[which];
    const n = which === 'more' ? sorted.length : rowCap;
    if (typeof custom === 'function') return custom(n);
    if (custom) return custom;
    return which === 'more' ? `Show all ${n}` : `Show first ${n}`;
  };
  const toggleCap = () => {
    const next = !expanded;
    if (rowCapExpanded === undefined || rowCapExpanded === null) setOwnExpanded(next);
    if (onRowCapExpandedChange) onRowCapExpandedChange(next);
  };
  const capBar = capActive;
  React.useEffect(() => { if (capBar) ensureDataGridLinkStyles(); }, [capBar]);
  const menuRow = rowMenu && shownRows.find((r, i) => rowKey(r, i) === rowMenu.key);
  const menuItems = menuRow ? rowActions(menuRow) || [] : [];
  const rowMenuAttr = 'data-grid-row-menu-' + React.useId().replace(/[^A-Za-z0-9_-]/g, '');
  useFocusMenuWhenOpen(!!menuRow && menuItems.length > 0 ? 'row-' + String(rowMenu.key) : null, rowMenuAttr);

  return (
    <div
      style={{
        border: `1px solid ${B}`, borderRadius: 'var(--radius-md, 6px)',
        overflow: 'hidden', background: 'var(--surface-card, #fff)',
        fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
        display: 'flex', flexDirection: 'column',
        height: height === 'auto' ? undefined : height,
        ...style,
      }}
      {...rest}
    >
      {(title || quickFilter || toolbarActions || columnChooser) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 12px', borderBottom: `1px solid ${B}`, background: 'var(--surface-card, #fff)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {title && <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-body, #212529)' }}>{title}</span>}
            {selected.size > 0 && <span style={{ fontSize: 13, color: 'var(--text-link, #0079a8)', fontWeight: 500 }}>{selected.size} selected</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {quickFilter && (
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <i className="bi bi-search" aria-hidden="true" style={{ position: 'absolute', left: 8, color: 'var(--text-secondary, #5a6268)', fontSize: 13 }} />
                <input
                  value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Quick filter…"
                  aria-label={title ? `Filter ${title}` : 'Quick filter'}
                  style={{ padding: '5px 8px 5px 26px', fontSize: 13, border: `1px solid var(--border-color-strong, #ced4da)`, borderRadius: 6, width: 180, fontFamily: 'inherit' }}
                />
              </div>
            )}
            {toolbarActions}
            {columnChooser && (
              <DataGridColumnChooser
                columns={columns}
                hiddenColumns={hiddenList}
                onChange={setHidden}
                onReset={() => setHidden(defaultHiddenColumns || [])}
                label={typeof columnChooser === 'object' && columnChooser.label ? columnChooser.label : undefined}
              />
            )}
          </div>
        </div>
      )}

      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div ref={scrollRef} style={{ position: 'relative', overflow: 'auto', flex: 1, minHeight: 0 }}>
          <table
            ref={gridRef}
            role="grid"
            aria-label={ariaLabel || title || 'Data grid'}
            aria-rowcount={sorted.length + 1}
            aria-colcount={totalCols}
            aria-multiselectable={selectable && !single ? true : undefined}
            onKeyDown={onGridKey}
            style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', tableLayout: 'fixed' }}
          >
            <thead>
              <tr role="row">
                {selectable && !single && (
                  <th
                    scope="col"
                    role="columnheader"
                    aria-label="Select all rows"
                    data-pinned="left"
                    {...cellNav(0, 0)}
                    onClick={toggleAll}
                    style={{ ...checkboxColStyle(true), height: headH, borderBottom: `1px solid ${B}` }}
                  >
                    <GridCheck checked={allChecked} onChange={toggleAll} label="Select all rows" />
                  </th>
                )}
                {selectable && single && (
                  <th
                    scope="col"
                    role="columnheader"
                    data-pinned="left"
                    {...cellNav(0, 0)}
                    style={{ ...checkboxColStyle(true), height: headH, borderBottom: `1px solid ${B}` }}
                  >
                    <span style={SR_ONLY}>Select</span>
                  </th>
                )}
                {ordered.map((c, i) => headerCell(c, i + lead))}
                {hasActions && (
                  <th
                    scope="col"
                    role="columnheader"
                    data-pinned="right"
                    {...cellNav(0, totalCols - 1)}
                    style={{
                      ...actionsColStyle(true), height: headH, borderBottom: `1px solid ${B}`,
                      color: 'var(--text-emphasis, #374151)', fontWeight: 500, fontSize: 14, whiteSpace: 'nowrap',
                    }}
                  >
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {shownRows.map((row, rIdx) => {
                const key = rowKey(row, rIdx);
                const isSel = selected.has(key);
                const isHover = hoverRow === key;
                const bg = isSel ? 'var(--tint-primary-selected, rgba(0,121,168,0.10))' : isHover ? 'var(--tint-primary-hover, rgba(0,121,168,0.05))' : (rIdx % 2 ? 'var(--surface-secondary, #f8f9fa)' : 'var(--surface-card, #ffffff)');
                return (
                  <tr
                    role="row" aria-selected={selectable ? isSel : undefined} key={key}
                    aria-rowindex={capped ? rIdx + 2 : undefined}
                    onMouseEnter={() => setHoverRow(key)} onMouseLeave={() => setHoverRow(null)}
                    onClick={onRowClick ? (e) => {
                      if (/** @type {HTMLElement} */ (e.target).closest('[data-grid-check], a, button, input, select, textarea')) return;
                      onRowClick(row);
                    } : undefined}
                    style={{ background: bg, transition: 'background-color .12s ease', cursor: onRowClick ? 'pointer' : undefined }}
                  >
                    {selectable && (
                      <td
                        role="gridcell"
                        data-grid-check=""
                        {...cellNav(rIdx + 1, 0)}
                        style={{ ...checkboxColStyle(false), height: rowH, borderBottom: `1px solid ${B}`, background: 'inherit' }}
                      >
                        {single
                          ? <GridRadio checked={isSel} onChange={() => toggleOne(key)} label="Select row" />
                          : <GridCheck checked={isSel} onChange={() => toggleOne(key)} label="Select row" />}
                      </td>
                    )}
                    {ordered.map((c, i) => bodyCell(c, row, rIdx, i + lead))}
                    {hasActions && (() => {
                      const items = rowActions(row);
                      const has = Array.isArray(items) && items.length > 0;
                      const open = !!rowMenu && rowMenu.key === key;
                      return (
                        <td
                          role="gridcell"
                          data-grid-actions=""
                          {...cellNav(rIdx + 1, totalCols - 1)}
                          style={{ ...actionsColStyle(false), height: rowH, borderBottom: `1px solid ${B}` }}
                        >
                          {has && (
                            <IconButton
                              icon="bi-three-dots-vertical" variant="ghost" size="sm"
                              ariaLabel={actionsName(row)}
                              expanded={open} hasPopup="menu"
                              {...{ tabIndex: -1, 'data-grid-row-actions': '' }}
                              onClick={(e) => { e.stopPropagation(); openRowMenu(row, key, e.currentTarget.closest('[data-cell]')); }}
                            />
                          )}
                        </td>
                      );
                    })()}
                  </tr>
                );
              })}
              {sorted.length === 0 && !loading && (
                <tr role="row"><td role="gridcell" colSpan={totalCols} style={{ padding: '1.25rem', textAlign: 'center', color: 'var(--text-secondary, #5a6268)', fontSize: 14 }}>{empty ?? 'No rows found'}</td></tr>
              )}
            </tbody>
          </table>

          {loading && (
            <div role="status" aria-live="polite" style={{ position: 'absolute', inset: 0 }}>
              <div style={{ position: 'absolute', inset: 0, background: 'var(--surface-body, #fff)', opacity: 0.7 }} />
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--text-data, #495057)', fontSize: 14 }}>
                {/* Same CSS border-spinner Button ships (keyframe: base.css @keyframes ak-spin).
                    Replaces the static bi-arrow-repeat that never actually spun. */}
                <span aria-hidden="true" style={{ display: 'inline-block', width: 18, height: 18, border: '2px solid var(--bs-primary, #0079a8)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'ak-spin .7s linear infinite' }} />
                Loading…
              </div>
            </div>
          )}
        </div>
        {edges.left >= 0 && <span aria-hidden="true" style={edgeWash('left', edges.left)} />}
        {edges.right >= 0 && <span aria-hidden="true" style={edgeWash('right', edges.right)} />}
      </div>

      {(capBar || footer != null) && (
        <div data-grid-footer="" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, padding: '8px 12px', borderTop: '1px solid var(--list-divider, #e9ecef)', background: 'var(--surface-secondary, #f8f9fa)', fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5a6268)' }}>
          {capBar && (
            <>
              <span role="status" aria-live="polite">{capped ? `Showing ${shownRows.length} of ${sorted.length}` : `Showing all ${sorted.length}`}</span>
              <button
                type="button" data-ak-grid-cap="" onClick={toggleCap} aria-expanded={!capped}
                style={{ border: 0, background: 'transparent', padding: 0, font: 'inherit', fontSize: 'var(--font-size-dense, 13px)', fontWeight: 600, color: 'var(--text-link, #0079a8)', cursor: 'pointer' }}
              >
                {capped ? capLabel('more') : capLabel('less')}
              </button>
            </>
          )}
          {footer != null && <div style={{ marginLeft: capBar ? 'auto' : undefined, minWidth: 0, flex: capBar ? undefined : '1 1 auto' }}>{footer}</div>}
        </div>
      )}

      {hasActions && (
        <Menu
          open={!!menuRow && menuItems.length > 0}
          items={menuItems}
          onClose={closeRowMenu}
          anchor={menuRow ? rowMenu.anchor : null}
          align="end"
          label={menuRow ? actionsName(menuRow) : 'Actions'}
          autoFocus
          {...{ [rowMenuAttr]: '' }}
        />
      )}

      {statusBar && (
        <div role="status" aria-live="polite" style={{ display: 'flex', gap: 18, padding: '6px 12px', borderTop: `1px solid ${B}`, background: 'var(--surface-secondary, #f8f9fa)', fontSize: 12.5, color: 'var(--text-data, #495057)' }}>
          <span>Rows: <strong>{sorted.length}</strong>{filtered.length !== rows.length ? ` of ${rows.length}` : ''}</span>
          {selected.size > 0 && <span>Selected: <strong>{selected.size}</strong></span>}
        </div>
      )}
    </div>
  );
}
