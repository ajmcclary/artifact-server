import React from 'react';
import { Button } from '../actions/Button.jsx';
import { useEscapeLayer, lockScroll, trapLayerTab } from './overlay-layer.jsx';

const SIZES = { sm: 480, md: 620, lg: 820 };
const BACKDROP = { navy: 'var(--scrim, rgba(7, 54, 82, 0.45))', tint: 'rgba(7,54,82,.18)', none: 'transparent' };
const MODAL_SKIP_INERT = { SCRIPT: 1, STYLE: 1, LINK: 1, TEMPLATE: 1, NOSCRIPT: 1 };

/* react-dom never enters the bundle: portable pages load it as a UMD global. */
function modalReactDOM() {
  const g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null);
  return g && g.ReactDOM && typeof g.ReactDOM.createPortal === 'function' ? g.ReactDOM : null;
}

/* The phone's full-screen frame: inset 0, no radius, border, shadow or transform, and the
   safe-area pads so the header and footer clear a notch and a home indicator. */
const FULLSCREEN_FRAME = {
  top: 0, right: 0, bottom: 0, left: 0, transform: 'none', width: 'auto', height: 'auto',
  maxWidth: 'none', maxHeight: 'none', border: 0, borderRadius: 0, boxShadow: 'none',
  paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)',
};

