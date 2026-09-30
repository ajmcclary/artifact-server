import React from 'react';

const VISUALLY_HIDDEN = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' };
/* The stage takes its roomier padding from this width up (the 768 step of the ladder). */
const ROOMY_FROM = 768;

const hasWindow = () => typeof window !== 'undefined';

/* Width of the layout root, observed with ResizeObserver (so a layout inside a
   pane or a story frame responds to its own width), falling back to the window
   width through matchMedia/resize. Server and test renders start from the
   window width when there is one, otherwise from `fallback`. */
function useRootWidth(ref, fallback) {
  const [width, setWidth] = React.useState(() => (hasWindow() && window.innerWidth ? window.innerWidth : fallback));
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => {
      const w = el.getBoundingClientRect().width;
      if (w) setWidth(Math.round(w));
    };
    read();
    if (typeof ResizeObserver !== 'undefined') {
      // Defer the callback a frame: a state write inside a ResizeObserver callback is
      // what Chromium reports as "ResizeObserver loop completed with undelivered notifications".
      let frame = 0;
      const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; read(); }); };
      const ro = new ResizeObserver(schedule);
      ro.observe(el);
      return () => { if (frame) cancelAnimationFrame(frame); ro.disconnect(); };
    }
    if (!hasWindow()) return undefined;
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, [ref]);
  return width;
}

/**
 * ArkCase AuthLayout — the page sign-in, verification and account setup stand
 * on. From the breakpoint up it is split: a navy brand aside (the lock-up, a
 * serif headline, one lead sentence, a few icon-and-text points, a closing
 * line) beside a centred stage column. Below it the aside gives way to a navy
 * top bar with the compact lock-up, and the stage takes the full width. The
 * stage column holds one AuthCard (flush) and anything that belongs beside it;
 * the footer carries the ways out and the origin line.
 *
 * Inline styles cannot hold media queries, so the layout observes its own root
 * width; `layout` pins either arrangement.
 */
export function AuthLayout({
  brand, brandCompact, headline, lead, points, asideFooter, footer,
  asideLabel = 'About this service', columnWidth = 440, breakpoint = 1024,
  layout = 'auto', children, style, ...rest
}) {
  const rootRef = React.useRef(null);
  const width = useRootWidth(rootRef, breakpoint);
  const split = layout === 'split' ? true : layout === 'stacked' ? false : width >= breakpoint;
  const roomy = width >= ROOMY_FROM;
  const has = (node) => node != null && node !== false && node !== '';
  const compact = brandCompact !== undefined ? brandCompact : brand;
  const pointList = Array.isArray(points) ? points.filter(Boolean) : [];

  const aside = (
    <aside
      aria-label={asideLabel}
      style={{
        display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0,
        padding: '44px 34px 32px',
        background: 'var(--surface-header, #073652)',
        color: 'var(--text-on-navy, #fff)',
      }}
    >
      {has(brand) && <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>{brand}</div>}
      {(has(headline) || has(lead)) && (
        <div style={{ marginTop: 6 }}>
          {has(headline) && (
            <h1 style={{ margin: 0, fontFamily: 'var(--font-heading, "Source Serif 4", Georgia, serif)', fontWeight: 600, fontSize: 30, lineHeight: 1.18, color: 'var(--text-on-navy, #fff)', textWrap: 'pretty' }}>{headline}</h1>
          )}
          {has(lead) && (
            <p style={{ margin: has(headline) ? '14px 0 0' : 0, maxWidth: '32ch', fontSize: '0.9375rem', lineHeight: 1.6, color: 'var(--text-on-navy-secondary, rgba(255,255,255,.72))', textWrap: 'pretty' }}>{lead}</p>
          )}
        </div>
      )}
      {pointList.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {pointList.map((p, i) => (
            <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              {p.icon && (
                <i aria-hidden="true" data-icon-tone="current" className={`bi ${p.icon}`} style={{ flex: 'none', marginTop: 2, fontSize: 16, color: 'var(--text-on-navy, #fff)' }} />
              )}
              <span style={{ fontSize: 'var(--font-size-sm, 0.875rem)', lineHeight: 1.55, color: 'var(--text-on-navy-secondary, rgba(255,255,255,.72))', textWrap: 'pretty' }}>{p.text}</span>
            </li>
          ))}
        </ul>
      )}
      {has(asideFooter) && (
        <div style={{ marginTop: 'auto', paddingTop: 24, borderTop: '1px solid var(--border-on-navy, rgba(255,255,255,.18))', fontSize: 'var(--font-size-dense, 0.8125rem)', lineHeight: 1.6, color: 'var(--text-on-navy-secondary, rgba(255,255,255,.72))', textWrap: 'pretty' }}>{asideFooter}</div>
      )}
    </aside>
  );

  return (
    <div
      ref={rootRef}
      data-layout={split ? 'split' : 'stacked'}
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: split ? 'minmax(330px, 392px) minmax(0, 1fr)' : 'minmax(0, 1fr)',
        minHeight: '100dvh',
        background: 'var(--surface-canvas, #f1f5f7)',
        color: 'var(--text-body, #212529)',
        fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
        ...style,
      }}
      {...rest}
    >
      {split && aside}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {!split && (
          <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', background: 'var(--surface-header, #073652)', color: 'var(--text-on-navy, #fff)' }}>
            {compact}
            {/* The aside's headline stays the page's h1 when the aside is not drawn. */}
            {has(headline) && <h1 style={VISUALLY_HIDDEN}>{headline}</h1>}
          </header>
        )}
        <main style={{ flex: '1 1 auto', display: 'flex', justifyContent: 'center', padding: roomy ? '40px 24px' : '24px 16px' }}>
          <div style={{ width: '100%', maxWidth: columnWidth, margin: 'auto 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {children}
          </div>
        </main>
        {has(footer) && (
          <footer style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, padding: '18px 20px 24px', textAlign: 'center', fontSize: 'var(--font-size-sm, 0.875rem)', color: 'var(--text-secondary, #5a6268)' }}>
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
