import React from 'react';
import { useEscapeLayer } from './overlay-layer.jsx';
import { Modal } from './Modal.jsx';

/**
 * ArkCase Popover — an anchored non-modal container: the trigger's own press
 * opens it, a press outside or Escape closes it, and the content floats under
 * (or over, flipped) the trigger instead of centring like a Modal. It fills
 * the gap `Modal modal={false}` leaves: that primitive docks to the bar or an
 * edge, while a Popover anchors to the trigger that opened it — a picker's
 * list, a row's actions — and escapes a clipping parent (a `Card` keeps its
 * corners; the popover floats above them). `zIndex` coordinates with Modal's
 * 1050+ frame by intent; the default 30 sits inside local stacking contexts.
 *
 * `presentation="sheet"` is the phone form, as `Menu` has one: the same trigger
 * opens the content in a viewport `Modal` titled `sheetTitle` (or `label`), which
 * traps Tab, closes on Escape or its ×, and hands focus back to the trigger. A host
 * switches the presentation by profile and keeps one content tree for both.
 */
export function Popover({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  onClose,
  trigger,
  label = 'Dialog',
  placement = 'bottom-start',
  flip = true,
  dismissible = true,
  containTab = false,
  zIndex = 30,
  width = 320,
  onAnnounce,
  contentStyle,
  presentation = 'popover',
  sheetTitle,
  initialFocus,
  style,
  children,
  ...rest
}) {
  const sheet = presentation === 'sheet';
  const [inner, setInner] = React.useState(defaultOpen);
  const isOpen = controlledOpen !== undefined ? !!controlledOpen : inner;
  const wrapRef = React.useRef(null);
  const contentRef = React.useRef(null);
  const triggerEl = React.useRef(null);
  const [flipped, setFlipped] = React.useState(false);
  const [position, setPosition] = React.useState({ left: 0, top: 0 });

  const setOpen = (next, why) => {
    if (controlledOpen === undefined) setInner(next);
    if (onOpenChange) onOpenChange(next);
    if (!next && onClose && why === 'dismiss') onClose();
    if (onAnnounce) onAnnounce(next ? `${label} open` : `${label} closed`);
  };
  const closeFromEscape = () => {
    setOpen(false, 'dismiss');
    const el = triggerEl.current || wrapRef.current?.querySelector('button, a[href], [tabindex]:not([tabindex="-1"])');
    el?.focus();
  };
  const handleEscape = useEscapeLayer(isOpen && !sheet, wrapRef, closeFromEscape, dismissible);

  /* Flip vertically when the content would run off the viewport. */
  React.useLayoutEffect(() => {
    if (!isOpen || sheet) return undefined;
    const t = wrapRef.current;
    const c = contentRef.current;
    /* v8 ignore next */
    if (!t || !c || typeof window === 'undefined') return undefined;
    // Native manual popovers enter the top layer while remaining DOM descendants:
    // clipping/transformed ancestors cannot hide them; focus and React bubbling stay local.
    if (typeof c.showPopover === 'function') c.showPopover();
    const place = () => {
      const r = t.getBoundingClientRect(), h = c.offsetHeight, w = c.offsetWidth;
      const below = window.innerHeight - r.bottom, above = r.top;
      const wantTop = placement.startsWith('top');
      const invert = flip && ((!wantTop && h > below && above > below) || (wantTop && h > above && below > above));
      const top = wantTop !== !!invert;
      setFlipped(!!invert);
      const left = placement.endsWith('end') ? r.right - w : r.left;
      setPosition({ left: Math.max(12, Math.min(left, window.innerWidth - w - 12)),
        top: Math.max(12, Math.min(top ? r.top - h - 6 : r.bottom + 6, window.innerHeight - h - 12)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(t); observer?.observe(c);
    return () => {
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      observer?.disconnect();
      if (typeof c.hidePopover === 'function' && c.matches(':popover-open')) c.hidePopover();
    };
  }, [isOpen, placement, flip, width, sheet]);

  /* One capture-phase listener dismisses on an outside press; the trigger's
     own press belongs to the trigger, so the wrapper counts as inside. */
  React.useEffect(() => {
    /* v8 ignore next */
    if (!isOpen || sheet || !dismissible || typeof document === 'undefined') return undefined;
    const onDown = (e) => {
      const t = e.target;
      if (wrapRef.current && t instanceof Node && wrapRef.current.contains(t)) return;
      setOpen(false, 'dismiss');
    };
    const onKey = (e) => {
      if (e.defaultPrevented) return;
      /* Optional containment: Tab cycles inside the content while open.
         Leaving is what Escape and the trigger are for. */
      if (e.key !== 'Tab' || !containTab) return;
      const root = contentRef.current;
      if (!root || !(e.target instanceof Node) || !root.contains(e.target)) return;
      const items = Array.from(root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .filter((n) => n.offsetWidth > 0 || n.offsetHeight > 0 || n === document.activeElement);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen, sheet, dismissible, containTab, controlledOpen, onOpenChange, onClose, onAnnounce, label]);

  const top = placement.startsWith('top') !== flipped;
  const renderedTrigger = React.isValidElement(trigger)
    ? React.cloneElement(trigger, {
      'aria-haspopup': 'dialog',
      'aria-expanded': isOpen,
      ref: (node) => {
        triggerEl.current = node;
        /* React 19 carries ref as a regular prop; React 18 keeps it off props. */
        const prev = Number(React.version.split('.')[0]) >= 19 ? trigger.props.ref : trigger.ref;
        if (typeof prev === 'function') prev(node);
        else if (prev && typeof prev === 'object') prev.current = node;
      },
      onClick: (e) => {
        if (trigger.props && trigger.props.onClick) trigger.props.onClick(e);
        if (!e.defaultPrevented) setOpen(!isOpen, 'trigger');
      },
    })
    : trigger;

  if (sheet) {
    return (
      <div ref={wrapRef} data-popover-presentation="sheet" style={{ position: 'relative', ...style }} {...rest}>
        {renderedTrigger}
        {isOpen && (
          <Modal open size="viewport" title={sheetTitle || label} initialFocus={initialFocus}
            dismissible={dismissible} zIndex={Math.max(zIndex, 1050)}
            onClose={() => setOpen(false, 'dismiss')}>
            {children}
          </Modal>
        )}
      </div>
    );
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', ...style }} {...rest}
      onKeyDown={(event) => { rest.onKeyDown?.(event); handleEscape(event); }}>
      {renderedTrigger}
      {isOpen && (
        <div
          ref={contentRef}
          role="dialog"
          aria-label={label}
          popover={typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype ? 'manual' : undefined}
          data-popover-placement={top ? 'top' : 'bottom'}
          style={{
            position: 'fixed', margin: 0, padding: 0,
            zIndex,
            width,
            maxWidth: 'min(392px, calc(100vw - 48px))',
            right: 'auto', bottom: 'auto', ...position,
            maxHeight: 'calc(100dvh - 24px)', overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            overflowX: 'hidden',
            color: 'var(--text-body, #212529)', fontFamily: 'inherit',
            background: 'var(--surface-card, #fff)',
            border: '1px solid var(--border-color-strong, #ced4da)',
            borderRadius: 'var(--radius-lg, 8px)',
            boxShadow: 'var(--shadow-lg, 0 4px 8px rgba(0, 0, 0, 0.06), 0 12px 32px rgba(0, 0, 0, 0.14))',
            ...contentStyle,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
