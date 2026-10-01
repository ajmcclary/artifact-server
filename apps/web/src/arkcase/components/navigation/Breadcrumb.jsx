import React from 'react';

/**
 * ArkCase Breadcrumb — module → record → section, the trail the record screens
 * carry above the title. The last item is the current place and is not a link.
 * An item with `mono` draws its label in the data face, for a crumb that is a code.
 */
export function Breadcrumb({ items = [], style, ...rest }) {
  return (
    <nav aria-label="Breadcrumb" style={{ minWidth: 0, ...style }} {...rest}>
      <ol style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, padding: 0, listStyle: 'none', fontSize: 'var(--font-size-xs, 12px)' }}>
        {items.map((it, i) => {
          const last = i === items.length - 1;
          const label = it.label ?? it;
          /* A crumb that names a record by its code (a path, a run id) draws in the data face. */
          const face = it && it.mono ? { fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)', fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)' } : null;
          return (
            <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              {i > 0 && <i className="bi bi-chevron-right" aria-hidden="true" style={{ fontSize: 9, color: 'var(--border-color-strong, #ced4da)' }} />}
              {last || (!it.onClick && !it.href) ? (
                <span aria-current={last ? 'page' : undefined} style={{ fontWeight: last ? 600 : 400, color: last ? 'var(--text-body, #212529)' : 'var(--text-secondary, #5a6268)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...face }}>{label}</span>
              ) : (
                <a
                  href={it.href || '#'}
                  onClick={(e) => { if (it.onClick) { e.preventDefault(); it.onClick(); } }}
                  style={{ color: 'var(--text-link-on-tint, #00688f)', textDecoration: 'none', whiteSpace: 'nowrap', ...face }}
                >{label}</a>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
