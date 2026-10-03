import React from 'react';
import { displayProfileContext } from './DisplayProfile.jsx';
import { matchesMedia } from '../navigation/nav-helpers.jsx';
import { useEscapeLayer } from '../overlays/overlay-layer.jsx';

const LONG_PRESS_MS = 450;
const ICON_BUTTON = {
  flex: 'none', width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: 0, borderRadius: 22, background: 'transparent', color: 'var(--text-on-navy, #ffffff)', padding: 0, cursor: 'pointer',
};

/* Reveals the bar's title once the page's own large title has scrolled under it. A controlled
   `titleVisible` wins; otherwise the window (or `scrollTarget`) is watched, passively. */
function useRevealTitle(controlled, revealAfter, scrollTarget) {
  const [scrolled, setScrolled] = React.useState(false);
  React.useEffect(() => {
    if (controlled != null || typeof window === 'undefined') return undefined;
    const target = scrollTarget || window;
    const read = () => {
      const y = target === window ? window.scrollY || document.documentElement.scrollTop : target.scrollTop;
      setScrolled(y > revealAfter);
    };
    read();
    target.addEventListener('scroll', read, { passive: true });
    return () => target.removeEventListener('scroll', read);
  }, [controlled, revealAfter, scrollTarget]);
  return controlled != null ? !!controlled : scrolled;
}

