/* The toolbar Activity and the Design library share. It sits flat on the canvas under the
   page heading, docks at the scroller's top with a hairline beneath, and once docked leads
   with the page's title (no count beside it; a phone skips the title to keep the bar short). Every control is about 32px in a 56px row.
   Filters are ghost menu triggers; narrowing shows a summary row of removable filters. */
export function createToolbarUI(React, DS) {
  const { Button, Menu, ScrollDock, Toolbar, ToolbarSeparator } = DS;
  const ROW = 56;
  const LINE = '1px solid var(--border-color, #dee2e6)';

  /* `onHeight` reports the docked bar's height, hairline included, so the bands and caps
     below can pin directly beneath it whatever height the row wraps to. */
  function PageToolbar({ title, label, gutter = 20, phone = false, onHeight, children }) {
    const rowRef = React.useRef(null);
    React.useLayoutEffect(() => {
      const row = rowRef.current;
      if (!row || !onHeight) return undefined;
      const report = () => onHeight(Math.round(row.getBoundingClientRect().height) + 1);
      report();
      if (typeof ResizeObserver === 'undefined') return undefined;
      const observer = new ResizeObserver(report);
      observer.observe(row);
      return () => observer.disconnect();
    }, [onHeight]);
    return <ScrollDock surface="var(--surface-canvas, #f1f5f7)" bleed={gutter} zIndex={4}
      style={{ borderBottom: '1px solid transparent' }} dockedStyle={{ borderBottom: LINE }}>
      {({ docked }) => <div ref={rowRef}>
        <Toolbar label={label} gap={8} wrap style={{ minHeight: ROW, padding: phone ? '8px 0' : '6px 0' }}>
          {docked && title && !phone && <>
            <span data-toolbar-title="" style={{ fontFamily: 'var(--font-heading, "Source Serif 4", serif)', fontWeight: 600, fontSize: 'var(--font-size-md, 16px)',
              lineHeight: 1.2, color: 'var(--text-strong, #111827)', whiteSpace: 'nowrap' }}>{title}</span>
            <ToolbarSeparator style={{ margin: '0 4px', height: 24 }} />
          </>}
          {children}
        </Toolbar>
      </div>}
    </ScrollDock>;
  }

  /* A ghost trigger with a chevron that opens a menu of choices. The menu is as wide as its
     longest row, never narrower than `minWidth` nor wider than 400px or the viewport. */
  function FilterMenu({ open, onOpenChange, icon, label, menuLabel, items, minWidth, width = 'max-content', density, triggerRef }) {
    return <span ref={triggerRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <Button variant="ghost" size="sm" icon={icon} iconRight="bi-chevron-down" expanded={open} hasPopup="menu"
        onClick={() => onOpenChange(!open)}>{label}</Button>
      <Menu open={open} onClose={() => onOpenChange(false)} label={menuLabel} align="start" density={density} items={items}
        width={width} style={{ minWidth, maxWidth: 'min(400px, calc(100vw - 32px))' }} />
    </span>;
  }

  /* The row under the toolbar while the view is narrowed: the count, a removable chip per
     filter and Clear filters. A removed chip takes its focus with it, so focus moves to the
     chip now in its place, else Clear filters, else into `fallbackRef`. With `live` the count
     stays mounted (visually hidden at rest) so every change is spoken. */
  function FilterSummary({ filtered, status, restStatus, live = false, chips = [], onClear, fallbackRef }) {
    const rowRef = React.useRef(null);
    const pendingFocus = React.useRef(null);
    React.useLayoutEffect(() => {
      const want = pendingFocus.current;
      if (want == null) return;
      pendingFocus.current = null;
      const stops = rowRef.current ? [...rowRef.current.querySelectorAll('[data-filter-chip], [data-clear-filters]')] : [];
      const target = typeof want === 'number' && stops.length ? stops[Math.min(want, stops.length - 1)]
        : fallbackRef && fallbackRef.current && fallbackRef.current.querySelector('button, input');
      if (target) target.focus();
    });
    if (!filtered && !live) return null;
    const hidden = DS.visuallyHiddenStyle || { position: 'absolute', width: 1, height: 1, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };
    return <div ref={rowRef} data-active-filters={filtered ? 'on' : 'off'}
      style={filtered ? { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '10px 0 2px' } : { height: 0 }}>
      <span role={live ? 'status' : undefined} aria-live={live ? 'polite' : undefined}
        style={filtered ? { fontSize: 'var(--font-size-dense, 13px)', color: 'var(--text-secondary, #5a6268)' } : hidden}>
        {filtered ? status : restStatus}
      </span>
      {filtered && chips.map((c, i) => <Button key={c.key} data-filter-chip="" variant="secondary" outline size="xs" icon={c.icon} iconRight="bi-x-lg"
        aria-label={`Remove ${c.label} filter`} onClick={() => { pendingFocus.current = i; c.remove(); }}>{c.label}</Button>)}
      {filtered && onClear && <>
        <span aria-hidden="true" style={{ color: 'var(--text-secondary, #5a6268)' }}>·</span>
        <Button data-clear-filters="" variant="link" flush size="xs" onClick={() => { pendingFocus.current = 'fallback'; onClear(); }}>Clear filters</Button>
      </>}
    </div>;
  }

  return { PageToolbar, FilterMenu, FilterSummary };
}
