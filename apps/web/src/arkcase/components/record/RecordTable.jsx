import { akStyleDocument } from '@/arkcase-style';
import React from 'react';
import { useElementSize } from '../utilities/element-size.jsx';

const TONES = {
  success:  { fg: 'var(--pill-success-fg, #15803d)', bg: 'rgba(0,181,50,.07)' },
  primary:  { fg: 'var(--text-link-hover, #005a7d)', bg: 'rgba(0,121,168,.07)' },
  warning:  { fg: 'var(--pill-warning-fg, #92400e)', bg: 'var(--pill-warning-bg, #fef3c7)' },
  danger:   { fg: 'var(--pill-danger-fg, #991b1b)', bg: 'var(--pill-danger-bg, #fee2e2)' },
  neutral:  { fg: 'var(--text-data, #495057)', bg: 'var(--surface-canvas, #f1f5f7)' },
};

const RECORD_TABLE_RAIL = 'inset 3px 0 0 var(--bs-primary, #0079a8)';

/* Whole-row tones: a wash across the row and a hairline in the same family under it — the
   audit ledger's denied event, a breached deadline. The ink stays the cell's own. */
const ROW_TONES = {
  danger:  { bg: 'var(--tint-danger-hover, rgba(216,53,6,.05))', rule: 'var(--pill-danger-bg, #fee2e2)' },
  warning: { bg: 'var(--pill-warning-bg, #fef3c7)', rule: 'var(--pill-warning-border, #ffd894)' },
  success: { bg: 'var(--pill-success-bg, #dcfce7)', rule: 'var(--pill-success-border, #a7e3ba)' },
  primary: { bg: 'var(--tint-primary-hover, rgba(0,121,168,.05))', rule: 'var(--tint-primary-selected, rgba(0,121,168,.10))' },
};
const RECORD_TABLE_HEADER_RULE_STRONG = '2px solid var(--text-navy, #073652)';

/* Hover, focus and link-hover need pseudo-classes, which inline styles cannot carry, so the
   three rules are injected once per document and scoped by data attributes. A selected row's
   inline wash outranks the hover rule, so a selected row keeps its 10%. */
function ensureRecordTableStyles() {
  if (typeof document === 'undefined' || akStyleDocument.getElementById('ak-record-table-css')) return;
  const s = akStyleDocument.createElement('style');
  s.id = 'ak-record-table-css';
  s.textContent =
    '[data-ak-record-table-row][data-stripe]{background:var(--surface-secondary, #f8f9fa)}' +
    '[data-ak-record-table-row][data-interactive]:hover{background:var(--tint-primary-hover, rgba(0,121,168,.05))}' +
    '[data-ak-record-table-row][data-interactive]:focus-visible{outline:var(--focus-outline, 2px solid #0079a8);outline-offset:-2px}' +
    '[data-ak-record-table-link]:hover{text-decoration:underline}' +
    /* A pinned first cell must be opaque or the scrolled columns show through it. With no
       inline wash of its own it takes the card, the stripe, or the hover wash over the card. */
    '[data-ak-record-table-sticky]{background:var(--surface-card, #fff)}' +
    '[data-ak-record-table-row][data-stripe]>[data-ak-record-table-sticky]{background:var(--surface-secondary, #f8f9fa)}' +
    '[data-ak-record-table-row][data-interactive]:hover>[data-ak-record-table-sticky]{background:linear-gradient(var(--tint-primary-hover, rgba(0,121,168,.05)), var(--tint-primary-hover, rgba(0,121,168,.05))), var(--surface-card, #fff)}';
  akStyleDocument.head.appendChild(s);
}

/* A cell `{ onClick }` or `{ href }` is a link: a native anchor for a real destination, a
   link-styled native button for an action. Either inherits the cell's face, so `mono` holds. */
function RecordTableLink({ cell, children }) {
  const look = {
    padding: 0, margin: 0, border: 0, background: 'none', font: 'inherit', textAlign: 'inherit',
    color: 'var(--text-link-on-tint, #00688f)', textDecoration: 'none', cursor: 'pointer',
  };
  if (cell.href) {
    return (
      <a href={cell.href} data-ak-record-table-link="" onClick={cell.onClick} style={look}>{children}</a>
    );
  }
  return (
    <button type="button" data-ak-record-table-link="" onClick={cell.onClick} style={look}>{children}</button>
  );
}

