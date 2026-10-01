import { akStyleDocument } from '@/arkcase-style';
import React from 'react';
import { Eyebrow } from '../data-display/Eyebrow.jsx';

const CHIP = {
  primary: { color: 'var(--pill-primary-fg, #0369a1)', background: 'rgba(0,121,168,.10)' },
  info:    { color: 'var(--text-link-hover, #005a7d)', background: 'rgba(10,122,144,.12)' },
};

/* Page-title sizes. `lg` is the 22px h1 a page opens on; `xl` the 26px serif title under an
   eyebrow that opens a run step. `md`/`default` 20 and `sm` 18 keep the section steps. */
const SECTION_HEADING_TITLE = {
  sm: { fontSize: 18 },
  md: { fontSize: 20 },
  lg: { fontSize: 22, lineHeight: 1.2, margin: 0 },
  xl: { margin: '4px 0 6px', fontFamily: 'var(--font-heading, "Source Serif 4", Georgia, serif)', fontWeight: 600, fontSize: 26, lineHeight: 1.15, color: 'var(--text-strong, #111827)' },
};

/* Stacking under a container width needs a query container above the row and a rule that
   beats the row's inline layout; both are injected once per breakpoint. */
function ensureSectionHeadingStyles(below) {
  const n = Number(below);
  if (typeof document === 'undefined' || !(n > 0)) return;
  const id = 'ak-section-heading-cq-' + n;
  if (akStyleDocument.getElementById(id)) return;
  const s = akStyleDocument.createElement('style');
  s.id = id;
  const root = '[data-ak-section-heading-stack="' + n + '"]>[data-ac-section-heading]';
  s.textContent =
    '@container (width < ' + n + 'px){' +
    root + '{flex-direction:column !important;align-items:flex-start !important;gap:12px !important}' +
    root + '>[data-section-heading-actions]{margin-left:0 !important}' +
    '}';
  akStyleDocument.head.appendChild(s);
}

/**
 * ArkCase SectionHeading — the row a record section opens on. Harvested from the
 * Workers Compensation App (2026): a serif heading at the section step, a count
 * chip, a meta line, and the section's actions at the end of the row. Not a
 * RecordPanel cap — this heads a run of content on the page, it does not box it.
 *
 * `eyebrow` and `subtitle` add the uppercase label above and the muted line below;
 * `size="lg"` / `"xl"` make it a page title (ExtractionKit's page and step headings),
 * which stacks its actions under the title below a 720px container. The heading
 * element holds the title text alone; count, meta, eyebrow and subtitle are siblings.
 */
export function SectionHeading({ level, size = 'md', title, titleFace = 'display', badge, eyebrow, subtitle, count, countTone = 'primary', meta, stackBelow, children, style, ...rest }) {
  const sz = size === 'default' ? 'md' : SECTION_HEADING_TITLE[size] ? size : 'md';
  const page = sz === 'lg' || sz === 'xl';
  const lvl = level != null ? level : sz === 'lg' ? 1 : sz === 'xl' ? 2 : 4;
  const H = 'h' + lvl;
  const chip = CHIP[countTone] || CHIP.primary;
  const stack = stackBelow !== undefined ? stackBelow : page ? 720 : null;
  const stacks = Number(stack) > 0;
  React.useLayoutEffect(() => { if (stacks) ensureSectionHeadingStyles(stack); }, [stacks, stack]);

  /* `titleFace="data"` sets a record identifier as the title (the Portal claim header's claim
     number): the data face, tabular figures, 600, navy ink, at the size step's px. */
  const dataFace = titleFace === 'data'
    ? { fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)', fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)', fontWeight: 600, color: 'var(--text-navy, #073652)' }
    : null;
  const heading = <H data-section-heading-face={dataFace ? 'data' : undefined} style={{ ...SECTION_HEADING_TITLE[sz], ...dataFace }}>{title}</H>;
  const badgeNode = badge != null && badge !== false && badge !== '' && (
    <span data-section-heading-badge="" style={{ display: 'inline-flex', alignItems: 'center', flex: 'none' }}>{badge}</span>
  );
  const chipNode = count != null && count !== '' && <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 10px', borderRadius: 10, whiteSpace: 'nowrap', ...chip }}>{count}</span>;
  const metaNode = meta != null && meta !== '' && <span style={{ fontSize: 13, color: 'var(--text-secondary, #5a6268)' }}>{meta}</span>;
  const actions = children != null && (
    <div data-section-heading-actions="" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{children}</div>
  );

  let row;
  if (!page && eyebrow == null && subtitle == null) {
    // The original single row: heading, chip, meta, actions.
    row = (
      <div data-ac-section-heading="" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', ...(stacks ? null : style) }} {...(stacks ? null : rest)}>
        {heading}
        {badgeNode}
        {chipNode}
        {metaNode}
        {actions}
      </div>
    );
  } else {
    const titleRow = badgeNode || chipNode || metaNode
      ? <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', minWidth: 0 }}>{heading}{badgeNode}{chipNode}{metaNode}</div>
      : heading;
    row = (
      <div
        data-ac-section-heading=""
        data-section-heading-size={sz}
        style={{
          display: 'flex', flexWrap: 'wrap', minWidth: 0,
          alignItems: sz === 'xl' ? 'center' : 'flex-start',
          justifyContent: 'space-between',
          gap: sz === 'xl' ? 20 : 12,
          ...(stacks ? null : style),
        }}
        {...(stacks ? null : rest)}
      >
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          {eyebrow != null && eyebrow !== '' && (
            <Eyebrow as={typeof eyebrow === 'string' || typeof eyebrow === 'number' ? 'p' : 'div'} tone="navy" data-section-heading-eyebrow="" style={{ margin: 0, lineHeight: 1.4, letterSpacing: '.12em' }}>{eyebrow}</Eyebrow>
          )}
          {titleRow}
          {subtitle != null && subtitle !== '' && (
            <p data-section-heading-subtitle="" style={{ margin: sz === 'xl' ? 0 : '2px 0 0', fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.5, color: 'var(--text-secondary, #5a6268)' }}>{subtitle}</p>
          )}
        </div>
        {actions}
      </div>
    );
  }

  if (!stacks) return row;
  return (
    <div data-ak-section-heading-stack={Number(stack)} style={{ containerType: 'inline-size', minWidth: 0, ...style }} {...rest}>
      {row}
    </div>
  );
}
