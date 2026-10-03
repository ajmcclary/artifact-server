import React from 'react';
import { useEscapeLayer, lockScroll, trapLayerTab } from './overlay-layer.jsx';
import { displayProfileContext } from '../shell/DisplayProfile.jsx';
import { matchesMedia } from '../navigation/nav-helpers.jsx';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/* A drag past this distance, or a flick faster than this, dismisses the sheet. */
const DISMISS_DISTANCE = 96;
const DISMISS_VELOCITY = 0.6;

/**
 * ArkCase BottomSheet — the phone's modal surface. It rises from the bottom
 * edge over the navy scrim, holds whatever the host passes (module tiles, a
 * section list, filters, a record's actions) and never pushes a navigation
 * level. A 36 × 4 grabber and the header take a downward drag; past 96px, or
 * on a quick flick, the sheet closes. Escape, the scrim and the close button
 * close it too. It traps Tab, locks the body's scroll through the shared
 * counted lock and gives focus back to the opener.
 */
export function BottomSheet({
  open = false, onClose, title, label, children, footer, headerEnd,
  showClose = true, closeLabel = 'Close', dismissible = true, maxHeight = '92dvh',
  initialFocus, returnFocusSelector, zIndex = 1040, style, bodyStyle, ...rest
}) {
  const dp = React.useContext(displayProfileContext());
  const reduceMotion = dp ? dp.reduceMotion : matchesMedia('(prefers-reduced-motion: reduce)');
  const sheetRef = React.useRef(null);
  const prevFocus = React.useRef(null);
  const drag = React.useRef(null);
  const [entered, setEntered] = React.useState(false);
  const [offset, setOffset] = React.useState(0);
  const titleId = React.useId ? React.useId() : 'ak-sheet-title';
  const close = () => { if (dismissible && onClose) onClose(); };
  const handleEscape = useEscapeLayer(open, sheetRef, close, dismissible);

  React.useEffect(() => {
    if (!open) { setEntered(false); setOffset(0); return undefined; }
    if (reduceMotion || typeof requestAnimationFrame === 'undefined') { setEntered(true); return undefined; }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [open, reduceMotion]);

  React.useEffect(() => {
    if (!open) return undefined;
    prevFocus.current = document.activeElement;
    const el = sheetRef.current;
    if (el) {
      const body = el.querySelector('[data-ak-sheet-body]');
      const target = (initialFocus && el.querySelector(initialFocus)) || (body && body.querySelector(FOCUSABLE)) || el.querySelector(FOCUSABLE);
      (target || el).focus({ preventScroll: true });
    }
    const unlock = lockScroll(document);
    return () => {
      unlock();
      const fallback = returnFocusSelector ? document.querySelector(returnFocusSelector) : null;
      const prev = prevFocus.current;
      const target = fallback || (prev && prev.isConnected ? prev : null);
      if (target && target.focus) target.focus({ preventScroll: true });
      prevFocus.current = null;
    };
  }, [open, returnFocusSelector, initialFocus]);

  if (!open) return null;

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { handleEscape(e); return; }
    if (e.key === 'Tab') trapLayerTab(e, sheetRef.current);
  };
  const onPointerDown = (e) => {
    if (!dismissible || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.target.closest && e.target.closest('button, a, input, select, textarea')) return;
    drag.current = { y: e.clientY, t: Date.now(), id: e.pointerId };
    if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    setOffset(Math.max(0, e.clientY - drag.current.y));
  };
  const onPointerUp = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId) return;
    const dy = Math.max(0, e.clientY - d.y);
    const velocity = dy / Math.max(1, Date.now() - d.t);
    if (dy > DISMISS_DISTANCE || (dy > 24 && velocity > DISMISS_VELOCITY)) close();
    else setOffset(0);
  };
  const dragHandlers = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
  const dragging = offset > 0 && drag.current;
  const transform = entered ? `translateY(${offset}px)` : 'translateY(100%)';

  return (
    <React.Fragment>
      <div
        aria-hidden="true"
        data-ak-sheet-scrim=""
        onClick={close}
        style={{ position: 'fixed', inset: 0, zIndex, background: 'var(--scrim, rgba(7, 54, 82, 0.45))', opacity: entered ? 1 : 0, transition: reduceMotion ? 'none' : 'opacity .2s ease' }}
      />
      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title == null ? (label || 'Sheet') : undefined}
        aria-labelledby={title != null ? titleId : undefined}
        tabIndex={-1}
        data-ak-sheet=""
        onKeyDown={onKeyDown}
        style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: zIndex + 1,
          maxHeight, display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
          background: 'var(--surface-card, #ffffff)', color: 'var(--text-body, #212529)',
          borderRadius: 'var(--radius-sheet, 12px) var(--radius-sheet, 12px) 0 0',
          boxShadow: 'var(--shadow-up, 0 -6px 16px rgba(0, 0, 0, 0.14))',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)', outline: 'none',
          transform, transition: reduceMotion || dragging ? 'none' : 'transform .28s cubic-bezier(.2,.8,.2,1)',
          touchAction: 'pan-y', ...style,
        }}
        {...rest}
      >
        <div {...dragHandlers} data-ak-sheet-handle="" style={{ flex: 'none', padding: '8px 16px 0', cursor: dismissible ? 'grab' : 'default', touchAction: 'none' }}>
          <span aria-hidden="true" style={{ display: 'block', margin: '0 auto', width: 36, height: 4, borderRadius: 2, background: 'var(--border-color-strong, #ced4da)' }} />
          {(title != null || showClose || headerEnd) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 48, paddingTop: 4 }}>
              {title != null && <h2 id={titleId} style={{ margin: 0, flex: '1 1 auto', minWidth: 0, fontFamily: 'var(--font-heading, "Source Serif 4", Georgia, serif)', fontWeight: 600, fontSize: 'var(--font-size-lg, 20px)', lineHeight: 1.2, color: 'var(--text-strong, #111827)' }}>{title}</h2>}
              {title == null && <span style={{ flex: '1 1 auto' }} />}
              {headerEnd}
              {showClose && dismissible && (
                <button type="button" onClick={close} aria-label={closeLabel} title={closeLabel} style={{ flex: 'none', width: 44, height: 44, marginRight: -10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 0, borderRadius: 22, background: 'transparent', color: 'var(--text-emphasis, #374151)', cursor: 'pointer' }}>
                  <i aria-hidden="true" className="bi bi-x-lg" style={{ fontSize: 'var(--icon-md, 16px)' }} />
                </button>
              )}
            </div>
          )}
        </div>
        <div data-ak-sheet-body="" style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '4px 16px 16px', ...bodyStyle }}>
          {children}
        </div>
        {footer != null && <div style={{ flex: 'none', borderTop: '1px solid var(--list-divider, #e9ecef)', padding: '8px 16px' }}>{footer}</div>}
      </section>
    </React.Fragment>
  );
}
