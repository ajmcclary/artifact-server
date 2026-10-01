import React from 'react';

export function GridCheck({ checked, onChange, label }) {
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      tabIndex={-1}
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      style={{ display: 'inline-flex', width: 16, height: 16, cursor: 'pointer', borderRadius: 3, border: `1px solid ${checked ? 'var(--bs-primary, #0079a8)' : 'var(--border-color-strong, #ced4da)'}`, background: checked ? 'var(--bs-primary, #0079a8)' : 'var(--bs-white, #fff)', alignItems: 'center', justifyContent: 'center', verticalAlign: 'middle' }}
    >
      {checked && <i className="bi bi-check" aria-hidden="true" style={{ color: 'var(--text-on-primary, #fff)', fontSize: 14, lineHeight: 1 }} />}
    </span>
  );
}

/* The single-selection mark: the same 16px footprint as the checkbox, drawn round, with an
   8px primary dot when chosen. Like the checkbox it takes no tab stop of its own; the grid's
   roving focus sits on the cell and Enter or Space on the cell chooses the row. */
export function GridRadio({ checked, onChange, label }) {
  return (
    <span
      role="radio"
      aria-checked={checked}
      aria-label={label}
      tabIndex={-1}
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      style={{ display: 'inline-flex', width: 16, height: 16, boxSizing: 'border-box', cursor: 'pointer', borderRadius: '50%', border: `1px solid ${checked ? 'var(--bs-primary, #0079a8)' : 'var(--border-color-strong, #ced4da)'}`, background: 'var(--bs-white, #fff)', alignItems: 'center', justifyContent: 'center', verticalAlign: 'middle' }}
    >
      {checked && <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--bs-primary, #0079a8)' }} />}
    </span>
  );
}

export function rowKey(row, i) { return row.id != null ? row.id : i; }
export function fmt(v) { return v == null ? '' : String(v); }
/* The sticky inset of a pinned column. A left-pinned column sits after the checkbox column and
   every left-pinned column before it; a right-pinned column sits before `rightBase` (the row
   actions column, when there is one) and every right-pinned column after it. */
export function stickyOffset(ordered, col, side, hasCheckbox, rightBase = 0) {
  const list = side === 'left' ? ordered.filter((c) => c.pinned === 'left') : ordered.filter((c) => c.pinned === 'right').reverse();
  let offset = side === 'left' ? (hasCheckbox ? 44 : 0) : rightBase;
  for (const c of list) {
    if (c.field === col.field) return offset;
    offset += c.width || 150;
  }
  /* v8 ignore next */
  return offset;
}