function HistoryMenu({ entries, label, onSelect, onClose, anchorRef }) {
  const ref = React.useRef(null);
  const handleEscape = useEscapeLayer(true, ref, onClose);
  React.useEffect(() => {
    const first = ref.current && ref.current.querySelector('[role="menuitem"]:not([aria-disabled="true"])');
    if (first) first.focus();
    const away = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !(anchorRef.current && anchorRef.current.contains(e.target))) onClose();
    };
    document.addEventListener('pointerdown', away);
    return () => {
      document.removeEventListener('pointerdown', away);
      if (anchorRef.current) anchorRef.current.focus({ preventScroll: true });
    };
  }, []);
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { handleEscape(e); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = [...ref.current.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')];
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  };
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-ak-history-menu=""
      onKeyDown={onKeyDown}
      style={{
        position: 'absolute', top: 'calc(100% - 2px)', left: 8, width: 'min(300px, calc(100vw - 16px))', zIndex: 1,
        background: 'var(--surface-card, #ffffff)', color: 'var(--text-body, #212529)', borderRadius: 'var(--radius-lg, 8px)',
        boxShadow: 'var(--shadow-lg, 0 4px 8px rgba(0,0,0,.06), 0 12px 32px rgba(0,0,0,.14))', overflow: 'hidden',
      }}
    >
      <div style={{ padding: '12px 16px 6px', fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, letterSpacing: 'var(--letter-spacing-wide, .06em)', textTransform: 'uppercase', color: 'var(--text-secondary, #5a6268)' }}>{label}</div>
      {entries.map((entry, i) => {
        const current = i === entries.length - 1 && entry.current !== false;
        return (
          <button
            key={entry.id != null ? entry.id : i}
            type="button"
            role="menuitem"
            aria-current={current ? 'page' : undefined}
            aria-disabled={current ? 'true' : undefined}
            onClick={() => { if (current) { onClose(); return; } onSelect && onSelect(entry, i); onClose(); }}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 12, minHeight: 52, padding: '6px 16px', margin: 0,
              border: 0, borderTop: '1px solid var(--list-divider, #e9ecef)', background: 'transparent', textAlign: 'left',
              fontFamily: 'inherit', cursor: current ? 'default' : 'pointer', color: 'inherit',
            }}
          >
            {entry.icon && <i aria-hidden="true" className={'bi ' + entry.icon} style={{ flex: 'none', fontSize: 'var(--icon-lg, 20px)', color: current ? 'var(--bs-primary, #0079a8)' : 'var(--icon-primary, #073652)' }} />}
            <span style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: current ? 'var(--text-link, #0079a8)' : 'var(--text-strong, #111827)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.label}</span>
              {(current || entry.sub) && <span style={{ fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5a6268)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current ? 'You are here' : entry.sub}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * ArkCase MobileAppBar — the phone's 52px navy bar. At a tab's root it carries
 * the brand (a `BrandLock` home control) and one or two actions; the page's
 * large serif title scrolls up under it and reappears here. Below the root it
 * leads with ‹ and the parent's name; the current screen's name (and a record's
 * id in the data face) fades in once the record header has scrolled away.
 * Pressing and holding ‹ Back, a right-click, or Alt+↑ opens the whole stack
 * as a menu, which replaces the breadcrumb on phones.
 */
export function MobileAppBar({
  title, subtitle, brand, actions, backLabel, onBack, history, onHistorySelect, historyLabel = 'Go back to',
  titleVisible, revealAfter = 40, scrollTarget, position = 'fixed', zIndex = 1020, style, ...rest
}) {
  const dp = React.useContext(displayProfileContext());
  const reduceMotion = dp ? dp.reduceMotion : matchesMedia('(prefers-reduced-motion: reduce)');
  const showTitle = useRevealTitle(titleVisible, revealAfter, scrollTarget);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const backRef = React.useRef(null);
  const timer = React.useRef(null);
  const pressed = React.useRef(false);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const pushed = typeof onBack === 'function';
  const hasHistory = Array.isArray(history) && history.length > 1;
  const fade = reduceMotion ? 'none' : 'opacity .2s ease';

  const openMenu = () => { if (hasHistory) setMenuOpen(true); };
  const backHandlers = pushed ? {
    onPointerDown: (e) => {
      if (!hasHistory || (e.pointerType === 'mouse' && e.button !== 0)) return;
      pressed.current = false;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { pressed.current = true; openMenu(); }, LONG_PRESS_MS);
    },
    onPointerUp: () => clearTimeout(timer.current),
    onPointerLeave: () => clearTimeout(timer.current),
    onPointerCancel: () => clearTimeout(timer.current),
    onContextMenu: (e) => { if (!hasHistory) return; e.preventDefault(); clearTimeout(timer.current); openMenu(); },
    onKeyDown: (e) => { if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); openMenu(); } },
    onClick: () => { if (pressed.current) { pressed.current = false; return; } onBack(); },
  } : null;

  const fixed = position === 'fixed';
  return (
    <header
      data-ak-app-bar=""
      style={{
        position: fixed ? 'fixed' : position, top: 0, left: 0, right: 0, zIndex, boxSizing: 'border-box',
        paddingTop: 'env(safe-area-inset-top, 0px)', background: 'var(--surface-header, #073652)',
        color: 'var(--text-on-navy, #ffffff)', fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
        ...style,
      }}
      {...rest}
    >
      <div style={{ position: 'relative', height: 'var(--mobile-app-bar-height, 52px)', display: 'flex', alignItems: 'center', gap: 4, padding: pushed ? '0 4px' : '0 4px 0 14px' }}>
        {pushed ? (
          <React.Fragment>
            <button
              ref={backRef}
              type="button"
              aria-label={`Back to ${backLabel || 'previous screen'}`}
              aria-haspopup={hasHistory ? 'menu' : undefined}
              aria-expanded={hasHistory ? menuOpen : undefined}
              title={hasHistory ? 'Press and hold for history' : undefined}
              data-ak-back=""
              {...backHandlers}
              style={{
                flex: 'none', maxWidth: '42%', minHeight: 44, display: 'inline-flex', alignItems: 'center', gap: 2,
                padding: '0 10px 0 6px', border: 0, borderRadius: 22,
                background: menuOpen ? 'var(--surface-navy-hover, #205877)' : 'transparent',
                color: 'inherit', fontFamily: 'inherit', fontSize: 'var(--font-size-md, 16px)', fontWeight: 500,
                cursor: 'pointer', userSelect: 'none', WebkitTouchCallout: 'none', WebkitTapHighlightColor: 'transparent',
              }}
            >
              <i aria-hidden="true" className="bi bi-chevron-left" style={{ flex: 'none', fontSize: 22 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{backLabel}</span>
            </button>
            <div aria-hidden={showTitle ? undefined : 'true'} style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', opacity: showTitle ? 1 : 0, transition: fade }}>
              {title != null && <span data-ak-app-bar-title="" style={{ maxWidth: '100%', fontSize: 'var(--font-size-md, 16px)', fontWeight: 600, lineHeight: '20px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>}
              {subtitle != null && <span style={{ maxWidth: '100%', fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)', fontSize: 'var(--font-size-xs, 12px)', lineHeight: '16px', color: 'var(--text-on-navy-secondary, rgba(255,255,255,.72))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</span>}
            </div>
            <div style={{ flex: 'none', minWidth: 44, display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>{actions}</div>
            {menuOpen && <HistoryMenu entries={history} label={historyLabel} anchorRef={backRef} onClose={() => setMenuOpen(false)} onSelect={onHistorySelect} />}
          </React.Fragment>
        ) : (
          <React.Fragment>
            <div style={{ position: 'relative', flex: '1 1 auto', minWidth: 0, height: '100%', display: 'flex', alignItems: 'center' }}>
              {brand != null && <div style={{ display: 'flex', alignItems: 'center', opacity: showTitle && title != null ? 0 : 1, visibility: showTitle && title != null ? 'hidden' : 'visible', transition: fade }}>{brand}</div>}
              {title != null && (
                <span data-ak-app-bar-title="" aria-hidden={showTitle || brand == null ? undefined : 'true'} style={{ position: 'absolute', left: 2, right: 0, fontSize: 17, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: showTitle || brand == null ? 1 : 0, transition: fade, pointerEvents: 'none' }}>{title}</span>
              )}
            </div>
            <div style={{ flex: 'none', display: 'flex', alignItems: 'center' }}>{actions}</div>
          </React.Fragment>
        )}
      </div>
    </header>
  );
}

/** A 44px round icon button sized and coloured for the navy bar; `label` is its accessible name. */
export function MobileAppBarAction({ icon, label, onClick, style, ...rest }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} style={{ ...ICON_BUTTON, ...style }} {...rest}>
      <i aria-hidden="true" className={'bi ' + icon} style={{ fontSize: 'var(--icon-lg, 20px)' }} />
    </button>
  );
}
