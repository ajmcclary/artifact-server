import React from 'react';

/**
 * ArkCase RowSummary — the two-line body of a list row: the title (14px/600, wrapping pretty)
 * with an optional `meta` in the data face at its end ("v7", an Archived pill), then a second
 * line of `detail` — count badges and a secondary fact ("04/14/2026", "4 artifacts · 04/14").
 * It is the body a `SelectableRow` leaves to its caller, so list rails stop rebuilding it.
 */
export function RowSummary({ title, meta, detail, style, ...rest }) {
  const items = (Array.isArray(detail) ? detail : [detail]).filter((d) => d != null && d !== false && d !== '');
  const metaNode = meta == null || meta === false ? null : (typeof meta === 'string' || typeof meta === 'number')
    ? <span style={{ flex: 'none', fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)', fontSize: 'var(--font-size-label, 11px)', color: 'var(--text-secondary, #5a6268)' }}>{meta}</span>
    : <span style={{ flex: 'none', display: 'inline-flex' }}>{meta}</span>;
  return (
    <div data-row-summary="" style={{ minWidth: 0, ...style }} {...rest}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: 'var(--font-size-sm, 14px)', fontWeight: 600, lineHeight: 1.35, textWrap: 'pretty', color: 'var(--text-body, #212529)' }}>{title}</span>
        {metaNode}
      </div>
      {items.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 5 }}>
          {items.map((d, i) => (typeof d === 'string' || typeof d === 'number')
            ? <span key={i} style={{ fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5a6268)' }}>{d}</span>
            : <React.Fragment key={i}>{d}</React.Fragment>)}
        </div>
      )}
    </div>
  );
}
