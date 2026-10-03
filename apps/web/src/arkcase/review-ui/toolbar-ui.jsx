/* The toolbar Activity and the Library share. It sits flat on the canvas under the
   page heading, docks at the scroller's top with a hairline beneath, and once docked leads
   with the page's title (no count beside it; a phone skips the title to keep the bar short). Every control is about 32px in a 56px row.
   Filters are ghost menu triggers set shoulder to shoulder in a `FilterGroup`. The `end`
   cluster (search, layout, refresh) keeps to the right; when the row has no room for a
   full search field beside it, `ToolbarSearch` folds to an icon that opens the field in a
   popover, so the bar stays one row. Narrowing shows a summary row of removable filters. */
export function createToolbarUI(React, DS) {
  const { Button, IconButton, Input, Menu, Popover, ScrollDock, Toolbar, ToolbarSeparator } = DS;
  const ROW = 56;
  const GAP = 8;
  const SEARCH_MIN = 160;
  const SEARCH_MAX = 260;
  const LINE = '1px solid var(--border-color, #dee2e6)';
  const SearchFit = React.createContext({ compact: false, phone: false });

  /* `onHeight` reports the docked bar's height, hairline included, so the bands and caps
     below can pin directly beneath it whatever height the row wraps to. `top` docks it below
     fixed chrome over a document-scrolled page (the phone's app bar). A sticky dock is a stacking
     context, so on a phone it sits just above the fixed bars (1020) and below sheets and dialogs
     (1040+): its filter menus open as bottom sheets, which must clear the tab bar. */
  function PageToolbar({ title, label, gutter = 20, phone = false, top = 0, onHeight, end, children }) {
    return <ScrollDock surface="var(--surface-canvas, #f1f5f7)" bleed={gutter} zIndex={phone ? 1030 : 4} top={top}
      style={{ borderBottom: '1px solid transparent' }} dockedStyle={{ borderBottom: LINE }}>
      {({ docked }) => <ToolbarRow title={docked && !phone ? title : null} label={label} phone={phone} onHeight={onHeight} end={end}>{children}</ToolbarRow>}
    </ScrollDock>;
  }

  /* The search folds when what precedes the end cluster leaves less than a minimum-width
     field plus the cluster's other controls. Neither side depends on the fold, so it settles
     in one pass; it is re-measured on every render (a docked title, a longer filter label)
     and on resize. */
  function ToolbarRow({ title, label, phone, onHeight, end, children }) {
    const rowRef = React.useRef(null);
    const endRef = React.useRef(null);
    const [compact, setCompact] = React.useState(false);
    const measure = React.useCallback(() => {
      const cluster = endRef.current;
      const bar = cluster && cluster.parentElement;
      if (!cluster || !bar || phone) { setCompact(false); return; }
      const lead = cluster.previousElementSibling;
      const used = lead ? lead.getBoundingClientRect().right - bar.getBoundingClientRect().left + GAP : 0;
      const others = [...cluster.children].filter((el) => !el.hasAttribute('data-toolbar-search'));
      const need = others.reduce((sum, el) => sum + el.getBoundingClientRect().width + GAP, 0) + SEARCH_MIN;
      setCompact(bar.clientWidth - used < need);
    }, [phone]);
    React.useLayoutEffect(measure);
    React.useLayoutEffect(() => {
      const row = rowRef.current;
      if (!row) return undefined;
      const report = () => { measure(); onHeight?.(Math.round(row.getBoundingClientRect().height) + 1); };
      report();
      if (typeof ResizeObserver === 'undefined') return undefined;
      const observer = new ResizeObserver(report);
      observer.observe(row);
      return () => observer.disconnect();
    }, [onHeight, measure]);
    return <div ref={rowRef}>
      <Toolbar label={label} gap={GAP} wrap style={{ minHeight: ROW, padding: phone ? '8px 0' : '6px 0' }}>
        {title && <>
          <span data-toolbar-title="" style={{ fontFamily: 'var(--font-heading, "Source Serif 4", serif)', fontWeight: 600, fontSize: 'var(--font-size-md, 16px)',
            lineHeight: 1.2, color: 'var(--text-strong, #111827)', whiteSpace: 'nowrap' }}>{title}</span>
          <ToolbarSeparator style={{ margin: '0 4px', height: 24 }} />
        </>}
        {children}
        {end && <div ref={endRef} data-toolbar-end="" style={{ display: 'flex', alignItems: 'center', gap: GAP, marginLeft: 'auto', justifyContent: 'flex-end',
          flex: phone ? '1 1 100%' : '1 1 0px' }}>
          <SearchFit.Provider value={{ compact, phone }}>{end}</SearchFit.Provider>
        </div>}
      </Toolbar>
    </div>;
  }

  /* The toolbar's search: a field up to 260px wide (the full row on a phone), or, while the row is short of room, an
     icon that opens the field in a popover. Folded with a query applied, the icon fills
     primary and its tooltip quotes the query. */
  function ToolbarSearch({ value = '', onChange, placeholder, label }) {
    const { compact, phone } = React.useContext(SearchFit);
    const [open, setOpen] = React.useState(false);
    const field = (extra) => <Input icon="bi-search" size="sm" type="search" placeholder={placeholder} aria-label={label}
      value={value} onChange={onChange} {...extra} />;
    if (!compact) {
      // contain keeps the input's intrinsic width out of the cluster's, so the minimum governs.
      return <div data-toolbar-search="" style={{ flex: `1 1 ${SEARCH_MIN}px`, minWidth: SEARCH_MIN, maxWidth: phone ? 'none' : SEARCH_MAX, contain: 'inline-size' }}>
        {field({ style: { width: '100%' } })}
      </div>;
    }
    const active = String(value).trim().length > 0;
    return <span data-toolbar-search="" style={{ display: 'inline-flex' }}>
      <Popover open={open} onOpenChange={setOpen} label={label} placement="bottom-end" width={SEARCH_MAX + 24}
        contentStyle={{ padding: 12 }}
        trigger={<IconButton icon="bi-search" size="sm" variant={active ? 'primary' : 'ghost'} ariaLabel={label}
          title={active ? `${label}: \u201c${value}\u201d` : label} />}>
        {field({ autoFocus: true, style: { width: '100%' } })}
      </Popover>
    </span>;
  }

  /* Adjacent filter menus with no gap between them: the ghost triggers' own padding spaces
     them. The group keeps its width and wraps inside itself only when wider than the row; on a
     phone it is one row that scrolls sideways instead (its menus open as sheets, so nothing is
     clipped by the scrolling row). */
  function FilterGroup({ label, phone = false, children }) {
    return <div role="group" aria-label={label} data-filter-group={phone ? 'scroll' : 'wrap'}
      style={phone
        ? { display: 'flex', flexWrap: 'nowrap', alignItems: 'center', flex: '1 1 100%', minWidth: 0, maxWidth: '100%', overflowX: 'auto',
          overscrollBehaviorX: 'contain', scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch', padding: '2px 0' }
        : { display: 'flex', flexWrap: 'wrap', alignItems: 'center', flexShrink: 0, maxWidth: '100%' }}>{children}</div>;
  }

  /* A ghost trigger with a chevron that opens a menu of choices. The menu is as wide as its
     longest row, never narrower than `minWidth` nor wider than 400px or the viewport. On a
     phone (`presentation="sheet"`) it is the Menu's bottom sheet. */
  function FilterMenu({ open, onOpenChange, icon, label, menuLabel, items, minWidth, width = 'max-content', density, triggerRef, presentation = 'popover' }) {
    const sheet = presentation === 'sheet';
    return <span ref={triggerRef} style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}>
      <Button variant="ghost" size="sm" icon={icon} iconRight="bi-chevron-down" expanded={open} hasPopup="menu"
        onClick={() => onOpenChange(!open)} style={sheet ? { whiteSpace: 'nowrap' } : undefined}>{label}</Button>
      <Menu open={open} onClose={() => onOpenChange(false)} label={menuLabel} align="start" density={sheet ? 'comfortable' : density} items={items}
        presentation={presentation} width={sheet ? undefined : width} style={sheet ? undefined : { minWidth, maxWidth: 'min(400px, calc(100vw - 32px))' }} />
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

  return { PageToolbar, FilterGroup, FilterMenu, FilterSummary, ToolbarSearch };
}
