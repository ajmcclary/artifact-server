import { galleryKind } from './page-model.js';

/* Preview placeholders. A publication without captured thumbnails still gets a tile that
   says what kind of page it opens: a full-bleed sketch per kind, drawn from tokens with
   sizes in % and container-query units so one drawing holds from a 96×60 list thumbnail
   up to a grid tile. The declared viewport sits in a chip; compact (list) thumbnails drop it. */
export function createThumbnailUI(React) {
  const primary = 'var(--bs-primary, #0079A8)';
  const tint = (percent) => `color-mix(in srgb, ${primary} ${percent}%, transparent)`;
  const card = 'var(--surface-card, #fff)';
  const hairline = 'var(--border-color, #DEE2E6)';
  const strong = 'var(--border-color-strong, #CED4DA)';
  const navy = 'var(--surface-header, #073652)';
  const serif = 'var(--font-heading, "Source Serif 4", serif)';
  const mono = 'var(--font-data, "Source Code Pro", monospace)';
  const fill = { position: 'absolute', inset: 0 };
  const at = (style) => <div style={{ position: 'absolute', ...style }} />;
  const bar = (width, height, background, extra) => <div style={{ width, height, borderRadius: 2, background, flex: 'none', ...extra }} />;
  const dotted = (size) => ({ backgroundImage: `radial-gradient(${strong} 1px, transparent 1px)`, backgroundSize: `${size}px ${size}px` });
  const pill = (background) => <div style={{ marginLeft: 'auto', width: '14%', height: '34%', borderRadius: 99, background }} />;
  const bullet = (width, dot = 'var(--text-secondary, #5A6268)') => <div style={{ display: 'flex', alignItems: 'center', gap: '4%', paddingLeft: '4%' }}>
    <div style={{ width: '2.4cqh', height: '2.4cqh', borderRadius: '50%', background: dot, flex: 'none' }} />{bar(width, '2.2cqh', strong)}</div>;

  function Prototype() {
    const rows = [['22%', '34%', 'var(--pill-success-bg, #D1F2DC)'], ['18%', '40%', 'var(--pill-warning-bg, #FDECC8)'],
      ['24%', '30%', 'var(--pill-primary-bg, #D6EBF4)'], ['20%', '36%', 'var(--pill-success-bg, #D1F2DC)']];
    const navLine = (top, width) => at({ left: '18%', width, top, height: '3%', borderRadius: 2, background: 'var(--text-on-navy-secondary, #B8C7D3)', opacity: 0.6 });
    return <div style={{ ...fill, background: 'var(--surface-canvas, #F1F5F7)' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '15%', background: navy }}>
        {at({ left: '18%', top: '6%', width: '40%', height: '6%', borderRadius: 2, background: 'var(--text-on-navy, #fff)', opacity: 0.85 })}
        {at({ left: '14%', right: '14%', top: '20%', height: '6%', borderRadius: 2, background: 'var(--surface-navy-strong, #0D4A6B)' })}
        {navLine('32%', '52%')}{navLine('40%', '44%')}{navLine('48%', '56%')}
      </div>
      {at({ left: '20%', top: '8%', width: '28%', height: '6%', borderRadius: 2, background: 'var(--text-navy, #073652)' })}
      {at({ left: '20%', top: '17%', width: '40%', height: '3%', borderRadius: 2, background: strong })}
      {/* The action carries a hotspot ring: a prototype is something to click through. */}
      {at({ right: '5%', top: '7%', width: '15%', height: '9%', borderRadius: 3, background: primary,
        boxShadow: `0 0 0 3px var(--surface-canvas, #F1F5F7), 0 0 0 5px ${tint(45)}` })}
      <div style={{ position: 'absolute', left: '20%', right: '5%', top: '26%', bottom: 0, background: card, border: `1px solid ${hairline}`,
        borderBottom: 0, borderRadius: '3px 3px 0 0', overflow: 'hidden' }}>
        <div style={{ height: '14%', background: 'var(--surface-secondary, #F8F9FA)', borderBottom: `1px solid ${hairline}` }} />
        <div style={{ display: 'flex', flexDirection: 'column', height: '86%' }}>
          {rows.map(([id, name, status], i) => <div key={i} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '6%', padding: '0 5%',
            borderBottom: i < rows.length - 1 ? '1px solid var(--list-divider, #E9ECEF)' : 0, background: i % 2 ? 'var(--surface-secondary, #F8F9FA)' : 'transparent' }}>
            {bar(id, '22%', 'var(--text-data, #495057)', { opacity: 0.55 })}{bar(name, '22%', strong)}{pill(status)}
          </div>)}
        </div>
      </div>
    </div>;
  }

  /* Percent padding resolves against the whole thumbnail's width, so narrow regions use small values. */
  function Template() {
    const region = (style, children) => <div style={{ position: 'absolute', border: `1px dashed ${tint(55)}`, borderRadius: 3, background: tint(6),
      boxSizing: 'border-box', display: 'flex', flexDirection: 'column', ...style }}>{children}</div>;
    return <div style={{ ...fill, background: card }}>
      {region({ left: '4%', right: '4%', top: '6%', height: '12%' })}
      {region({ left: '4%', width: '24%', top: '23%', bottom: '6%', gap: '7%', padding: '8% 2.4%' },
        [22, 14, 14, 14].map((p, i) => <div key={i} style={{ height: '9%', borderRadius: 2, background: tint(p) }} />))}
      {region({ left: '31%', right: '27%', top: '23%', height: '34%' })}
      {region({ left: '31%', right: '27%', top: '61%', bottom: '6%' })}
      {region({ right: '4%', width: '20%', top: '23%', bottom: '6%', gap: '6%', padding: '10% 2.4%' },
        [['60%', 22], ['85%', 14], ['70%', 14]].map(([w, p], i) => <div key={i} style={{ height: '5%', width: w, borderRadius: 2, background: tint(p) }} />))}
    </div>;
  }

  function Component() {
    const row = { display: 'flex', alignItems: 'center', gap: '6cqw', width: '70%', justifyContent: 'center' };
    return <div style={{ ...fill, backgroundColor: 'var(--surface-secondary, #F8F9FA)', ...dotted(10),
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '7%' }}>
      <div style={row}>
        <div style={{ width: '34%', height: '14cqh', borderRadius: 4, background: primary, display: 'grid', placeItems: 'center' }}>
          {bar('55%', '22%', 'var(--text-on-primary, #fff)')}</div>
        <div style={{ width: '22%', height: '9cqh', borderRadius: 99, background: 'var(--pill-success-bg, #D1F2DC)', display: 'grid', placeItems: 'center' }}>
          {bar('60%', '30%', 'var(--pill-success-fg, #14532D)')}</div>
      </div>
      <div style={row}>
        <div style={{ width: '52%', height: '14cqh', boxSizing: 'border-box', borderRadius: 4, background: card, border: `1px solid ${strong}`,
          display: 'flex', alignItems: 'center', paddingLeft: '4%', gap: '4%' }}>
          <div style={{ width: 2, height: '50%', background: primary }} />{bar('45%', '18%', hairline)}</div>
        <div style={{ width: '14%', height: '9cqh', borderRadius: 99, background: primary, position: 'relative' }}>
          {at({ right: '8%', top: '12%', height: '76%', aspectRatio: '1', borderRadius: '50%', background: card })}</div>
      </div>
    </div>;
  }

  function Guideline() {
    const swatches = [navy, primary, 'var(--bs-info, #0A7A90)', 'var(--bs-success, #00B532)', 'var(--bs-warning, #FF9A15)', 'var(--bs-danger, #D83506)'];
    return <div style={{ ...fill, background: card, display: 'flex' }}>
      <div style={{ width: '48%', display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingLeft: '8%', gap: '5cqh', borderRight: `1px solid ${hairline}` }}>
        <div style={{ fontFamily: serif, fontWeight: 600, fontSize: '34cqh', lineHeight: 1, color: 'var(--text-navy, #073652)' }}>Aa</div>
        {bar('70%', '3cqh', 'var(--text-emphasis, #374151)', { opacity: 0.6 })}{bar('54%', '3cqh', strong)}{bar('62%', '3cqh', strong)}
      </div>
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '6%', padding: '14% 10%', alignContent: 'center' }}>
        {swatches.map((color, i) => <div key={i} style={{ aspectRatio: '1', borderRadius: 3, background: color }} />)}
      </div>
    </div>;
  }

  function Documentation() {
    const prose = (width) => bar(width, '2.4cqh', strong);
    return <div style={{ ...fill, background: 'var(--surface-tertiary, #E9ECEF)' }}>
      <div style={{ position: 'absolute', left: '18%', right: '18%', top: '9%', bottom: '-6%', background: card, display: 'flex', flexDirection: 'column',
        boxShadow: 'var(--shadow-md, 0 2px 4px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.1))' }}>
        <div style={{ height: '10%', background: navy, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6%' }}>
          {bar('30%', '28%', 'var(--text-on-navy, #fff)', { opacity: 0.7 })}{bar('12%', '28%', 'var(--text-on-navy-secondary, #B8C7D3)', { opacity: 0.6 })}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3.2cqh', padding: '7% 8%' }}>
          {bar('58%', '6cqh', 'var(--text-navy, #073652)')}{prose('92%')}{prose('86%')}{prose('90%')}
          <div style={{ height: '14cqh', borderRadius: 2, background: 'var(--pill-primary-bg, #D6EBF4)', display: 'flex', flexDirection: 'column',
            justifyContent: 'center', gap: '2cqh', padding: '0 5%' }}>{bar('30%', '2.4cqh', primary)}{bar('75%', '2.4cqh', tint(35))}</div>
          {prose('80%')}
        </div>
      </div>
    </div>;
  }

  function Artboard() {
    const frame = { position: 'absolute', background: card, border: `1px solid ${hairline}` };
    const label = (style) => at({ height: '4%', borderRadius: 2, background: 'var(--text-secondary, #5A6268)', opacity: 0.45, ...style });
    const handle = (corner) => at({ ...corner, width: 6, height: 6, background: card, border: `1px solid ${primary}` });
    return <div style={{ ...fill, backgroundColor: 'var(--surface-canvas, #F1F5F7)', ...dotted(12) }}>
      {label({ left: '6%', top: '12%', width: '30%' })}
      <div style={{ ...frame, left: '6%', top: '19%', width: '40%', height: '46%', boxShadow: 'var(--shadow-card, 0 1px 3px rgba(7,54,82,.1))' }}>
        <div style={{ height: '16%', background: navy }} /></div>
      {at({ left: '52%', top: '12%', width: '22%', height: '4%', borderRadius: 2, background: primary, opacity: 0.8 })}
      <div style={{ position: 'absolute', left: '52%', top: '19%', width: '40%', height: '46%', background: card, border: `2px solid ${primary}`, boxSizing: 'border-box' }}>
        {at({ left: '10%', right: '10%', top: '18%', height: '10%', borderRadius: 2, background: hairline })}
        {at({ left: '10%', width: '48%', top: '38%', height: '10%', borderRadius: 2, background: hairline })}
        {handle({ left: -4, top: -4 })}{handle({ right: -4, top: -4 })}{handle({ left: -4, bottom: -4 })}{handle({ right: -4, bottom: -4 })}
      </div>
      {label({ left: '6%', top: '72%', width: '18%' })}
      <div style={{ ...frame, left: '6%', top: '79%', width: '18%', bottom: '-10%' }} />
      <div style={{ ...frame, left: '30%', top: '79%', width: '40%', bottom: '-10%' }} />
    </div>;
  }

  function Document() {
    const glyph = (text, style) => <span style={{ fontFamily: serif, fontSize: '6cqh', lineHeight: 1, color: 'var(--text-emphasis, #374151)', ...style }}>{text}</span>;
    const rule = <div style={{ width: 1, height: '46%', background: hairline }} />;
    const prose = (width) => bar(width, '2.2cqh', strong);
    const align = 'var(--text-secondary, #5A6268)';
    return <div style={{ ...fill, background: 'var(--surface-tertiary, #E9ECEF)' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: '13%', background: card, borderBottom: `1px solid ${hairline}`,
        display: 'flex', alignItems: 'center', gap: '2.4cqw', padding: '0 4%', boxSizing: 'border-box' }}>
        <div style={{ width: '14%', height: '40%', borderRadius: 2, border: `1px solid ${strong}`, boxSizing: 'border-box' }} />{rule}
        {glyph('B', { fontWeight: 700 })}{glyph('I', { fontStyle: 'italic' })}{glyph('U', { textDecoration: 'underline' })}{rule}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1cqh', width: '5%' }}>
          <div style={{ height: '1cqh', background: align }} /><div style={{ height: '1cqh', width: '70%', background: align }} /><div style={{ height: '1cqh', background: align }} />
        </div>
        <div style={{ marginLeft: 'auto', width: '12%', height: '46%', borderRadius: 3, background: primary }} />
      </div>
      <div style={{ position: 'absolute', left: '22%', right: '22%', top: '20%', bottom: '-6%', background: card, boxSizing: 'border-box',
        boxShadow: 'var(--shadow-card, 0 1px 3px rgba(7,54,82,.1))', display: 'flex', flexDirection: 'column', gap: '3.2cqh', padding: '8% 10%' }}>
        {bar('64%', '5.5cqh', 'var(--text-strong, #111827)', { opacity: 0.8 })}{prose('96%')}{prose('90%')}{prose('58%')}
        {bullet('66%')}{bullet('52%')}{prose('88%')}
      </div>
    </div>;
  }

  /* An 8-row by 6-column sheet: lettered columns, a numbered gutter, a row of labels,
     then a label column and right-aligned figures. C4 is the selected cell. */
  const widths = [62, 48, 70, 56, 40, 66, 52];
  function Spreadsheet() {
    const cells = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 6; c++) {
      const head = r === 0 || c === 0;
      const selected = r === 4 && c === 3;
      const crossed = (r === 0 && c === 3) || (c === 0 && r === 4);
      const text = r === 0 ? ' ABCDE'[c].trim() : c === 0 ? String(r) : '';
      cells.push(<div key={`${r}:${c}`} style={{ position: 'relative', display: 'flex', alignItems: 'center', boxSizing: 'border-box', minWidth: 0, padding: '0 8%',
        justifyContent: head ? 'center' : c >= 3 && r > 1 ? 'flex-end' : 'flex-start',
        background: head ? (crossed ? 'var(--tint-primary-selected, rgba(0,121,168,.1))' : 'var(--surface-secondary, #F8F9FA)') : card,
        borderRight: `1px solid ${hairline}`, borderBottom: `1px solid ${hairline}`,
        outline: selected ? `2px solid ${primary}` : 'none', outlineOffset: -1, zIndex: selected ? 1 : 0 }}>
        {text && <span style={{ fontFamily: mono, fontSize: '4.2cqh', lineHeight: 1, color: 'var(--text-secondary, #5A6268)' }}>{text}</span>}
        {!head && !(r === 7 && c > 2) && bar(`${widths[(r * 3 + c) % widths.length]}%`, '3cqh',
          r === 1 ? 'var(--text-emphasis, #374151)' : c >= 3 ? 'var(--text-data, #495057)' : strong, { opacity: r === 1 ? 0.7 : c >= 3 ? 0.45 : 1 })}
        {selected && at({ right: -3, bottom: -3, width: 5, height: 5, background: primary, border: `1px solid ${card}`, zIndex: 2 })}
      </div>);
    }
    return <div style={{ ...fill, background: card, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 'none', height: '12%', display: 'flex', alignItems: 'center', gap: '3%', padding: '0 3%', borderBottom: `1px solid ${hairline}` }}>
        <span style={{ width: '9%', fontFamily: mono, fontSize: '4.6cqh', lineHeight: 1, color: 'var(--text-data, #495057)' }}>C4</span>
        <span style={{ fontFamily: serif, fontStyle: 'italic', fontSize: '5cqh', lineHeight: 1, color: 'var(--text-secondary, #5A6268)' }}>fx</span>
        <div style={{ flex: 1, height: '50%', border: `1px solid ${strong}`, borderRadius: 2, display: 'flex', alignItems: 'center', paddingLeft: '2%' }}>
          {bar('34%', '30%', 'var(--text-data, #495057)', { opacity: 0.5 })}</div>
      </div>
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '8% repeat(5, minmax(0, 1fr))', gridTemplateRows: 'repeat(8, minmax(0, 1fr))' }}>{cells}</div>
    </div>;
  }

  function Presentation() {
    const slide = (style) => <div style={{ aspectRatio: '16 / 9', background: card, border: `1px solid ${hairline}`, ...style }} />;
    const point = (width) => <div style={{ display: 'flex', alignItems: 'center', gap: '6%' }}>
      <div style={{ width: '2cqh', height: '2cqh', borderRadius: '50%', background: primary, flex: 'none' }} />{bar(width, '2.2cqh', strong)}</div>;
    return <div style={{ ...fill, background: 'var(--surface-tertiary, #E9ECEF)' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '20%', background: 'var(--surface-secondary, #F8F9FA)', borderRight: `1px solid ${hairline}`,
        display: 'flex', flexDirection: 'column', gap: '6%', padding: '8% 2.4%', boxSizing: 'border-box' }}>
        {slide({ background: navy })}{slide({ border: 0, outline: `2px solid ${primary}`, outlineOffset: 1 })}{slide()}{slide()}
      </div>
      <div style={{ position: 'absolute', left: '25%', right: '5%', top: '50%', transform: 'translateY(-50%)', aspectRatio: '16 / 9', background: card,
        boxShadow: 'var(--shadow-md, 0 2px 4px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.1))', display: 'flex', flexDirection: 'column', padding: '6% 7%', boxSizing: 'border-box', gap: '7%' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2.6cqh' }}>{bar('22%', '2cqh', primary)}{bar('58%', '5.5cqh', 'var(--text-navy, #073652)')}</div>
        <div style={{ flex: 1, display: 'flex', gap: '8%', minHeight: 0 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '3.4cqh', paddingTop: '2%' }}>{point('80%')}{point('66%')}{point('74%')}</div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: '10%', borderBottom: `1px solid ${strong}`, padding: '0 6%' }}>
            {[['42%', strong], ['64%', strong], ['92%', primary]].map(([height, background], i) => <div key={i} style={{ flex: 1, height, background }} />)}
          </div>
        </div>
      </div>
    </div>;
  }

  const SKETCHES = { prototype: Prototype, template: Template, component: Component, guideline: Guideline, documentation: Documentation,
    artboard: Artboard, document: Document, spreadsheet: Spreadsheet, presentation: Presentation };

  /** One kind's sketch, filling its positioned container; `size` labels the declared viewport. */
  function GalleryPlaceholder({ kind, size, compact = false }) {
    const Sketch = SKETCHES[galleryKind(kind).id];
    return <div aria-hidden="true" data-gallery-thumbnail="placeholder" data-kind={galleryKind(kind).id}
      style={{ ...fill, overflow: 'hidden', containerType: 'size', fontFamily: 'var(--font-body, "Public Sans", sans-serif)' }}>
      <Sketch />
      {!compact && size && <span style={{ position: 'absolute', right: 8, bottom: 8, padding: '1px 6px', borderRadius: 'var(--radius-sm, 4px)', background: card,
        border: `1px solid ${hairline}`, fontFamily: mono, fontVariantNumeric: 'tabular-nums', fontSize: 'var(--font-size-label, 11px)', lineHeight: '16px',
        color: 'var(--text-data, #495057)' }}>{size}</span>}
    </div>;
  }

  /** The captured image when the host supplies one and it loads; otherwise the kind's placeholder. */
  function GalleryThumbnail({ item, compact = false, chip = true }) {
    const [failed, setFailed] = React.useState(false);
    const { width, height } = item.viewport;
    if (item.thumbnailUrl && !failed) return <img src={item.thumbnailUrl} alt="" loading="lazy" decoding="async"
      data-gallery-thumbnail="image" onError={() => setFailed(true)}
      style={{ ...fill, display: 'block', width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top left' }} />;
    return <GalleryPlaceholder kind={item.kind} compact={compact || !chip} size={`${width} × ${height}`} />;
  }

  return { GalleryPlaceholder, GalleryThumbnail };
}
