/* The page toolbar Activity and the Library share — the project-specific layout around the
   design system's filter kit. It sits flat on the canvas under the page heading, docks at the
   scroller's top with a hairline beneath, and once docked leads with the page's title (no count
   beside it; a phone skips the title to keep the bar short). Every control is about 32px in a
   56px row. Filters are DS `FilterMenu`s set shoulder to shoulder in a
   `ToolbarGroup variant="flush"`, and the row beneath is DS `ActiveFilters`; both are composed
   by the screens. The `end` cluster (search, layout, refresh) keeps to the right; when the row
   has no room for a full search field beside it, `ToolbarSearch` folds the DS `SearchField`
   (`collapsed`) to an icon, so the bar stays one row. The fold is measured here because it
   depends on this toolbar's layout: the title, the filters and the end cluster. */
export function createToolbarUI(React, DS) {
  const { ScrollDock, Toolbar, ToolbarSeparator, SearchField } = DS;
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

  /* The toolbar's search: the design system's SearchField as a plain searchbox, up to 260px wide
     (the full row on a phone), folded by the row to an icon that opens the field in a popover
     while it is short of room. Folded with a query applied, the icon fills primary and its
     tooltip quotes the query. */
  function ToolbarSearch({ value = '', onChange, placeholder, label }) {
    const { compact, phone } = React.useContext(SearchFit);
    const field = <SearchField suggest={false} collapsed={compact} popoverWidth={SEARCH_MAX + 24} aria-label={label} placeholder={placeholder}
      value={value} onChange={onChange} style={compact ? undefined : { width: '100%' }} />;
    /* One wrapper element in both forms, so a fold keeps the same SearchField instance and it
       can hand focus (and the caret) to the field that mounts. contain keeps the input's
       intrinsic width out of the cluster's, so the minimum governs. */
    return <div data-toolbar-search="" style={compact ? { display: 'inline-flex' }
      : { flex: `1 1 ${SEARCH_MIN}px`, minWidth: SEARCH_MIN, maxWidth: phone ? 'none' : SEARCH_MAX, contain: 'inline-size' }}>
      {field}
    </div>;
  }

  return { PageToolbar, ToolbarSearch };
}