function recordTableFromControl(e) {
  const hit = e.target && e.target.closest ? e.target.closest('a, button, input, select, textarea, label') : null;
  return !!hit && hit !== e.currentTarget && e.currentTarget.contains(hit);
}

/**
 * ArkCase RecordTable — the dense record table. Micro caps on the secondary
 * surface, 13px rows on the light hairline, coded values in the data font, and
 * an optional footer note. Harvested from the ExtractionKit console's ledgers
 * and normalized onto the sanctioned type steps (11px caps, 13px rows) — the
 * app was setting 10px and 12.5px inline.
 *
 * The grid carries ARIA table semantics (table, rowgroup, row, columnheader, cell); each
 * row is a subgrid of the column template, so a row can take a wash, a focus ring and a
 * detail row beneath it. With `onRowSelect` the rows become selectable: click, Enter and
 * Space select, ArrowUp and ArrowDown move focus, the selected row takes the 10% primary
 * wash and a 3px rail, and `renderDetail` opens a full-width row under it.
 *
 * `stackBelow` is the narrow form: while the table's own width is under that many px, each
 * row becomes a stacked block — every labelled column a label/value pair, the unlabelled
 * (action) columns in a row under them — so a ledger reads in a phone column or a narrow
 * panel without a horizontal scroll.
 */
