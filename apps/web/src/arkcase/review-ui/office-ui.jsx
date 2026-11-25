/* Office viewers: how Review draws a Branding Center page — a Word document, an Excel workbook or a
   PowerPoint deck — inside its preview frame. Each is the published HTML edition's own viewer.
   Review owns everything around it (the toolbar, the inspector, annotate mode), so a viewer has no
   header, navigation, downloads or comments, and its page, sheet and slide state stays inside it:
   it never pushes browser history.

   The viewer fills the frame and scrolls its paper inside it. Its few controls ride in one floating
   pill at the foot of the document, as in Figma: the panel toggle, paging (Excel: the sheet),
   zoom, and a View menu for the occasional options. Panels and reference aids start closed. The
   pill dims while the reader scrolls and returns on hover or focus.

   The host's pins and pick layer arrive as `overlay` and are laid over the paper itself, so they
   stay on the document at any zoom or scroll. The fixture carries no document contents: the paper
   shows the family's layout with the template's title and placeholder copy in brackets. Paper and
   slides stay white in every theme. */

const DATA = { fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)' };
const HEADING = { fontFamily: 'var(--font-heading, "Source Serif 4", Georgia, serif)', fontWeight: 600 };
const PAPER_INK = 'var(--text-body, #212529)';
const PAPER_MUTED = 'var(--text-secondary, #5A6268)';
const NAVY = 'var(--text-navy, #073652)';
const RULE = '1px solid var(--border-color, #DEE2E6)';
const PAPER_SHADOW = 'var(--shadow-md, 0 4px 12px rgba(7,54,82,.12))';
/* Room the pill needs below the paper, so the last line can scroll clear of it. */
const PILL_CLEARANCE = 72;
/* Below this width the pill drops zoom: the paper is already fitted to the column. */
const NARROW = 560;

