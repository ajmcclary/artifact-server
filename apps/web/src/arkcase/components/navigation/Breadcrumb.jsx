import React from 'react';

/**
 * ArkCase Breadcrumb — module → record → section, the trail the record screens
 * carry above the title. The last item is the current place and is not a link.
 * An item with `mono` draws its label in the data face, for a crumb that is a code.
 *
 * An item with `node` is a crumb the host renders itself — a menu trigger such as
 * `CrumbMenu`, or a heading — and the trail only places it and draws the separators.
 * `variant="controls"` is the toolbar trail of such crumbs: a 12px secondary chevron
 * between controls that keep their own height, crumbs that do not shrink unless marked
 * `shrink`, so the one that does truncates first.
 */
export function Breadcrumb({ items = [], label = 'Breadcrumb', variant = 'text', style, ...rest }) {
  const controls = variant === 'controls';
  const shown = items.filter((it) => it != null && it !== false);
  const separator = controls
    ? <i className="bi bi-chevron-right" aria-hidden="true" data-icon-tone="current" style={{ flex: 'none', fontSize: 12, color: 'var(--text-secondary, #5a6268)' }} />
    : <i className="bi bi-chevron-right" aria-hidden="true" style={{ fontSize: 9, color: 'var(--border-color-strong, #ced4da)' }} />;
  return (
    <nav aria-label={label} style={{ minWidth: 0, ...(controls ? { flex: '0 1 auto' } : null), ...style }} {...rest}>
      <ol style={{ display: 'flex', alignItems: 'center', gap: controls ? 2 : 6, margin: 0, padding: 0, listStyle: 'none', minWidth: 0, fontSize: 'var(--font-size-xs, 12px)' }}>
        {shown.map((it, i) => {
          const last = i === shown.length - 1;
          const item = (
            <li key={i} style={{ display: 'flex', alignItems: 'center', gap: controls ? 2 : 6, minWidth: 0, flex: controls ? (it.shrink ? '0 1 auto' : 'none') : undefined }}>
              {!controls && i > 0 && separator}
              {crumb(it, last)}
              {controls && !last && separator}
            </li>
          );
          return item;
        })}
      </ol>
    </nav>
  );
}

function crumb(it, last) {
  if (it && it.node !== undefined) return it.node;
  const label = it.label ?? it;
  /* A crumb that names a record by its code (a path, a run id) draws in the data face. */
  const face = it && it.mono ? { fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)', fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)' } : null;
  if (last || (!it.onClick && !it.href)) {
    return <span aria-current={last ? 'page' : undefined} style={{ fontWeight: last ? 600 : 400, color: last ? 'var(--text-body, #212529)' : 'var(--text-secondary, #5a6268)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...face }}>{label}</span>;
  }
  return (
    <a
      href={it.href || '#'}
      onClick={(e) => { if (it.onClick) { e.preventDefault(); it.onClick(); } }}
      style={{ color: 'var(--text-link-on-tint, #00688f)', textDecoration: 'none', whiteSpace: 'nowrap', ...face }}
    >{label}</a>
  );
}