export function RecordTable({
  columns = [], rows = [], footer, ariaLabel, stickyHeader = false, maxHeight, minWidth, empty,
  rowKey, selectedKey, onRowSelect, rowProps, renderDetail, style,
  striped = false, rowTone, totals, headerRule = 'default', stickyFirstColumn = false, stackBelow, ...rest
}) {
  const baseId = React.useId();
  const rootRef = React.useRef(null);
  const size = useElementSize(rootRef);
  const stack = stackBelow != null && size.width > 0 && size.width < stackBelow;
  const selectable = typeof onRowSelect === 'function';
  const strongHead = headerRule === 'strong';
  const pinFirst = !!stickyFirstColumn;
  const interactiveStyles = pinFirst || striped || selectable || rows.some((row) => normalize(row, columns).some((cell) => cell.onClick || cell.href));
  React.useEffect(() => { if (interactiveStyles) ensureRecordTableStyles(); }, [interactiveStyles]);

  const template = columns.map((c) => c.width || 'minmax(0, 1fr)').join(' ');
  const keyOf = (row, i) => (rowKey ? rowKey(row, i) : i);
  const keys = rows.map((row, i) => keyOf(row, i));
  const selectedIndex = selectedKey == null ? -1 : keys.indexOf(selectedKey);
  const rovingIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const detailFor = (i) => (selectable && renderDetail && i === selectedIndex ? renderDetail(rows[i], i) : null);
  const subgrid = { display: 'grid', gridColumn: '1 / -1', gridTemplateColumns: 'subgrid' };
  /* `stickyFirstColumn` pins column one to the left edge of the horizontal scroll box (the
     phone ledgers). An inline wash is laid over the card so the pinned cell stays opaque. */
  const opaque = (wash) => (wash ? 'linear-gradient(' + wash + ', ' + wash + '), var(--surface-card, #fff)' : undefined);
  const pinned = (c, z) => (pinFirst && c === 0 ? { position: 'sticky', left: 0, zIndex: z } : null);
  /* A read-only ledger is a table. Selectable rows are focusable, so the ledger becomes a grid
     (rows may carry aria-selected there), and a treegrid when rows expand into a detail row —
     the one role whose rows may carry aria-expanded. */
  const expands = selectable && typeof renderDetail === 'function';
  const tableRole = expands ? 'treegrid' : selectable ? 'grid' : 'table';
  const cellRole = selectable ? 'gridcell' : 'cell';

  const select = (row, i) => { if (selectable) onRowSelect(row, i); };
  const onRowKey = (e, row, i) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(row, i); return; }
    const peers = Array.from(e.currentTarget.parentElement.querySelectorAll(':scope > [data-ak-record-table-row]'));
    const at = peers.indexOf(e.currentTarget);
    const next = e.key === 'ArrowDown' ? peers[at + 1] : e.key === 'ArrowUp' ? peers[at - 1]
      : e.key === 'Home' ? peers[0] : e.key === 'End' ? peers[peers.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    next.focus();
  };

  const body = [];
  rows.forEach((row, r) => {
    const cells = normalize(row, columns);
    const key = keys[r];
    const selected = selectable && r === selectedIndex;
    const detail = detailFor(r);
    const detailId = baseId + '-detail-' + r;
    const lastRow = r === rows.length - 1 && detail == null && totals == null;
    const extra = rowProps ? rowProps(row, r) || {} : {};
    const toned = rowTone ? ROW_TONES[rowTone(row, r)] || null : null;
    /* The stripe is a stylesheet rule, not an inline wash, so the hover rule still reaches a
       striped row; a tone or the selection is inline and outranks both. */
    const stripe = striped && r % 2 === 1 && !toned;
    body.push(
      <div
        key={'row-' + key}
        {...extra}
        role="row"
        data-ak-record-table-row=""
        data-interactive={selectable ? '' : undefined}
        data-selected={selectable ? (selected ? 'true' : 'false') : undefined}
        data-stripe={stripe ? '' : undefined}
        data-row-tone={toned ? rowTone(row, r) : undefined}
        aria-selected={selectable ? selected : undefined}
        aria-expanded={expands ? selected : undefined}
        aria-level={expands ? 1 : undefined}
        aria-controls={detail != null ? detailId : undefined}
        tabIndex={selectable ? (r === rovingIndex ? 0 : -1) : undefined}
        onClick={selectable ? (e) => { if (!recordTableFromControl(e)) select(row, r); } : extra.onClick}
        onKeyDown={selectable ? (e) => onRowKey(e, row, r) : extra.onKeyDown}
        style={{
          ...subgrid,
          background: selected ? 'var(--tint-primary-selected, rgba(0,121,168,.10))' : toned ? toned.bg : undefined,
          cursor: selectable ? 'pointer' : undefined,
          ...extra.style,
        }}
      >
        {cells.map((cell, c) => {
          const col = columns[c] || {};
          const tone = cell.tone ? TONES[cell.tone] : null;
          const mono = cell.mono != null ? cell.mono : col.mono;
          const link = cell.onClick || cell.href;
          const value = cell.value == null
            ? <span style={{ color: 'var(--text-secondary, #5a6268)', fontStyle: 'italic' }}>&mdash;</span>
            : cell.value;
          /* A tone wash is translucent; on a selectable row it sits on the card rather than on
             the row's hover or selected wash, so its ink keeps its contrast. */
          const toneGround = tone && selectable ? 'linear-gradient(' + tone.bg + ', ' + tone.bg + '), var(--surface-card, #fff)' : tone ? tone.bg : undefined;
          const pin = pinned(c, 1);
          const rowWash = selected ? 'var(--tint-primary-selected, rgba(0,121,168,.10))' : toned ? toned.bg : null;
          const ground = pin && !toneGround && rowWash ? opaque(rowWash) : pin && tone ? opaque(tone.bg) : toneGround;
          return (
            <div
              key={c}
              role={cellRole}
              data-ak-record-table-sticky={pin ? '' : undefined}
              style={{
                ...pin,
                padding: '7px 12px',
                borderBottom: lastRow ? 'none' : '1px solid ' + (toned ? toned.rule : 'var(--bs-light, #f1f5f7)'),
                fontFamily: mono ? 'var(--font-data, "Source Code Pro", ui-monospace, monospace)' : undefined,
                fontSize: 'var(--font-size-dense, 13px)',
                fontWeight: cell.strong ? 600 : 400,
                lineHeight: 1.45,
                textAlign: col.align || 'left',
                color: tone ? tone.fg : cell.muted ? 'var(--text-secondary, #5a6268)' : 'var(--text-data, #495057)',
                background: ground,
                fontStyle: cell.absent ? 'italic' : undefined,
                boxShadow: selected && c === 0 ? RECORD_TABLE_RAIL : undefined,
              }}
            >
              {link && cell.value != null ? <RecordTableLink cell={cell}>{value}</RecordTableLink> : value}
            </div>
          );
        })}
      </div>
    );
    if (detail != null) {
      body.push(
        <div key={'detail-' + key} role="row" aria-level={2} id={detailId} data-ak-record-table-detail="" style={subgrid}>
          <div
            role={cellRole}
            style={{
              gridColumn: '1 / -1', padding: 0, minWidth: 0,
              background: 'var(--surface-navy-subtle, #eaf1f6)',
              boxShadow: RECORD_TABLE_RAIL,
              borderBottom: r === rows.length - 1 ? 'none' : '1px solid var(--border-color-strong, #ced4da)',
              color: 'var(--text-body, #212529)',
              fontSize: 'var(--font-size-dense, 13px)',
            }}
          >
            {detail}
          </div>
        </div>
      );
    }
  });
  /* The totals row closes the ledger: its own row group after the body, a strong rule above,
     the secondary ground and semibold values, in the columns' faces. */
  const totalsRow = totals != null && (
    <div role="rowgroup" data-ak-record-table-totals="" style={subgrid}>
      <div role="row" style={subgrid}>
        {normalize(totals, columns).map((cell, c) => {
          const col = columns[c] || {};
          const tone = cell.tone ? TONES[cell.tone] : null;
          const mono = cell.mono != null ? cell.mono : col.mono;
          return (
            <div
              key={c}
              role={cellRole}
              style={{
                ...pinned(c, 1),
                padding: '7px 12px',
                borderTop: RECORD_TABLE_HEADER_RULE_STRONG,
                background: tone ? (pinFirst && c === 0 ? opaque(tone.bg) : tone.bg) : 'var(--surface-secondary, #f8f9fa)',
                fontFamily: mono ? 'var(--font-data, "Source Code Pro", ui-monospace, monospace)' : undefined,
                fontVariantNumeric: mono || col.align === 'right' ? 'var(--font-numeric-feature, tabular-nums)' : undefined,
                fontSize: 'var(--font-size-dense, 13px)',
                fontWeight: cell.strong === false ? 400 : 600,
                lineHeight: 1.45,
                textAlign: col.align || 'left',
                color: tone ? tone.fg : 'var(--text-body, #212529)',
              }}
            >
              {cell.value}
            </div>
          );
        })}
      </div>
    </div>
  );

  if (rows.length === 0 && empty != null) {
    body.push(
      <div key="empty" role="row" data-ak-record-table-empty="" style={subgrid}>
        <div role={cellRole} style={{ gridColumn: '1 / -1', padding: '14px 12px', fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.45, color: 'var(--text-secondary, #5a6268)' }}>{empty}</div>
      </div>
    );
  }

  const table = (
    <div role={tableRole} aria-label={ariaLabel} style={{ display: 'grid', gridTemplateColumns: template, minWidth }}>
      <div
        role="rowgroup"
        style={{ ...subgrid, position: stickyHeader ? 'sticky' : undefined, top: stickyHeader ? 0 : undefined, zIndex: stickyHeader ? 2 : undefined }}
      >
        <div role="row" style={subgrid}>
          {columns.map((c, i) => (
            <div key={i} role="columnheader" style={{ ...pinned(i, 3), padding: '7px 12px', background: strongHead ? 'var(--surface-card, #fff)' : 'var(--surface-secondary, #f8f9fa)', borderBottom: strongHead ? RECORD_TABLE_HEADER_RULE_STRONG : '1px solid var(--border-color, #dee2e6)', fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-secondary, #5a6268)', textAlign: c.align || 'left' }}>{c.label}</div>
          ))}
        </div>
      </div>
      <div role="rowgroup" style={subgrid}>{body}</div>
      {totalsRow}
    </div>
  );

  if (stack) {
    const labelled = columns.map((c, i) => ({ c, i })).filter(({ c }) => c.label != null && c.label !== '');
    const acts = columns.map((c, i) => ({ c, i })).filter(({ c }) => c.label == null || c.label === '');
    return (
      <div ref={rootRef} data-record-table-stacked="" style={style} {...rest}>
        <div role="list" aria-label={ariaLabel}>
          {rows.map((row, r) => {
            const cells = normalize(row, columns);
            return (
              <div key={'row-' + keys[r]} role="listitem" style={{ padding: '12px 14px', borderBottom: '1px solid var(--list-divider, #e9ecef)', display: 'flex', flexDirection: 'column', gap: 7 }}>
                {labelled.map(({ c, i }) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '104px minmax(0, 1fr)', gap: 10, alignItems: 'baseline' }}>
                    <span style={{ fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, letterSpacing: '0.025em', textTransform: 'uppercase', color: 'var(--text-secondary, #5a6268)' }}>{c.label}</span>
                    <StackedValue cell={cells[i] || { value: null }} col={c} />
                  </div>
                ))}
                {acts.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 2 }}>
                    {acts.map(({ c, i }) => <StackedValue key={i} cell={cells[i] || { value: null }} col={c} bare />)}
                  </div>
                )}
              </div>
            );
          })}
          {rows.length === 0 && empty != null && (
            <div role="listitem" style={{ padding: '14px 12px', fontSize: 'var(--font-size-dense, 13px)', color: 'var(--text-secondary, #5a6268)' }}>{empty}</div>
          )}
        </div>
        {footer && (
          <div style={{ padding: '10px 14px', background: 'var(--surface-secondary, #f8f9fa)', fontSize: 'var(--font-size-xs, 12px)', lineHeight: 1.5, color: 'var(--text-data, #495057)' }}>{footer}</div>
        )}
      </div>
    );
  }

  const scrolls = maxHeight != null || minWidth != null;
  return (
    <div ref={rootRef} style={style} {...rest}>
      {scrolls ? (
        <div
          data-ak-record-table-scroll=""
          tabIndex={selectable ? undefined : 0}
          style={{ minWidth: 0, overflowX: 'auto', overflowY: maxHeight != null ? 'auto' : undefined, maxHeight }}
        >
          {table}
        </div>
      ) : table}
      {footer && (
        <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border-color, #dee2e6)', background: 'var(--surface-secondary, #f8f9fa)', fontSize: 'var(--font-size-xs, 12px)', lineHeight: 1.5, color: 'var(--text-data, #495057)' }}>{footer}</div>
      )}
    </div>
  );
}

