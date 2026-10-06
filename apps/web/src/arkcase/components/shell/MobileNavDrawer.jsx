import React from 'react';
import { NavigationIcon } from '../navigation/NavigationIcon.jsx';
import { displayProfileContext } from './DisplayProfile.jsx';
import { matchesMedia, countText, leftToBrowser } from '../navigation/nav-helpers.jsx';
import { useEscapeLayer, lockScroll, trapLayerTab } from '../overlays/overlay-layer.jsx';

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * ArkCase MobileNavDrawer — the modal drawer the phone shell opens for its
 * primary navigation. It costs zero width while closed: a backdrop at 1030 and
 * a panel at 1031 that slides in from the start edge, traps Tab, closes on
 * Escape, locks the body's scroll and hands focus back where it came from. A
 * 56px navy header carries the brand, the title and the close button; every
 * item is a 44px target at 15px; `footer` is the account row at the bottom.
 *
 * `launcher` draws the phone's one way in when there is no top bar to hold a
 * hamburger: a 40px round navy button fixed at the top-left corner while the
 * drawer is closed. It calls `onOpen`, and focus comes back to it on close.
 */
export function MobileNavDrawer({
  open = false, onClose, items = [], activeLink, onSelect, brand, title, footer,
  width = 'min(320px, calc(100vw - 48px))', closeLabel = 'Close menu', label = 'Modules', onAnnounce,
  returnFocusSelector, launcher, onOpen,
  style, ...rest
}) {
  const launcherRef = React.useRef(null);
  const dp = React.useContext(displayProfileContext());
  const reduceMotion = dp ? dp.reduceMotion : matchesMedia('(prefers-reduced-motion: reduce)');
  const navRef = React.useRef(null);
  const prevFocus = React.useRef(null);
  const [entered, setEntered] = React.useState(false);
  const [hover, setHover] = React.useState(null);
  const close = () => { onClose && onClose(); onAnnounce && onAnnounce('Menu closed.'); };
  /* The shared layer stack owns Escape, so a dialog or popover opened over the drawer closes
     first; the drawer stays a barrier (the press is consumed) even without an `onClose`. */
  const handleEscape = useEscapeLayer(open, navRef, close);

  // Slide in on the frame after mount so the transform has a start value to leave.
  React.useEffect(() => {
    if (!open) { setEntered(false); return undefined; }
    if (reduceMotion || typeof requestAnimationFrame === 'undefined') { setEntered(true); return undefined; }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [open, reduceMotion]);

  // WCAG 2.4.3 — focus moves in on open and is restored on close; the body stops scrolling
  // through the shared, counted lock, so an overlapping dialog's lock is never undone early.
  React.useEffect(() => {
    if (!open) return undefined;
    prevFocus.current = document.activeElement;
    const el = navRef.current;
    if (el) { const f = el.querySelector(FOCUSABLE); (f || el).focus(); }
    const unlock = lockScroll(document);
    return () => {
      unlock();
      const fallback = returnFocusSelector ? document.querySelector(returnFocusSelector) : null;
      /* The launcher unmounts while the drawer is open, so the node that had focus is gone; the
         remounted launcher is already attached when this cleanup runs. */
      const prev = prevFocus.current;
      const stale = !prev || prev === document.body || !prev.isConnected;
      const target = fallback || (stale && launcherRef.current) || prev;
      if (target && target.focus) target.focus();
      prevFocus.current = null;
    };
  }, [open, returnFocusSelector]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { handleEscape(e); return; }
    if (e.key === 'Tab') trapLayerTab(e, navRef.current);
  };

  if (!open) {
    if (!launcher) return null;
    const opts = typeof launcher === 'object' ? launcher : {};
    const launchLabel = opts.label || 'Open menu';
    return (
      <button
        ref={launcherRef}
        type="button"
        data-ac-mnav-launcher=""
        aria-label={launchLabel}
        aria-haspopup="dialog"
        aria-expanded={false}
        onClick={() => onOpen && onOpen()}
        style={{
          position: 'fixed', top: 10, left: 10, zIndex: 60, width: 40, height: 40, padding: 0,
          borderRadius: '50%', border: 0, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--surface-header, #073652)', color: 'var(--text-on-navy, #fff)',
          boxShadow: 'var(--shadow-md, 0 2px 4px rgba(0, 0, 0, 0.05), 0 4px 12px rgba(0, 0, 0, 0.10))',
          marginTop: 'env(safe-area-inset-top)',
        }}
      >
        <i aria-hidden="true" data-icon-tone="current" className={'bi ' + (opts.icon || 'bi-list')} style={{ fontSize: 20 }} />
      </button>
    );
  }

  return (
    <React.Fragment>
      <div onClick={close} aria-hidden="true" style={{ position: 'fixed', inset: 0, zIndex: 1030, background: 'var(--scrim, rgba(7, 54, 82, 0.45))', opacity: entered ? 1 : 0, transition: reduceMotion ? 'none' : 'opacity .3s ease' }} />
      <div
        ref={navRef}
        data-ac-mnav="true"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{
          position: 'fixed', top: 0, bottom: 0, left: 0, width, zIndex: 1031,
          background: 'var(--surface-navy-subtle, #eaf1f6)',
          display: 'flex', flexDirection: 'column',
          boxShadow: 'var(--shadow-lg, 0 4px 8px rgba(0, 0, 0, 0.06), 0 12px 32px rgba(0, 0, 0, 0.14))',
          paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)',
          outline: 'none',
          transform: entered ? 'translateX(0)' : 'translateX(-100%)',
          transition: reduceMotion ? 'none' : 'transform .3s ease',
          ...style,
        }}
        {...rest}
      >
        <div data-icon-tone="current" style={{ height: 56, flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '0 6px 0 16px', background: 'var(--surface-header, #073652)', color: 'var(--text-on-navy, #fff)' }}>
          {brand}
          {title != null && <span style={{ fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-on-navy-secondary, rgba(255, 255, 255, 0.72))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{title}</span>}
          <button
            type="button"
            onClick={close}
            aria-label={closeLabel}
            title={closeLabel}
            style={{ marginLeft: 'auto', flex: 'none', width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 0, borderRadius: 'var(--radius-md, 5px)', color: 'var(--text-on-navy, #fff)', cursor: 'pointer' }}
          >
            <i aria-hidden="true" className="bi bi-x-lg" style={{ fontSize: 'var(--icon-lg, 20px)' }} />
          </button>
        </div>
        <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', padding: '6px 0 12px' }}>
          {items.map((m, i) => {
            const active = m.link === activeLink;
            const on = hover === i;
            const showGroup = m.group && !(i > 0 && items[i - 1].group === m.group);
            return (
              <React.Fragment key={m.id != null ? m.id : i}>
                {showGroup && (
                  <div style={{ flex: 'none', height: 30, display: 'flex', alignItems: 'flex-end', padding: '0 14px 4px' }}>
                    <span style={{ fontSize: 'var(--font-size-label, 11px)', fontWeight: 700, letterSpacing: 'var(--letter-spacing-wide, .025em)', textTransform: 'uppercase', color: 'var(--text-secondary, #5a6268)', whiteSpace: 'nowrap' }}>{m.group}</span>
                  </div>
                )}
                <a
                  href={m.link}
                  aria-current={active ? 'page' : undefined}
                  onClick={(e) => { if (m.link != null && leftToBrowser(e)) return; e.preventDefault(); onSelect && onSelect(m); close(); }}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  style={{
                    flex: 'none', display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, padding: '8px 12px',
                    fontSize: 'var(--font-size-md, 1rem)', textDecoration: 'none', overflow: 'hidden',
                    borderLeft: `3px solid ${active ? 'var(--bs-primary, #0079a8)' : 'transparent'}`,
                    background: active ? 'var(--tint-primary-selected, rgba(0,121,168,.10))' : on ? 'var(--tint-primary-hover, rgba(0,121,168,.05))' : 'transparent',
                    color: active ? 'var(--text-link-hover, #005a7d)' : 'var(--text-body, #212529)',
                    fontWeight: active ? 500 : 400,
                    transition: reduceMotion ? 'none' : 'background .15s ease',
                  }}
                >
                  <span style={{ width: 30, height: 'calc(var(--icon-lg, 20px) * 1.5)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <NavigationIcon icon={m.icon || 'bi-circle'} active={active} />
                  </span>
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.label}</span>
                  {m.count != null && <span style={{ marginLeft: 'auto', flex: 'none', minWidth: 20, textAlign: 'center', background: m.countTone === 'danger' ? 'var(--bs-danger, #d83506)' : 'var(--pill-neutral-bg, #e9ecef)', color: m.countTone === 'danger' ? 'var(--text-on-primary, #ffffff)' : 'var(--pill-neutral-fg, #495057)', fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, lineHeight: 1.45, borderRadius: 'var(--radius-pill, 10px)', padding: '1px 6px' }}>{countText(m.count)}</span>}
                  {m.locked && <i aria-hidden="true" className="bi bi-lock" title="Restricted for your role" style={{ marginLeft: m.count != null ? 8 : 'auto', flexShrink: 0, fontSize: 'var(--icon-xs, 12px)', color: 'var(--text-secondary, #5a6268)' }} />}
                </a>
              </React.Fragment>
            );
          })}
        </div>
        {footer != null && <div style={{ flex: 'none', borderTop: '1px solid var(--border-color-strong, #ced4da)', padding: '8px 12px', background: 'var(--surface-body, #fff)' }}>{footer}</div>}
      </div>
    </React.Fragment>
  );
}
