import React from 'react';

/**
 * ArkCase ScrollDock — a header that stays put once the reader scrolls past it.
 *
 * It is `position: sticky` with the part nobody writes twice: it finds its own
 * scrolling ancestor, watches for the moment the element actually becomes stuck
 * — the element's top meeting the scroller's, not an absolute scroll distance,
 * so it works for a strip halfway down a page as well as one at the top — and
 * reports that as `docked`. A docked dock paints its surface and its shadow, so
 * the content passing underneath cannot show through.
 *
 * `children` may be a function of `{ docked }`: that is the "smart" half — a
 * record band can drop its stat block and step its title down while the tabs
 * beneath it stay full size, rather than the whole header simply freezing.
 *
 * `bleed` cancels a page gutter so the docked surface reaches the pane's edges
 * while the content inside keeps its original alignment.
 */

/* The nearest ancestor that clips and scrolls is both the sticky containing block and the
   element whose top edge decides "docked" — found by overflow alone, not by whether it happens
   to be overflowing right now, or a header would stop docking whenever its route loaded short
   and grew afterwards. */
function scrollParent(el) {
  let node = el && el.parentElement;
  while (node) {
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
    const oy = cs ? cs.overflowY : '';
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return node;
    node = node.parentElement;
  }
  return null;
}

export function ScrollDock({
  children, top = 0, zIndex = 20, bleed = 0, threshold = 1,
  surface = 'var(--surface-card, #fff)', shadow = 'var(--shadow-md, 0 2px 4px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.1))',
  dockedStyle, onDockChange, disabled = false, style, ...rest
}) {
  const ref = React.useRef(null);
  const [docked, setDocked] = React.useState(false);
  const notify = React.useRef(onDockChange);
  notify.current = onDockChange;

  React.useEffect(() => {
    if (disabled) { setDocked(false); return undefined; }
    const el = ref.current;
    /* v8 ignore next */
    if (!el || typeof window === 'undefined') return undefined;
    const scroller = scrollParent(el);
    const target = scroller || window;
    let frame = 0;
    let last = false;
    /* Two conditions, and both are needed. The element's top meeting the scroller's is what
       `position: sticky` is doing — but CSS pins it from the first frame, so a header that
       simply starts at the top of its pane satisfies that at rest. The scroll offset is what
       separates "at the top because it has been carried there" from "at the top because that
       is where it begins". Nothing is measured and remembered, so content growing above the
       element needs no invalidation. */
    const read = () => {
      frame = 0;
      const node = ref.current;
      /* v8 ignore next */
      if (!node) return;
      const scrollTop = scroller ? scroller.scrollTop : (window.pageYOffset || window.scrollY || 0);
      const edge = scroller ? scroller.getBoundingClientRect().top : 0;
      const stuck = scrollTop > threshold && node.getBoundingClientRect().top - (edge + top) <= 1;
      if (stuck !== last) {
        last = stuck;
        setDocked(stuck);
        if (notify.current) notify.current(stuck);
      }
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(read); };
    read();
    target.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      target.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
    /* `disabled` and the geometry props are the whole dependency: the scroller is
       re-found on every mount, which is what a route change gives us anyway. */
  }, [disabled, top, threshold]);

  const body = typeof children === 'function' ? children({ docked }) : children;
  const gutter = bleed ? { marginLeft: -bleed, marginRight: -bleed, paddingLeft: bleed, paddingRight: bleed } : null;

  return (
    <div
      ref={ref}
      data-scroll-dock={disabled ? 'off' : docked ? 'docked' : 'rest'}
      style={{
        ...(disabled ? null : { position: 'sticky', top, zIndex }),
        background: surface,
        boxShadow: docked ? shadow : 'none',
        transition: 'box-shadow .15s ease',
        ...gutter,
        ...style,
        ...(docked ? dockedStyle : null),
      }}
      {...rest}
    >
      {body}
    </div>
  );
}