/* One value of a stacked row, in the cell's own face and tone. An action cell (`bare`) drops
   the absent dash, so an empty action slot leaves no mark. */
function StackedValue({ cell, col, bare = false }) {
  const tone = cell.tone ? TONES[cell.tone] : null;
  const mono = cell.mono != null ? cell.mono : col.mono;
  if (cell.value == null) return bare ? null : <span style={{ color: 'var(--text-secondary, #5a6268)', fontStyle: 'italic' }}>&mdash;</span>;
  const link = cell.onClick || cell.href;
  return (
    <span style={{
      minWidth: 0, overflowWrap: 'anywhere', lineHeight: 1.45,
      fontFamily: mono ? 'var(--font-data, "Source Code Pro", ui-monospace, monospace)' : undefined,
      fontSize: 'var(--font-size-dense, 13px)',
      fontWeight: cell.strong ? 600 : 400,
      fontStyle: cell.absent ? 'italic' : undefined,
      color: tone ? tone.fg : cell.muted ? 'var(--text-secondary, #5a6268)' : 'var(--text-data, #495057)',
    }}>
      {link ? <RecordTableLink cell={cell}>{cell.value}</RecordTableLink> : cell.value}
    </span>
  );
}

function normalize(row, columns) {
  const cells = Array.isArray(row) ? row : columns.map((c) => (row || {})[c.key]);
  return cells.map((cell) => (cell && typeof cell === 'object' && !React.isValidElement(cell) ? cell : { value: cell }));
}