/* True while the viewport is narrower than `px` (no media query without a number or a window). */
function useNarrowerThan(px) {
  const query = typeof px === 'number' && px > 0 ? `(max-width: ${px - 0.02}px)` : null;
  const read = () => (query && typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [narrow, setNarrow] = React.useState(read);
  React.useEffect(() => {
    if (!query || typeof window === 'undefined' || !window.matchMedia) { setNarrow(false); return undefined; }
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    if (mq.addEventListener) mq.addEventListener('change', on); else mq.addListener(on);
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', on); else mq.removeListener(on); };
  }, [query]);
  return narrow;
}

/* The element to focus on open: a selector inside the dialog, or a ref. */
function modalInitialTarget(root, initialFocus) {
  if (!root || !initialFocus) return null;
  if (typeof initialFocus === 'string') { try { return root.querySelector(initialFocus); } catch (_) { return null; } }
  return initialFocus.current || null;
}

/**
 * ArkCase Modal — the dialog every form, picker and confirmation in the
 * applications opens in. 8px radius, #CED4DA hairline, --shadow-lg, a navy
 * backdrop at 45%, a #F8F9FA footer cap. Escape closes; focus moves to the
 * dialog on open, Tab cycles inside it, and focus returns to the opener on
 * close — hosts draw no local trap. The backdrop does not scroll the page
 * behind it.
 *
 * Since E5d a `placement` docks it under the bar (`top`, centred or at an
 * `anchor.right`) or to the end edge (`end`); `modal={false}` is an anchored
 * panel that leaves focus and scroll alone — a search's results, a bell's list;
 * `backdrop`, `header`, `label` and `bodyStyle` let a host draw its own chrome
 * inside the frame. Every one of them defaults to the centred dialog above.
 * Since E5e the title is a heading (`titleLevel`, `h2` by default), `headerEnd`
 * places nodes at the end of the title row, and `zIndex` stacks one dialog over
 * another by intent.
 *
 * Without a `footer`, a `primaryAction` draws the standard footer: a secondary
 * outline Cancel (`cancelLabel`, calling `onCancel` or else `onClose`) and the
 * primary sm Button last. An explicit `footer` always wins.
 *
 * The full-screen workspace forms: `size="viewport"` fills the viewport with no
 * radius or border; `size="full"` with `inset` sits N px inside each edge.
 * `portal` renders into its own host under document.body (through the page's
 * ReactDOM global), `inertSiblings` makes every other body child inert while it
 * is open, and `initialFocus` names what takes focus on open. An Escape a nested
 * layer has already handled (`preventDefault()`) does not close the dialog.
 *
 * `fullscreen` (or a viewport narrower than `fullscreenBelow`) turns any placement into
 * the phone's full-screen frame. `footerNote` leads the footer band with a hint or, in
 * `footerNoteTone="danger"`, the gate note that says why the primary is disabled.
 */
export function Modal({ open = true, title, subtitle, icon, size = 'md', onClose, footer, children, dismissible = true, labelledBy, label, placement = 'center', anchor, width: dockWidth, modal = true, backdrop = 'navy', header = true, bodyStyle, titleLevel = 2, headerEnd, zIndex = 1050, primaryAction, cancelLabel = 'Cancel', onCancel, inset, portal = false, inertSiblings = false, initialFocus, fullscreen = false, fullscreenBelow, footerNote, footerNoteTone = 'default', style, ...rest }) {
  const narrow = useNarrowerThan(fullscreenBelow);
  const full = !!fullscreen || narrow;
  const ref = React.useRef(null);
  const handleEscape = useEscapeLayer(open && (modal || !!onClose), ref, onClose, dismissible && !!onClose);
  const portalHost = React.useRef(null);
  const RD = portal ? modalReactDOM() : null;
  if (RD && !portalHost.current && typeof document !== 'undefined') {
    portalHost.current = document.createElement('div');
    portalHost.current.setAttribute('data-ak-modal-portal', '');
  }
  /* The portal host joins the body while open and leaves it on close. */
  React.useLayoutEffect(() => {
    const host = portalHost.current;
    if (!open || !RD || !host) return undefined;
    document.body.appendChild(host);
    return () => { if (host.parentNode) host.parentNode.removeChild(host); };
  }, [open, RD]);
  /* Declared before the focus effect so, on close, siblings are live again before
     focus returns to the opener among them. */
  React.useEffect(() => {
    if (!open || !inertSiblings || typeof document === 'undefined') return undefined;
    let own = RD && portalHost.current ? portalHost.current : ref.current;
    while (own && own.parentNode && own.parentNode !== document.body) own = own.parentNode;
    if (!own || own.parentNode !== document.body) return undefined;
    const changed = [];
    Array.from(document.body.children).forEach((el) => {
      if (el === own || MODAL_SKIP_INERT[el.tagName] || el.inert) return;
      el.inert = true;
      changed.push(el);
    });
    return () => changed.forEach((el) => { el.inert = false; });
  }, [open, inertSiblings, RD]);
  const id = React.useMemo(() => `ak-dlg-${Math.random().toString(36).slice(2, 8)}`, []);
  const returnTo = React.useRef(null);
  const wasOpen = React.useRef(false);
  /* The closed→open transition owns focus: capture the opener, move focus
     into the dialog unless a child already holds it, and hand focus back to
     the opener when the dialog closes or unmounts. Anchored (`modal={false}`)
     panels leave focus alone. */
  React.useEffect(() => {
    if (!open || !modal) { wasOpen.current = false; return undefined; }
    if (!wasOpen.current) {
      wasOpen.current = true;
      const at = document.activeElement;
      returnTo.current = at instanceof HTMLElement ? at : null;
      const el = ref.current;
      if (el && !el.contains(document.activeElement)) (modalInitialTarget(el, initialFocus) || el).focus();
    }
    return () => {
      if (wasOpen.current) {
        wasOpen.current = false;
        const t = returnTo.current;
        returnTo.current = null;
        if (t && t.focus && document.contains(t)) t.focus();
      }
    };
  }, [open, modal]);
  React.useEffect(() => {
    if (!open) return undefined;
    /* The trap cycles at the boundaries only — it never yanks focus that
       sits outside the dialog, so a nested sheet keeps its own Tab order. */
    const onKey = (e) => { if (modal) trapLayerTab(e, ref.current); };
    document.addEventListener('keydown', onKey);
    const unlock = modal ? lockScroll(document) : null;
    return () => { document.removeEventListener('keydown', onKey); unlock?.(); };
  }, [open, modal]);

  if (!open) return null;
  const docked = placement === 'top' || placement === 'end';
  const width = docked ? dockWidth : size === 'full' ? 'calc(100% - 56px)' : SIZES[size] || SIZES.md;
  const insetFull = !docked && size === 'full' && typeof inset === 'number';
  const a = anchor || {};
  const top = a.top != null ? a.top : 0;
  const frame = full
    ? FULLSCREEN_FRAME
    : placement === 'end'
    ? { top, right: 0, bottom: 0, width, borderRadius: 0, borderLeft: '1px solid var(--border-color, #dee2e6)', boxShadow: '0 0 24px rgba(0,0,0,.12)' }
    : placement === 'top' && a.right != null
      ? { top, right: a.right, width, maxWidth: '94vw' }
      : placement === 'top'
        ? { top, left: '50%', transform: 'translateX(-50%)', width, maxWidth: '94vw', borderRadius: '0 0 var(--radius-lg, 8px) var(--radius-lg, 8px)' }
        : !docked && size === 'viewport'
          ? { top: 0, right: 0, bottom: 0, left: 0, width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none', transform: 'none', border: 0, borderRadius: 0, boxShadow: 'none' }
        : insetFull
          ? { top: inset, right: inset, bottom: inset, left: inset, width: 'auto', maxWidth: 'none', maxHeight: 'none', transform: 'none' }
        : { top: size === 'full' ? 28 : '50%', bottom: size === 'full' ? 28 : undefined, left: '50%', transform: size === 'full' ? 'translateX(-50%)' : 'translate(-50%, -50%)', width, maxWidth: '94vw', maxHeight: 'calc(100% - 56px)' };

  const H = 'h' + titleLevel;
  const cancel = onCancel || onClose;
  const footerContent = footer || (primaryAction ? (
    <React.Fragment>
      <Button variant="secondary" outline size="sm" onClick={cancel}>{cancelLabel}</Button>
      <Button variant={primaryAction.variant || 'primary'} size="sm" icon={primaryAction.icon} disabled={!!primaryAction.disabled} onClick={primaryAction.onClick}>{primaryAction.label}</Button>
    </React.Fragment>
  ) : null);

  const hasNote = footerNote != null && footerNote !== false && footerNote !== '';
  const note = hasNote ? (
    <div
      data-modal-footer-note=""
      style={{
        flex: '1 1 auto', minWidth: 0, marginRight: 'auto', textAlign: 'left',
        fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.375, textWrap: 'pretty',
        ...(footerNoteTone === 'danger'
          ? { fontWeight: 600, color: 'var(--pill-danger-fg, #991b1b)' }
          : { color: 'var(--text-secondary, #5a6268)' }),
      }}
    >
      {footerNote}
    </div>
  ) : null;

  const tree = (
    <React.Fragment>
      <div
        aria-hidden="true"
        onClick={dismissible ? onClose : undefined}
        style={{ position: 'fixed', inset: 0, zIndex: zIndex, background: BACKDROP[backdrop] || BACKDROP.navy }}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal={modal ? 'true' : undefined}
        aria-label={label}
        aria-labelledby={labelledBy || (header && title && !label ? id : undefined)}
        tabIndex={-1}
        style={{
          position: 'fixed', zIndex: zIndex + 1,
          display: 'flex', flexDirection: 'column',
          background: 'var(--surface-card, #fff)',
          border: '1px solid var(--border-color-strong, #ced4da)',
          borderRadius: 'var(--radius-lg, 8px)',
          boxShadow: 'var(--shadow-lg, 0 4px 8px rgba(0,0,0,.06), 0 12px 32px rgba(0,0,0,.14))',
          overflow: 'hidden', outline: 'none',
          ...frame,
          ...style,
        }}
        {...rest}
        onKeyDown={(event) => { rest.onKeyDown?.(event); handleEscape(event); }}
      >
        {header && (title || onClose) && (
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--list-divider, #e9ecef)' }}>
            {icon && (
              <span aria-hidden="true" style={{ width: 22, height: 22, flexShrink: 0, background: 'var(--surface-header, #073652)', borderRadius: 'var(--radius-sm, 4px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className={`bi ${icon}`} style={{ color: 'var(--text-link, #0079a8)', fontSize: 12 }} />
              </span>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              {title && <H id={id} style={{ margin: 0, fontFamily: 'var(--font-display, "Source Serif 4", Georgia, serif)', fontSize: 'var(--font-size-lg, 20px)', fontWeight: 600, color: 'var(--text-navy, #073652)', lineHeight: 1.25 }}>{title}</H>}
              {subtitle && <div style={{ marginTop: 2, fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.45, color: 'var(--text-secondary, #5a6268)' }}>{subtitle}</div>}
            </div>
            {headerEnd != null && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>{headerEnd}</div>}
            {onClose && (
              <button type="button" onClick={onClose} aria-label="Close" style={{ flex: 'none', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary, #5a6268)', padding: 4, lineHeight: 1, borderRadius: 'var(--radius-circle, 50%)' }}>
                <i className="bi bi-x-lg" aria-hidden="true" style={{ fontSize: 13 }} />
              </button>
            )}
          </div>
        )}
        <div tabIndex={0} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14, fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.5, color: 'var(--text-body, #212529)', ...bodyStyle }}>{children}</div>
        {(footerContent || note) && (
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '12px 14px', background: 'var(--surface-secondary, #f8f9fa)', borderTop: '1px solid var(--list-divider, #e9ecef)' }}>{note}{footerContent}</div>
        )}
      </div>
    </React.Fragment>
  );
  return RD && portalHost.current ? RD.createPortal(tree, portalHost.current) : tree;
}
