import React from 'react';

const DENSITY = {
  comfortable: { pad: '10px 14px', gap: 10, title: 'var(--font-size-dense, 13px)', desc: 'var(--font-size-xs, 12px)', radius: 0 },
  compact: { pad: '6px', gap: 8, title: 'var(--font-size-dense, 13px)', desc: 'var(--font-size-label, 11px)', radius: 'var(--radius-sm, 4px)' },
};
const DATA = 'var(--font-data, "Source Code Pro", ui-monospace, monospace)';

/**
 * ArkCase LinkRow — a full-width row that runs or opens something: a saved or recent
 * search, a starter ("Browse by record type"), a work queue. Left to right: an optional
 * glyph, the title over an optional description, an optional count in the data face (over
 * a `countLabel` such as "matches" when given), an optional chevron, and optional trailing
 * `actions` (IconButtons) that sit beside the row's button, never inside it.
 *
 * `comfortable` rows (10px × 14px) carry a list-divider hairline and fill a card edge to
 * edge; `compact` rows (6px, rounded) sit in a popover or a padded list. A title with a
 * description reads as a link (600 weight, link ink); a bare title reads as body text.
 * `rail` adds the 3px `list-rail` mark to a selected row, as `SelectableRow` draws it — the
 * current row of a picker list.
 */
export function LinkRow({
  icon, iconTone = 'link', title, description, count, countLabel, chevron = false, actions,
  onSelect, href, density = 'comfortable', divider, tone, selected = false, rail = false, ariaLabel, style, ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const d = DENSITY[density] || DENSITY.comfortable;
  const rule = divider !== undefined ? divider : density === 'comfortable';
  const hasDesc = description != null && description !== '';
  const titleTone = tone || (hasDesc ? 'link' : 'body');
  const hasCount = count != null && count !== '';
  const stacked = hasCount && countLabel != null && countLabel !== '';

  const inner = (
    <React.Fragment>
      {icon && (
        <i aria-hidden="true" className={'bi ' + icon} data-link-row-icon="" style={{
          flex: 'none', fontSize: density === 'compact' ? 'var(--icon-sm, 14px)' : 'var(--icon-md, 16px)',
          color: iconTone === 'muted' ? 'var(--text-secondary, #5a6268)' : 'var(--text-link, #0079a8)',
        }} />
      )}
      <span style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: hasDesc ? (density === 'compact' ? 2 : 3) : 0 }}>
        <span data-link-row-title="" style={{
          fontSize: d.title, lineHeight: 1.35,
          fontWeight: titleTone === 'link' ? (density === 'compact' ? 500 : 600) : 400,
          color: titleTone === 'link' ? 'var(--text-link, #0079a8)' : hover ? 'var(--text-link-hover, #005a7d)' : 'var(--text-body, #212529)',
          textDecoration: titleTone === 'link' && hover ? 'underline' : 'none',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: density === 'compact' ? 'nowrap' : undefined,
        }}>{title}</span>
        {hasDesc && (
          <span data-link-row-description="" style={{
            fontSize: d.desc, lineHeight: 1.45, color: 'var(--text-secondary, #5a6268)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: density === 'compact' ? 'nowrap' : undefined,
          }}>{description}</span>
        )}
      </span>
      {hasCount && (
        stacked ? (
          <span data-link-row-count="" style={{ flex: 'none', textAlign: 'right', lineHeight: 1.2 }}>
            <span style={{ display: 'block', fontFamily: DATA, fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)', fontSize: 18, fontWeight: 600, color: 'var(--text-body, #212529)' }}>{count}</span>
            <span style={{ display: 'block', fontSize: 'var(--font-size-label, 11px)', color: 'var(--text-secondary, #5a6268)' }}>{countLabel}</span>
          </span>
        ) : (
          <span data-link-row-count="" style={{ flex: 'none', fontFamily: DATA, fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)', fontSize: 'var(--font-size-sm, 14px)', fontWeight: 600, color: 'var(--text-link-hover, #005a7d)' }}>{count}</span>
        )
      )}
      {chevron && (
        <i aria-hidden="true" className="bi bi-chevron-right" data-link-row-chevron="" style={{ flex: 'none', fontSize: 'var(--icon-xs, 12px)', color: 'var(--text-secondary, #5a6268)' }} />
      )}
    </React.Fragment>
  );

  const control = {
    flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: d.gap,
    padding: actions ? (density === 'compact' ? d.pad : '0') : d.pad,
    margin: 0, border: 0, background: 'transparent', font: 'inherit', textAlign: 'left',
    color: 'inherit', textDecoration: 'none', cursor: 'pointer', borderRadius: d.radius,
  };
  const hoverProps = { onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) };
  const main = href
    ? <a href={href} onClick={onSelect} data-link-row-control="" aria-label={ariaLabel} aria-current={selected ? 'true' : undefined} style={control}>{inner}</a>
    : <button type="button" onClick={onSelect} data-link-row-control="" aria-label={ariaLabel} aria-current={selected ? 'true' : undefined} style={control}>{inner}</button>;

  return (
    <div
      data-link-row={density}
      {...hoverProps}
      style={{
        display: 'flex', alignItems: 'center', gap: actions ? (density === 'compact' ? 2 : 12) : 0,
        padding: actions && density !== 'compact' ? '11px 12px 11px 14px' : 0,
        borderBottom: rule ? '1px solid var(--list-divider, #e9ecef)' : undefined,
        borderRadius: d.radius,
        background: selected ? 'var(--tint-primary-selected, rgba(0,121,168,.10))' : hover ? 'var(--tint-primary-hover, rgba(0,121,168,.05))' : 'transparent',
        transition: 'background-color .15s ease',
        minWidth: 0,
        boxShadow: rail && selected ? 'inset 3px 0 0 var(--list-rail, #0079a8)' : undefined,
        ...style,
      }}
      {...rest}
    >
      {main}
      {actions != null && actions !== false && (
        <span data-link-row-actions="" style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 2 }}>{actions}</span>
      )}
    </div>
  );
}
