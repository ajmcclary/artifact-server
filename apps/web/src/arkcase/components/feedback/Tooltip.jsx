import React from 'react';

let uid = 0;

/**
 * ArkCase Tooltip — names an icon-only control. Shows on hover and on keyboard
 * focus (never on focus alone for a control that already has a visible label),
 * dismisses on Escape. 11px, dark chip, no arrow. `bottom-end` hangs it below a
 * control at the top-right of a rail, its right edge on the control's.
 *
 * Wraps its child; the child must accept a ref-less DOM position — the wrapper
 * carries the listeners and the aria-describedby link.
 */
export function Tooltip({ label, placement = 'top', wide = false, fixed = false, children, style, ...rest }) {
  const [open, setOpen] = React.useState(false);
  const [anchor, setAnchor] = React.useState(null);
  const rootRef = React.useRef(null);
  const id = React.useMemo(() => `ak-tip-${++uid}`, []);
  const localPos = {
    top:    { bottom: 'calc(100% + 7px)', left: 0 },
    bottom: { top: 'calc(100% + 7px)', left: 0 },
    end:    { bottom: 'calc(100% + 7px)', right: 0 },
    'bottom-end': { top: 'calc(100% + 7px)', right: 0 },
    right:  { top: '50%', left: 'calc(100% + 8px)', transform: 'translateY(-50%)' },
    left:   { top: '50%', right: 'calc(100% + 8px)', transform: 'translateY(-50%)' },
  }[placement] || { bottom: 'calc(100% + 7px)', left: 0 };
  React.useEffect(() => {
    if (!open || !fixed || !rootRef.current) return undefined;
    const read = () => {
      if (!rootRef.current) return;
      const r = rootRef.current.getBoundingClientRect();
      setAnchor({ top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height });
    };
    read();
    window.addEventListener('resize', read);
    window.addEventListener('scroll', read, true);
    return () => {
      window.removeEventListener('resize', read);
      window.removeEventListener('scroll', read, true);
    };
  }, [open, fixed]);
  const fixedPos = anchor ? {
    top: { bottom: `calc(100vh - ${anchor.top}px + 7px)`, left: anchor.left },
    bottom: { top: anchor.bottom + 7, left: anchor.left },
    end: { bottom: `calc(100vh - ${anchor.top}px + 7px)`, right: `calc(100vw - ${anchor.right}px)` },
    'bottom-end': { top: anchor.bottom + 7, right: `calc(100vw - ${anchor.right}px)` },
    right: { top: anchor.top + anchor.height / 2, left: anchor.right + 8, transform: 'translateY(-50%)' },
    left: { top: anchor.top + anchor.height / 2, right: `calc(100vw - ${anchor.left}px + 8px)`, transform: 'translateY(-50%)' },
  }[placement] : null;
  const pos = fixed && fixedPos ? fixedPos : localPos;
  return (
    <span
      ref={rootRef}
      style={{ position: 'relative', display: 'inline-flex', ...style }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
      {...rest}
    >
      {React.isValidElement(children) ? React.cloneElement(children, { 'aria-describedby': id }) : children}
      <span
        role="tooltip"
        id={id}
        style={{
          position: fixed ? 'fixed' : 'absolute', zIndex: 1080, ...pos,
          padding: '4px 8px',
          borderRadius: 'var(--radius-md, 5px)',
          background: 'var(--surface-header, #073652)',
          color: 'var(--text-on-navy, #fff)',
          fontSize: 'var(--font-size-label, 11px)',
          fontWeight: 400, letterSpacing: 0,
          lineHeight: wide ? 1.45 : 1.35,
          whiteSpace: wide ? 'normal' : 'nowrap',
          width: wide ? 236 : undefined,
          boxShadow: 'var(--shadow-md, 0 2px 4px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.10))',
          opacity: open && (!fixed || anchor) ? 1 : 0,
          visibility: open && (!fixed || anchor) ? 'visible' : 'hidden',
          transition: 'opacity .15s ease',
          pointerEvents: 'none',
        }}
      >
        {label}
      </span>
    </span>
  );
}
