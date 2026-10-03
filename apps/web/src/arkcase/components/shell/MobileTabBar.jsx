import React from 'react';
import { NavigationIcon } from '../navigation/NavigationIcon.jsx';
import { countText, leftToBrowser } from '../navigation/nav-helpers.jsx';

/**
 * ArkCase MobileTabBar — the phone's primary navigation. Up to five 44px+
 * destinations sit in the thumb zone along the bottom edge: four modules the
 * role uses every day and, last, a More item that opens the rest in a
 * `MobileMoreSheet`. The current item wears a 56 × 30 pill in the 10% primary
 * tint and draws its icon Bold; counts ride the icon in the Badge's solid fill.
 * It is fixed by default and pads itself by the bottom safe-area inset.
 */
export function MobileTabBar({
  items = [], activeId, onSelect, label = 'Primary', position = 'fixed', zIndex = 1020, style, ...rest
}) {
  const fixed = position === 'fixed';
  return (
    <nav
      aria-label={label}
      data-ak-tab-bar=""
      style={{
        position: fixed ? 'fixed' : position, left: 0, right: 0, bottom: 0, zIndex,
        display: 'flex', boxSizing: 'border-box',
        minHeight: 'calc(var(--mobile-tab-bar-height, 56px) + env(safe-area-inset-bottom, 0px))',
        padding: '4px 4px env(safe-area-inset-bottom, 0px)',
        background: 'var(--surface-card, #ffffff)', borderTop: '1px solid var(--border-color, #dee2e6)',
        fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
        ...style,
      }}
      {...rest}
    >
      {items.map((item, i) => {
        const active = item.id === activeId;
        const count = item.count != null && item.count !== 0 && item.count !== '' ? countText(item.count) : null;
        const name = count ? `${item.label}, ${count} new` : item.label;
        const common = {
          'aria-current': active ? 'page' : undefined,
          'aria-label': item.ariaLabel || name,
          'data-ak-tab': item.id,
          onClick: (e) => {
            if (item.link != null && leftToBrowser(e)) return;
            if (item.link != null) e.preventDefault();
            if (onSelect) onSelect(item);
          },
          style: {
            flex: '1 1 0', minWidth: 0, minHeight: 48, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 3, padding: '2px 0', margin: 0,
            border: 0, background: 'transparent', borderRadius: 'var(--radius-lg, 8px)',
            textDecoration: 'none', cursor: 'pointer', fontFamily: 'inherit',
            WebkitTapHighlightColor: 'transparent',
          },
        };
        const body = (
          <React.Fragment>
            <span aria-hidden="true" style={{
              position: 'relative', width: 56, height: 30, display: 'grid', placeItems: 'center',
              borderRadius: 15, background: active ? 'var(--tint-primary-selected, rgba(0, 121, 168, 0.10))' : 'transparent',
              color: active ? 'var(--bs-primary, #0079a8)' : 'var(--icon-primary, #073652)',
            }}>
              <NavigationIcon icon={item.icon || 'bi-circle'} active={active} style={{ width: 22, height: 22, fontSize: 22 }} />
              {count && (
                <span style={{
                  position: 'absolute', top: -3, left: 33, minWidth: 20, height: 18, padding: '0 5px', boxSizing: 'border-box',
                  borderRadius: 9, boxShadow: '0 0 0 2px var(--surface-card, #ffffff)', textAlign: 'center',
                  background: item.countTone === 'danger' ? 'var(--bs-danger, #d83506)' : 'var(--bs-primary, #0079a8)',
                  color: 'var(--text-on-primary, #ffffff)',
                  font: '600 var(--font-size-label, 11px)/18px var(--font-data, "Source Code Pro", ui-monospace, monospace)',
                  fontVariantNumeric: 'tabular-nums',
                }}>{count}</span>
              )}
            </span>
            <span style={{
              maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontSize: 'var(--font-size-xs, 12px)', lineHeight: '16px', fontWeight: active ? 600 : 500,
              color: active ? 'var(--text-link-on-tint, #00688f)' : 'var(--text-secondary, #5a6268)',
            }}>{item.label}</span>
          </React.Fragment>
        );
        const key = item.id != null ? item.id : i;
        return item.link != null
          ? <a key={key} href={item.link} {...common}>{body}</a>
          : <button key={key} type="button" aria-haspopup={item.opensSheet ? 'dialog' : undefined} {...common}>{body}</button>;
      })}
    </nav>
  );
}
