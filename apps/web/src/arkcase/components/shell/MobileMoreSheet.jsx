import React from 'react';
import { BottomSheet } from '../overlays/BottomSheet.jsx';
import { NavigationIcon } from '../navigation/NavigationIcon.jsx';
import { countText, leftToBrowser } from '../navigation/nav-helpers.jsx';

const GROUP_LABEL = {
  fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)', lineHeight: '16px',
  fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, letterSpacing: 'var(--letter-spacing-wide, 0.025em)',
  textTransform: 'uppercase', color: 'var(--text-secondary, #5a6268)', padding: '16px 0 10px',
};

/**
 * ArkCase MobileMoreSheet — everything the tab bar has no room for. The More
 * tab opens it as a `BottomSheet`: the account row first, then every other
 * module as a 4-column grid of tiles grouped exactly as the desktop navigation
 * groups them. It takes the same `NavItem`s as `SideNav` and `MobileNavDrawer`,
 * so a host passes its module list minus the tab-bar destinations. Choosing a
 * tile calls `onSelect` and closes the sheet.
 */
export function MobileMoreSheet({
  open = false, onClose, items = [], activeLink, onSelect, account, footer, title, label = 'More', returnFocusSelector, ...rest
}) {
  const groups = [];
  items.forEach((item) => {
    const name = item.group || '';
    let g = groups.find((x) => x.name === name);
    if (!g) { g = { name, items: [] }; groups.push(g); }
    g.items.push(item);
  });
  return (
    <BottomSheet open={open} onClose={onClose} title={title} label={label} footer={footer} returnFocusSelector={returnFocusSelector} data-ak-more-sheet="" {...rest}>
      {account != null && <div style={{ borderBottom: '1px solid var(--list-divider, #e9ecef)', paddingBottom: 8 }}>{account}</div>}
      {groups.map((g, gi) => (
        <section key={g.name || gi} aria-label={g.name || undefined}>
          {g.name && <h3 style={{ margin: 0, ...GROUP_LABEL }}>{g.name}</h3>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '14px 8px', paddingTop: g.name ? 0 : 12 }}>
            {g.items.map((item, i) => {
              const active = item.link != null && item.link === activeLink;
              const count = item.count != null && item.count !== 0 ? countText(item.count) : null;
              const tile = (
                <React.Fragment>
                  <span aria-hidden="true" style={{
                    position: 'relative', width: 52, height: 44, display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-md, 5px)',
                    background: active ? 'var(--tint-primary-selected, rgba(0, 121, 168, 0.10))' : 'var(--surface-navy-subtle, #eaf1f6)',
                    color: active ? 'var(--bs-primary, #0079a8)' : 'var(--icon-primary, #073652)',
                  }}>
                    <NavigationIcon icon={item.icon || 'bi-circle'} active={active} style={{ width: 22, height: 22, fontSize: 22 }} />
                    {count && <span style={{ position: 'absolute', top: -6, right: -8, minWidth: 18, height: 18, padding: '0 5px', boxSizing: 'border-box', borderRadius: 9, boxShadow: '0 0 0 2px var(--surface-card, #ffffff)', background: item.countTone === 'danger' ? 'var(--bs-danger, #d83506)' : 'var(--bs-primary, #0079a8)', color: 'var(--text-on-primary, #ffffff)', font: '600 var(--font-size-label, 11px)/18px var(--font-data, "Source Code Pro", ui-monospace, monospace)', textAlign: 'center' }}>{count}</span>}
                  </span>
                  <span style={{ fontSize: 'var(--font-size-xs, 12px)', lineHeight: '15px', fontWeight: active ? 600 : 500, textAlign: 'center', color: active ? 'var(--text-link-on-tint, #00688f)' : 'var(--text-body, #212529)', overflowWrap: 'anywhere' }}>{item.label}</span>
                  {item.locked && <i aria-hidden="true" className="bi bi-lock" style={{ fontSize: 'var(--icon-xs, 12px)', color: 'var(--text-secondary, #5a6268)' }} />}
                </React.Fragment>
              );
              const key = item.id != null ? item.id : item.link || i;
              const props = {
                'aria-current': active ? 'page' : undefined,
                'aria-label': count ? `${item.label}, ${count}` : undefined,
                onClick: (e) => {
                  if (item.link != null && leftToBrowser(e)) return;
                  if (item.link != null) e.preventDefault();
                  if (onSelect) onSelect(item);
                  if (onClose) onClose();
                },
                style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minHeight: 72, padding: '2px 0', border: 0, background: 'transparent', textDecoration: 'none', cursor: 'pointer', fontFamily: 'inherit', borderRadius: 'var(--radius-md, 5px)' },
              };
              return item.link != null ? <a key={key} href={item.link} {...props}>{tile}</a> : <button key={key} type="button" {...props}>{tile}</button>;
            })}
          </div>
        </section>
      ))}
    </BottomSheet>
  );
}