export function createOfficeUI(React, DS) {
  const { IconButton, Pager, ZoomControl, PageThumbnails, Select, Menu, Toolbar, ToolbarSeparator,
    WorksheetMock, SlideMock, SlideWireframe, BrandLock, useElementSize, fitZoom } = DS;
  const { useState, useRef, useEffect, useLayoutEffect } = React;

  /** The percent that fits `natural` px into `available` px, within `min` and `max` (100 before a first measurement). */
  const fitPercent = (available, natural, max = 100, min = 25) => fitZoom(available, natural, { min, max, round: 'floor' });

  /** The viewer's frame: an optional start panel, the scrolling document column with the pill
      floating over its foot, and an optional end panel. */
  function ViewerShell({ viewer, label, start, end, top, pill, scrollRef, onScroll, children }) {
    return <div data-viewer={viewer} role="region" aria-label={label}
      style={{ position: 'relative', flex: '1 1 auto', display: 'flex', minHeight: 520, height: '100%', minWidth: 0, background: 'var(--surface-tertiary, #E9ECEF)' }}>
      {start}
      <div style={{ position: 'relative', flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {top}
        <div ref={scrollRef} onScroll={onScroll} style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>{children}</div>
        {pill}
      </div>
      {end}
    </div>;
  }

  /** The floating pill: the design system's `Toolbar placement="floating"` (arrow keys move
      between its controls), quiet while the column scrolls. Groups are separated by a hairline. */
  function Pill({ label, quiet, children }) {
    const groups = React.Children.toArray(children).filter(Boolean);
    return <Toolbar label={label} placement="floating" quiet={quiet}>
      {groups.map((group, i) => <React.Fragment key={i}>
        {i > 0 ? <ToolbarSeparator style={{ margin: '0 2px' }} /> : null}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flex: 'none' }}>{group}</span>
      </React.Fragment>)}
    </Toolbar>;
  }

  /** View: the occasional options as checkable items in a menu that opens above the pill. */
  function ViewMenu({ items }) {
    const [open, setOpen] = useState(false);
    const anchor = useRef(null);
    return <>
      <span ref={anchor} style={{ display: 'inline-flex' }}>
        <IconButton icon="bi-sliders" size="sm" ariaLabel="View options" title="View options" hasPopup="menu" expanded={open} onClick={() => setOpen(!open)} />
      </span>
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor.current} placement="top" align="end" label="View options" width={220} zIndex={1200}
        items={items.map((item) => (item.heading || item.divider ? item : { ...item, keepOpen: true }))} />
    </>;
  }

  /** Scrolling marks the pill quiet for a moment. */
  function useQuiet() {
    const [quiet, setQuiet] = useState(false);
    const timer = useRef(0);
    useEffect(() => () => clearTimeout(timer.current), []);
    return [quiet, () => { setQuiet(true); clearTimeout(timer.current); timer.current = setTimeout(() => setQuiet(false), 900); }];
  }

  /* The page, sheet or slide shown. A host that passes `part` owns it, so its pins can follow the
     printed page they were placed on; otherwise the viewer keeps its own, as before. */
  const usePart = (part, onPartChange, initial) => {
    const [own, setOwn] = useState(initial);
    return [part != null ? part : own, (next) => { setOwn(next); if (onPartChange) onPartChange(next); }];
  };
  /** Pins and the pick layer, over the paper's own box. */
  const Overlay = ({ children, height }) => (children ? <div style={{ position: 'absolute', left: 0, right: 0, top: 0, ...(height ? { height } : { bottom: 0 }) }}>{children}</div> : null);
  const zoomValue = (zoom, fitted) => (zoom.fit ? fitted : zoom.zoom);

  /* ---- Word: Letter paper at 680 × 880; thumbnails on demand; Margins and Regions in View. */
  function DocumentViewer({ title, category, format = 'DOCX', overlay, part, onPartChange }) {
    const [page, setPage] = usePart(part, onPartChange, 0);
    const [showPages, setShowPages] = useState(false);
    const [showMargins, setShowMargins] = useState(false);
    const [showRegions, setShowRegions] = useState(false);
    const [zoom, setZoom] = useState({ zoom: null, fit: 'width' });
    const [quiet, settle] = useQuiet();
    const columnRef = useRef(null);
    const column = useElementSize(columnRef);
    // Fit width fills the column (up to 150%); fit page keeps the whole sheet in view.
    const widthFit = fitPercent(column.width - 48, 680, 150);
    const pageFit = Math.min(widthFit, fitPercent(column.height - 48 - PILL_CLEARANCE, 880, 150));
    const percent = zoomValue(zoom, zoom.fit === 'page' ? pageFit : widthFit);
    const region = showRegions ? { outline: '1px dashed var(--bs-primary, #0079A8)', outlineOffset: 3 } : null;
    const line = (width, fill) => <span style={{ display: 'block', width, height: 2, marginTop: 3, background: fill || 'var(--bs-gray-400, #CED4DA)' }} />;
    const mini = () => <div data-theme="default" style={{ padding: 6, display: 'flex', flexDirection: 'column' }}>
      <span style={{ display: 'block', width: 22, height: 4, background: NAVY }} />
      {line('100%', 'var(--bs-primary, #0079A8)')}{line('60%')}{line('100%')}{line('100%')}{line('80%')}{line('100%')}{line('70%')}
    </div>;
    const thumbs = [1, 2].map((n) => ({ id: 'p' + n, label: 'Page ' + n, aspect: 8.5 / 11, render: mini }));
    const para = (text, key) => <p key={key} style={{ margin: 0 }}>{text}</p>;
    const narrow = column.width > 0 && column.width < NARROW;
    return <ViewerShell viewer="word" label="Document" scrollRef={columnRef} onScroll={settle}
      start={showPages ? <nav aria-label="Pages" style={{ flex: '0 0 120px', padding: 12, boxSizing: 'border-box', overflowY: 'auto',
        background: 'var(--surface-secondary, #F8F9FA)', borderRight: RULE }}>
        <PageThumbnails label="Pages" items={thumbs} currentId={'p' + (page + 1)} onSelect={(id) => setPage(id === 'p2' ? 1 : 0)} />
      </nav> : null}
      pill={<Pill label="Document controls" quiet={quiet}>
        <IconButton icon="bi-layout-sidebar-inset" size="sm" ariaLabel="Page thumbnails" title="Page thumbnails" pressed={showPages} onClick={() => setShowPages(!showPages)} />
        <Pager label="Page navigation" itemNoun="page" wrap={false} index={page} total={2} onPrevious={setPage} onNext={setPage}
          {...(narrow ? {} : { jump: { label: 'Page' }, onJump: setPage })} />
        {narrow ? null : <ZoomControl size="viewer" zoom={zoom.zoom} fit={zoom.fit} computed={percent} max={300}
          modes={[{ value: 'width', label: 'Fit width' }, { value: 'page', label: 'Fit page' }]} onChange={setZoom} />}
        <ViewMenu items={[
          { type: 'checkbox', label: 'Margins', icon: 'bi-square', checked: showMargins, onClick: () => setShowMargins(!showMargins) },
          { type: 'checkbox', label: 'Regions', icon: 'bi-bounding-box', checked: showRegions, onClick: () => setShowRegions(!showRegions) },
        ]} />
      </Pill>}>
      <div style={{ padding: `24px 24px ${PILL_CLEARANCE}px`, display: 'flex' }}>
        {/* Auto margins centre the page and, unlike centring, never clip it when it is wider. */}
        <div style={{ position: 'relative', margin: '0 auto', flex: 'none' }}>
          <article id={'page-' + (page + 1)} data-region={'page-' + (page + 1)} data-theme="default" aria-label={'Page ' + (page + 1)}
            style={{ zoom: percent / 100, position: 'relative', width: 680, minHeight: 880, boxSizing: 'border-box', padding: '56px 64px 40px',
              display: 'flex', flexDirection: 'column', gap: 20, background: 'var(--surface-card, #fff)', color: PAPER_INK,
              boxShadow: PAPER_SHADOW, fontFamily: 'var(--font-body, "Public Sans", sans-serif)' }}>
            {showMargins ? <div aria-hidden="true" style={{ position: 'absolute', left: 64, right: 64, top: 56, bottom: 40,
              border: '1px dashed var(--bs-gray-500, #ADB5BD)', pointerEvents: 'none' }} /> : null}
            <header id="document-masthead" data-region="masthead" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, ...region }}>
              <BrandLock tone="ink" size={22} />
              <div id="document-address" data-region="address-block" style={{ textAlign: 'right', fontSize: 12, lineHeight: 1.5, color: PAPER_MUTED }}>
                [Office Name]<br />[Street Address]<br />[City, State ZIP]
              </div>
            </header>
            <div aria-hidden="true" style={{ height: 2, background: 'var(--bs-primary, #0079A8)' }} />
            {page === 0 ? <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontSize: 14, lineHeight: 1.6 }}>
              <span id="document-category" data-region="category" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: PAPER_MUTED, ...region }}>{category}</span>
              <h2 id="document-title" data-region="title" style={{ ...HEADING, margin: 0, fontSize: 26, lineHeight: 1.25, color: NAVY, ...region }}>{title}</h2>
              <span id="document-date" data-region="date" style={{ ...DATA, fontSize: 13, color: 'var(--text-data, #495057)' }}>[MM/DD/YYYY] · Version [N.N]</span>
              <div id="document-body" data-region="body" style={{ display: 'flex', flexDirection: 'column', gap: 16, ...region }}>
                {para('[Opening paragraph. State the purpose in the first sentence. Body copy is Public Sans on a 1.5 line height, flush left, with one blank line between paragraphs.]', 1)}
                {para('[Second paragraph. Give the detail the reader needs to act. Keep paragraphs to four or five lines.]', 2)}
                {para('[Closing paragraph. Say what happens next and who to contact.]', 3)}
              </div>
            </div> : <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontSize: 14, lineHeight: 1.6 }}>
              <span id="document-running-head" data-region="running-head" style={{ fontSize: 12, color: PAPER_MUTED, ...region }}>{title} · Page 2</span>
              {para('[Continuation pages carry the small running head above in place of the address block. The logo stays; the rule stays.]', 1)}
              {para('[Continue the body copy here.]', 2)}
            </div>}
            <footer id="document-footer" data-region="footer" style={{ marginTop: 'auto', paddingTop: 12, borderTop: RULE,
              display: 'flex', justifyContent: 'space-between', fontSize: 11, color: PAPER_MUTED, ...region }}>
              <span>[Office Name] · [Phone] · [Web Address]</span>
              <span style={DATA}>{format} · {page + 1} / 2</span>
            </footer>
          </article>
          <Overlay>{overlay}</Overlay>
        </div>
      </div>
    </ViewerShell>;
  }

  /* ---- Excel: the sheet fills the column edge to edge; the sheet picker replaces the tab bar.
     Gridlines, row density, the formula bar and Cell Styles are View options. */
  const B = { kind: 'blank' };
  const pill = (tone, label) => ({ value: { pill: { tone, label } } });
  const money = (kind = 'input') => ({ value: '0.00', kind, align: 'right' });
  const sheetsFor = (title, name) => ({
    main: { label: name, caption: name + ' worksheet', cellRef: 'D11', formula: '=SUM(D5:D10)',
      columns: [{ letter: 'A', width: 22 }, { letter: 'B', width: '30%' }, 'C', 'D', 'E', 'F'],
      rows: [
        { cells: [B, { value: title, kind: 'title', colSpan: 5 }] },
        { cells: [B, { value: '[Programme] · as of [MM/DD/YYYY] · amounts in USD', kind: 'subtitle', colSpan: 5 }] },
        { cells: [B, B, B, B, B, B] },
        { cells: [B, { value: 'Item', kind: 'header' }, { value: 'Category', kind: 'header' }, { value: 'Planned', kind: 'header', align: 'right' },
          { value: 'Actual', kind: 'header', align: 'right' }, { value: 'Status', kind: 'header' }] },
        { cells: [B, '[Item]', '[Category]', money(), money('data'), pill('success', 'On Track')] },
        { kind: 'stripe', cells: [B, '[Item]', '[Category]', money(), money('data'), pill('success', 'On Track')] },
        { cells: [B, '[Item]', '[Category]', money(), { value: '(0.00)', kind: 'negative', align: 'right' }, pill('danger', 'Over')] },
        { kind: 'stripe', cells: [B, '[Item]', '[Category]', money(), money('data'), pill('warning', 'Watch')] },
        { cells: [B, '[Item]', '[Category]', money(), money('data'), pill('success', 'On Track')] },
        { kind: 'stripe', cells: [B, '[Item]', '[Category]', money(), money('data'), pill('neutral', 'Not Started')] },
        { cells: [B, { value: 'Total', kind: 'total' }, { value: '', kind: 'total' }, { value: '0.00', kind: 'total', align: 'right' },
          { value: '0.00', kind: 'total', align: 'right' }, { value: '', kind: 'total' }] },
        { cells: [B, B, B, B, B, B] },
        { cells: [B, { value: 'Amber cells are inputs. Totals and status calculate from them.', kind: 'note', colSpan: 5 }] },
      ] },
    inputs: { label: 'Inputs', caption: 'Inputs worksheet', cellRef: 'C5', formula: '1.03',
      columns: [{ letter: 'A', width: 22 }, { letter: 'B', width: '40%' }, 'C', { letter: 'D', width: '35%' }],
      rows: [
        { cells: [B, { value: 'Inputs', kind: 'title', colSpan: 3 }] },
        { cells: [B, B, B, B] },
        { cells: [B, { value: 'Assumption', kind: 'header' }, { value: 'Value', kind: 'header', align: 'right' }, { value: 'Source', kind: 'header' }] },
        { cells: [B, { value: '[Rate]', kind: 'label' }, { value: '1.03', kind: 'input', align: 'right' }, { value: '[Source]', kind: 'note' }] },
        { kind: 'stripe', cells: [B, { value: '[Contingency]', kind: 'label' }, { value: '10%', kind: 'input', align: 'right' }, { value: '[Source]', kind: 'note' }] },
        { cells: [B, { value: '[Linked value]', kind: 'label' }, { value: '0.00', kind: 'linked', align: 'right' }, { value: 'Linked from ' + name + '!D11', kind: 'note' }] },
      ] },
    readme: { label: 'Read Me', caption: 'Read Me worksheet', cellRef: 'B3', formula: 'How to use this workbook',
      columns: [{ letter: 'A', width: 22 }, { letter: 'B', width: '90%' }],
      rows: [
        { cells: [B, { value: 'Read Me', kind: 'title' }] },
        { cells: [B, B] },
        { cells: [B, { value: 'How to use this workbook', kind: 'section' }] },
        { cells: [B, { value: '1. Enter values only in **amber input cells**.', kind: 'wrap' }] },
        { kind: 'stripe', cells: [B, { value: '2. Set the inputs before you fill the ' + name + ' sheet.', kind: 'wrap' }] },
        { cells: [B, { value: '3. Do not rename sheets: formulas reference them by name.', kind: 'wrap' }] },
      ] },
  });
  const LEGEND = [
    { name: 'Header', use: 'Column titles', fill: 'var(--surface-header, #073652)', top: RULE },
    // The Excel specimen's input fill, as WorksheetMock paints it; a document colour, not a UI token.
    { name: 'Input', use: 'Values people type', fill: '#FFF4D6', top: RULE },
    { name: 'Linked', use: 'From another sheet', fill: 'var(--pill-success-bg, #D1E7DD)', top: RULE },
    { name: 'Stripe', use: 'Every second row', fill: 'var(--surface-secondary, #F8F9FA)', top: RULE },
    { name: 'Total', use: 'Sums, navy rule', fill: 'var(--surface-canvas, #F1F5F7)', top: '2px solid var(--surface-header, #073652)' },
  ];

  function SpreadsheetViewer({ title, name, overlay, part, onPartChange }) {
    const sheets = sheetsFor(title, name);
    const order = ['main', 'inputs', 'readme'];
    const [sheet, setSheet] = usePart(part, onPartChange, 'main');
    const [gridlines, setGridlines] = useState(true);
    const [showFormula, setShowFormula] = useState(false);
    const [compact, setCompact] = useState(false);
    const [showStyles, setShowStyles] = useState(false);
    const [zoom, setZoom] = useState({ zoom: null, fit: 'width' });
    const [quiet, settle] = useQuiet();
    const columnRef = useRef(null);
    const column = useElementSize(columnRef);
    const s = sheets[sheet];
    // The sheet is fluid: fit width is 100%, and it scrolls sideways only below 720px.
    const percent = zoomValue(zoom, 100);
    /* As in a workbook, empty gridded rows continue down to the pill rather than ending in grey.
       The sheet measures where its authored rows end: pins sit on those rows, never on the filler. */
    const sectionRef = useRef(null);
    const [measured, setMeasured] = useState({ authored: 0, row: compact ? 21 : 22, head: 22 });
    const filler = Math.max(0, Math.floor((column.height / (percent / 100) - PILL_CLEARANCE - measured.head) / measured.row) - s.rows.length);
    const rows = s.rows.concat(Array.from({ length: filler }, () => ({ cells: s.columns.map(() => B) })));
    useLayoutEffect(() => {
      const table = sectionRef.current && sectionRef.current.querySelector('table');
      const body = table ? table.querySelectorAll('tbody tr') : [];
      if (!body.length) return;
      const last = body[Math.min(s.rows.length, body.length) - 1];
      const next = { authored: table.offsetTop + last.offsetTop + last.offsetHeight, row: body[0].offsetHeight || measured.row, head: body[0].offsetTop || measured.head };
      if (next.authored !== measured.authored || next.row !== measured.row || next.head !== measured.head) setMeasured(next);
    });
    const narrow = column.width > 0 && column.width < NARROW;
    return <ViewerShell viewer="excel" label="Workbook" scrollRef={columnRef} onScroll={settle}
      top={showFormula ? <div style={{ display: 'flex', alignItems: 'stretch', minHeight: 30, background: 'var(--surface-card, #fff)', borderBottom: RULE }}>
        <div style={{ ...DATA, flex: '0 0 64px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRight: RULE, fontSize: 13, color: 'var(--text-data, #495057)' }}>{s.cellRef}</div>
        <div aria-hidden="true" style={{ ...HEADING, fontWeight: 400, fontStyle: 'italic', flex: '0 0 36px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRight: RULE, fontSize: 14, color: PAPER_MUTED }}>fx</div>
        <div aria-label="Formula" style={{ ...DATA, flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', padding: '0 12px', fontSize: 13, color: 'var(--text-data, #495057)', overflowX: 'auto', whiteSpace: 'nowrap' }}>{s.formula}</div>
      </div> : null}
      end={showStyles ? <aside aria-label="Cell styles" style={{ flex: '0 0 220px', overflowY: 'auto', background: 'var(--surface-card, #fff)', borderLeft: RULE }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 6px 6px 14px', background: 'var(--surface-secondary, #F8F9FA)', borderBottom: RULE }}>
          <h2 style={{ margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: PAPER_MUTED, fontFamily: 'inherit' }}>Cell Styles</h2>
          <IconButton icon="bi-x-lg" size="xs" ariaLabel="Close cell styles" onClick={() => setShowStyles(false)} />
        </div>
        <ul style={{ listStyle: 'none', margin: 0, padding: '6px 14px', display: 'flex', flexDirection: 'column' }}>
          {LEGEND.map((l) => <li key={l.name} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--list-divider, #E9ECEF)' }}>
            <span aria-hidden="true" data-theme="default" style={{ flex: '0 0 auto', width: 36, height: 20, borderRadius: 3, border: RULE, background: l.fill, borderTop: l.top }} />
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-emphasis, #374151)' }}>{l.name}</span>
              <span style={{ fontSize: 12, color: PAPER_MUTED }}>{l.use}</span>
            </span>
          </li>)}
        </ul>
      </aside> : null}
      pill={<Pill label="Workbook controls" quiet={quiet}>
        <Select size="viewer" fit="selected" aria-label="Sheet" value={sheet} options={order.map((id) => ({ value: id, label: sheets[id].label }))}
          onChange={(e) => setSheet(e && e.target ? e.target.value : e)} />
        {narrow ? null : <ZoomControl size="viewer" zoom={zoom.zoom} fit={zoom.fit} computed={percent} max={200} modes={[{ value: 'width', label: 'Fit width' }]} onChange={setZoom} />}
        <ViewMenu items={[
          { type: 'checkbox', label: 'Formula bar', icon: 'bi-braces', checked: showFormula, onClick: () => setShowFormula(!showFormula) },
          { type: 'checkbox', label: 'Gridlines', icon: 'bi-grid-3x3', checked: gridlines, onClick: () => setGridlines(!gridlines) },
          { type: 'checkbox', label: 'Compact rows', icon: 'bi-list', checked: compact, onClick: () => setCompact(!compact) },
          { divider: true },
          { type: 'checkbox', label: 'Cell styles', icon: 'bi-layout-sidebar-inset-reverse', checked: showStyles, onClick: () => setShowStyles(!showStyles) },
        ]} />
      </Pill>}>
      <div style={{ paddingBottom: PILL_CLEARANCE }}>
        <section ref={sectionRef} id={'sheet-' + sheet} data-region={'sheet-' + sheet} data-theme="default" aria-label={s.caption}
          style={{ zoom: percent / 100, position: 'relative', minWidth: 720, background: 'var(--surface-card, #fff)', borderBottom: RULE }}>
          <WorksheetMock density={compact ? 'compact' : 'comfortable'} gridlines={gridlines} caption={s.caption} columns={s.columns} rows={rows} />
          <Overlay height={measured.authored || undefined}>{overlay}</Overlay>
        </section>
      </div>
    </ViewerShell>;
  }

  /* ---- PowerPoint: the slide fits the column's width and height; a thumbnail rail on demand;
     speaker notes under the slide; Safe Area and the slide sorter in View. */
  const LAYOUTS = ['title', 'statement', 'agenda', 'divider', 'content', 'two-column', 'table', 'chart', 'big-number', 'metrics', 'image', 'closing'];
  /* A deck opens on its title slide; a layout template's own layout is the second slide, named for it. */
  const layoutName = (layout) => layout.charAt(0).toUpperCase() + layout.slice(1).replace(/-/g, ' ');
  const deckFor = (title, layout) => [
    { layout: 'title', title: 'Title', caption: 'Navy. Kicker, deck title, audience and date.', notes: 'Open with the period and audience. The title slide carries no footer and no slide number.' },
    { layout: layout && layout !== 'title' && layout !== 'closing' ? layout : 'content', title: layout && layout !== 'title' && layout !== 'closing' ? layoutName(layout) : 'Content',
      caption: 'White. Takeaway title, up to five points.',
      notes: 'The title states the finding as a sentence. Points support it; cite the source on the line above the footer.' },
    { layout: 'big-number', title: 'Big number', caption: 'One figure with its label and change.', notes: 'Use for the one measure the audience should remember. The figure sits in the data face in brand primary.' },
    { layout: 'closing', title: 'Closing', caption: 'Navy. Questions and a contact.', notes: 'Close on the contact for follow-up. Keep the closing slide free of new content.' },
  ];
  const navyTop = { kickerTop: 278, titleTop: 318, titleHeight: 166, ruleTop: 252 };
  /* The slide's 100% width; the 16:9 slide is 540px tall there. */
  const SLIDE_WIDTH = 960;

  function PresentationViewer({ title, category, layout, overlay, part, onPartChange }) {
    const slides = deckFor(title, LAYOUTS.includes(layout) ? layout : layout === 'full-bleed-image' ? 'image' : null);
    const [slide, setSlide] = usePart(part, onPartChange, 0);
    const [showRail, setShowRail] = useState(true);
    const [showNotes, setShowNotes] = useState(false);
    const [sorter, setSorter] = useState(false);
    const [showSafe, setShowSafe] = useState(false);
    const [zoom, setZoom] = useState({ zoom: null, fit: 'page' });
    const [quiet, settle] = useQuiet();
    const columnRef = useRef(null);
    const column = useElementSize(columnRef);
    // Fit slide keeps the whole slide above the pill; fit width fills the column.
    const widthFit = fitPercent(column.width - 48, SLIDE_WIDTH, 200);
    const slideFit = Math.min(widthFit, fitPercent((column.height - 24 - PILL_CLEARANCE) * (16 / 9), SLIDE_WIDTH, 200));
    const percent = zoomValue(zoom, zoom.fit === 'width' ? widthFit : slideFit);
    const current = slides[slide];
    const narrow = column.width > 0 && column.width < NARROW;
    const tile = (s, k, onPick, inRail) => <button key={k} type="button" onClick={onPick} aria-label={'Slide ' + (k + 1) + ', ' + s.title}
      aria-current={k === slide ? 'true' : undefined}
      style={{ all: 'unset', boxSizing: 'border-box', cursor: 'pointer', display: 'grid', gridTemplateColumns: inRail ? '14px minmax(0, 1fr)' : 'minmax(0, 1fr)',
        gap: 6, alignItems: 'start', padding: 4, borderRadius: 5,
        background: k === slide ? 'var(--surface-card, #fff)' : 'transparent', boxShadow: k === slide ? 'inset 0 0 0 2px var(--bs-primary, #0079A8)' : 'none' }}>
      {inRail ? <span style={{ ...DATA, fontSize: 11, textAlign: 'right', paddingTop: 2, color: k === slide ? 'var(--text-link, #0079A8)' : PAPER_MUTED }}>{k + 1}</span> : null}
      {/* The rail shows the slide alone; the sorter adds its layout note. */}
      <span data-theme="default" style={{ display: 'block', pointerEvents: 'none' }}>
        <SlideWireframe layout={s.layout} title={inRail ? undefined : s.title}>{inRail ? null : s.caption}</SlideWireframe>
      </span>
      {inRail ? null : <span style={{ ...DATA, fontSize: 12, color: k === slide ? 'var(--text-link, #0079A8)' : PAPER_MUTED }}>Slide {k + 1}</span>}
    </button>;
    const footer = '[Office Name] · ' + title;
    const source = 'Source: [System or report], extracted [MM/DD/YYYY]';
    return <ViewerShell viewer="powerpoint" label="Deck" scrollRef={columnRef} onScroll={settle}
      start={showRail && !sorter ? <nav aria-label="Slides" style={{ flex: '0 0 132px', padding: 10, boxSizing: 'border-box', overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--surface-secondary, #F8F9FA)', borderRight: RULE }}>
        {slides.map((s, k) => tile(s, k, () => setSlide(k), true))}
      </nav> : null}
      pill={<Pill label="Deck controls" quiet={quiet}>
        {sorter ? null : <IconButton icon="bi-layout-sidebar-inset" size="sm" ariaLabel="Slide rail" title="Slide rail" pressed={showRail} onClick={() => setShowRail(!showRail)} />}
        <Pager label="Slide navigation" itemNoun="slide" wrap={false} index={slide} total={slides.length} onPrevious={setSlide} onNext={setSlide} />
        {narrow || sorter ? null : <ZoomControl size="viewer" zoom={zoom.zoom} fit={zoom.fit} computed={percent} max={200}
          modes={[{ value: 'page', label: 'Fit slide' }, { value: 'width', label: 'Fit width' }]} onChange={setZoom} />}
        <>
          {sorter ? null : <IconButton icon="bi-card-text" size="sm" ariaLabel="Speaker notes" title="Speaker notes" pressed={showNotes} onClick={() => setShowNotes(!showNotes)} />}
          <ViewMenu items={[
            { type: 'checkbox', label: 'Slide sorter', icon: 'bi-grid', checked: sorter, onClick: () => setSorter(!sorter) },
            { type: 'checkbox', label: 'Safe area', icon: 'bi-bounding-box', checked: showSafe, disabled: sorter, onClick: () => setShowSafe(!showSafe) },
          ]} />
        </>
      </Pill>}>
      {sorter ? <div role="group" aria-label="Slide sorter" style={{ padding: `24px 24px ${PILL_CLEARANCE}px`, display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))', gap: 16, maxWidth: 1100, margin: '0 auto' }}>
        {slides.map((s, k) => tile(s, k, () => { setSlide(k); setSorter(false); }, false))}
      </div> : <div style={{ padding: `24px 24px ${PILL_CLEARANCE}px`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <section id={'slide-' + (slide + 1)} data-region={'slide-' + (slide + 1)} data-theme="default" aria-label={'Slide ' + (slide + 1) + ', ' + current.title}
          style={{ position: 'relative', flex: 'none', width: SLIDE_WIDTH * (percent / 100), boxShadow: PAPER_SHADOW }}>
          {slide === 0 ? <SlideMock scale="fit" tone="navy" kicker={category} title={title} titleSize="deck" {...navyTop}>
            <div style={{ position: 'absolute', left: 96, top: 520, fontSize: 24, lineHeight: 1.4, color: 'var(--text-on-navy-secondary, rgba(255,255,255,0.86))' }}>[Audience] · [Presenter Name]<br />[MM/DD/YYYY]</div>
          </SlideMock> : slide === 1 ? <SlideMock scale="fit" kicker="Where the work stands" title="[One sentence that states the finding]" source={source} footer={footer} number="02">
            <ul style={{ margin: 0, padding: '0 0 0 30px', display: 'flex', flexDirection: 'column', gap: 18, fontSize: 26, lineHeight: 1.35, color: PAPER_INK }}>
              <li>[First supporting point, one line]</li><li>[Second supporting point, one line]</li><li>[Third supporting point, one line]</li>
            </ul>
          </SlideMock> : slide === 2 ? <SlideMock scale="fit" kicker="Key measure" title="[What the number shows]" source={source} footer={footer} number="03">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span style={{ ...DATA, fontSize: 128 /* type-scale: document — the slide's own key figure */, fontWeight: 600, lineHeight: 1, color: 'var(--bs-primary, #0079A8)' }}>[00%]</span>
              <span style={{ fontSize: 28, color: PAPER_INK }}>[Label for the figure]</span>
              <span style={{ fontSize: 22, color: PAPER_MUTED }}>[Change from last period]</span>
            </div>
          </SlideMock> : <SlideMock scale="fit" tone="navy" kicker="Next steps" title="Questions" titleSize="display" {...navyTop}>
            <div style={{ position: 'absolute', left: 96, top: 520, fontSize: 24, lineHeight: 1.4, color: 'var(--text-on-navy-secondary, rgba(255,255,255,0.86))' }}>[Contact Name] · [Email Address]</div>
          </SlideMock>}
          {showSafe ? <div aria-hidden="true" style={{ position: 'absolute', inset: '7.5%', border: '1px dashed var(--bs-warning, #F0AD4E)', pointerEvents: 'none' }} /> : null}
          <Overlay>{overlay}</Overlay>
        </section>
        {showNotes ? <section id={'notes-' + (slide + 1)} data-region={'notes-' + (slide + 1)} aria-label="Speaker notes"
          style={{ width: SLIDE_WIDTH * (percent / 100), maxWidth: '100%', boxSizing: 'border-box', background: 'var(--surface-card, #fff)', border: RULE, borderRadius: 5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 6px 6px 12px', borderBottom: RULE }}>
            <h2 style={{ margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: PAPER_MUTED, fontFamily: 'inherit' }}>Speaker Notes · Slide {slide + 1} of {slides.length}</h2>
            <IconButton icon="bi-x-lg" size="xs" ariaLabel="Close speaker notes" onClick={() => setShowNotes(false)} />
          </div>
          <p style={{ margin: 0, padding: '10px 12px', fontSize: 14, lineHeight: 1.5, color: 'var(--text-body, #212529)' }}>{current.notes}</p>
        </section> : null}
      </div>}
    </ViewerShell>;
  }

  /** The viewer for one gallery kind: `document`, `spreadsheet` or `presentation`; null otherwise. */
  function OfficeViewer({ kind, title, name, category, layout, format, overlay, part, onPartChange }) {
    const owned = { overlay, part, onPartChange };
    if (kind === 'document') return <DocumentViewer title={title} category={category} format={format} {...owned} />;
    if (kind === 'spreadsheet') return <SpreadsheetViewer title={title} name={name || title} {...owned} />;
    if (kind === 'presentation') return <PresentationViewer title={title} category={category} layout={layout} {...owned} />;
    return null;
  }

  /* A part's value and the words a comment uses for it ("page 2", "sheet Inputs", "slide 3"); an
     absent value is the part a viewer opens on. */
  const FIRST_PART = { document: 0, spreadsheet: 'main', presentation: 0 };
  const SHEET_LABELS = { inputs: 'Inputs', readme: 'Read Me' };
  function officePartOf(kind, value, name) {
    const v = value != null ? value : FIRST_PART[kind];
    const label = kind === 'spreadsheet' ? 'sheet ' + (v === 'main' ? name : SHEET_LABELS[v] || v)
      : (kind === 'presentation' ? 'slide ' : 'page ') + (Number(v) + 1);
    return { value: v, label };
  }

  return { OfficeViewer, DocumentViewer, SpreadsheetViewer, PresentationViewer, officePartOf };
}
