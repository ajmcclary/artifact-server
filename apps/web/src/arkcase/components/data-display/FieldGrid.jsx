import { akStyleDocument } from '@/arkcase-style';
import React from 'react';
import { DataRef } from '../record/DataRef.jsx';

/* Container-query rules cannot be inline, so they live in one sheet per breakpoint. They
   override the inline grid tracks, hence `!important`. The wrapper that carries them sets its
   own `container-type`, so a host never has to. */
function ensureFieldGridStyles(collapseBelow) {
  if (typeof document === 'undefined') return;
  if (!akStyleDocument.getElementById('ak-field-grid-cq')) {
    const s = akStyleDocument.createElement('style');
    s.id = 'ak-field-grid-cq';
    s.textContent =
      '@container (width < 720px){' +
      '[data-ak-field-grid][data-ak-field-grid-size="summary"]>dl{grid-template-columns:repeat(2,minmax(0,1fr)) !important}' +
      '}';
    akStyleDocument.head.appendChild(s);
  }
  const n = Number(collapseBelow);
  if (!(n > 0)) return;
  const id = 'ak-field-grid-cq-' + n;
  if (akStyleDocument.getElementById(id)) return;
  const s = akStyleDocument.createElement('style');
  s.id = id;
  const sel = '[data-ak-field-grid][data-ak-field-grid-collapse="' + n + '"]>dl';
  s.textContent =
    '@container (width < ' + n + 'px){' +
    sel + '[data-field-grid-layout="inline"]{grid-template-columns:max-content minmax(0,1fr) !important}' +
    sel + ':not([data-field-grid-layout="inline"]){grid-template-columns:minmax(0,1fr) !important}' +
    sel + '>div{grid-column:auto !important}' +
    sel + '>[data-field-grid-row]{grid-column:1/-1 !important}' +
    '}';
  akStyleDocument.head.appendChild(s);
}

const FIELD_GRID_EMPTY = (v) => v == null || v === '';

const FIELD_GRID_WEIGHT = { normal: 400, medium: 500, strong: 600 };
const FIELD_GRID_NOTE_INK = {
  default: 'var(--text-secondary, #5a6268)',
  warning: 'var(--pill-warning-fg, #92400e)',
  danger: 'var(--pill-danger-fg, #991b1b)',
  success: 'var(--pill-success-fg, #15803d)',
};
const FIELD_GRID_RULE = '1px solid var(--list-divider, #e9ecef)';

/* A width prop accepts a number (px) or any CSS length. */
const fieldGridLength = (v) => (typeof v === 'number' ? v + 'px' : v);

/**
 * ArkCase FieldGrid — the label-over-value block every detail card is built from
 * (Overview, Request, Requester, Fees, and the registries' record cards).
 *
 * Labels are 11px uppercase noun phrases; values sit at 14px. A coded value —
 * identifier, date, amount, code, contact string — takes `mono: true` and renders
 * in the data font at the SAME size as the sans text beside it. An absent value
 * renders an em dash rather than collapsing the field, so a card's shape does not
 * change between records; a field's `absent` text draws a value nothing recorded
 * in italic sans instead.
 *
 * `layout="inline"` sets the label beside its value (the dense key/value list of a
 * side panel); `size="summary"` is the three-up fact block that heads a reading;
 * `collapseBelow` drops the grid to one pair per row when its box narrows.
 *
 * The record cards add, all opt-in: `divided` rows with a
 * `list-divider` hairline (the ledger list), `labelWidth`, `valueAlign="end"` and
 * `valueWeight` for the spread key/value row, `variant="cells"` (the ruled cell grid),
 * `minColumnWidth` (auto-fit tracks), and per-field `icon`, `note`/`noteTone` and `id`.
 */
export function FieldGrid({
  fields = [], columns, layout = 'stacked', size = 'default', collapseBelow,
  variant = 'plain', divided = false, density = 'default', labelWidth, valueAlign = 'start', valueWeight, minColumnWidth,
  monoWeight = false, style, ...rest
}) {
  const summary = size === 'summary';
  const inline = layout === 'inline' && !summary;
  const cells = variant === 'cells' && !inline && !summary;
  const auto = !inline && !summary && columns == null && (Number(minColumnWidth) > 0 || cells);
  const cols = columns != null ? columns : summary ? 3 : inline ? 1 : 2;
  const wrapped = summary || Number(collapseBelow) > 0;
  React.useLayoutEffect(() => { if (wrapped) ensureFieldGridStyles(collapseBelow); }, [wrapped, collapseBelow]);

  const end = valueAlign === 'end';
  const weight = FIELD_GRID_WEIGHT[valueWeight || (cells ? 'strong' : 'normal')] || 400;
  /* A coded value keeps 400 unless the grid opts in (`monoWeight`) or the field names its own
     `weight` — the Portal's Response Due is a 600 date among 400 dates. */
  const weightOf = (f, coded, empty) => {
    if (empty) return undefined;
    if (f.weight && FIELD_GRID_WEIGHT[f.weight]) return FIELD_GRID_WEIGHT[f.weight];
    if (coded && !monoWeight) return undefined;
    return weight !== 400 ? weight : undefined;
  };
  const absentNode = (f) => (f.absent ? <DataRef variant="absent" style={{ fontSize: 'inherit' }}>{f.absent}</DataRef> : '—');
  const labelNode = (f) => (f.icon ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <i aria-hidden="true" className={'bi ' + f.icon} style={{ fontSize: 'var(--icon-sm, 14px)', flex: 'none' }} />
      {f.label}
    </span>
  ) : f.label);
  const noteNode = (f) => (f.note != null && f.note !== '' ? (
    <span data-field-grid-note="" style={{
      display: 'block', marginTop: 2, fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
      fontSize: 'var(--font-size-xs, 12px)', fontWeight: 400, lineHeight: 1.45,
      color: FIELD_GRID_NOTE_INK[f.noteTone] || FIELD_GRID_NOTE_INK.default,
    }}>{f.note}</span>
  ) : null);

  let grid;
  if (inline) {
    const two = cols >= 2;
    const lw = labelWidth != null ? fieldGridLength(labelWidth) : 'max-content';
    const rule = divided ? (divided === 'top' ? { borderTop: FIELD_GRID_RULE } : { borderBottom: FIELD_GRID_RULE }) : null;
    const rowPad = density === 'compact' ? '5px 0' : '8px 0';
    const valueStyle = (f, empty) => ({
      margin: 0, minWidth: 0, overflowWrap: 'anywhere', textAlign: end ? 'right' : undefined,
      color: f.tone || (empty ? 'var(--text-secondary, #5a6268)' : f.mono ? 'var(--text-data, #495057)' : 'var(--text-body, #212529)'),
      fontFamily: f.mono && !empty ? 'var(--font-data)' : undefined,
      fontVariantNumeric: f.mono && !empty ? 'var(--font-numeric-feature, tabular-nums)' : undefined,
      fontWeight: weightOf(f, f.mono, empty),
    });
    const labelStyle = { color: 'var(--text-secondary, #5a6268)', whiteSpace: labelWidth != null ? 'normal' : 'nowrap', ...(labelWidth != null ? { minWidth: 0 } : null) };
    grid = (
      <dl
        data-field-grid-layout="inline"
        data-field-grid-divided={divided ? (divided === 'top' ? 'top' : 'bottom') : undefined}
        style={{
          display: 'grid',
          gridTemplateColumns: two ? `${lw} minmax(0, 1fr) ${lw} minmax(0, 1fr)` : `${lw} minmax(0, 1fr)`,
          gap: divided ? (two ? '0 18px' : '0 12px') : two ? '7px 18px' : '6px 16px',
          fontSize: 'var(--font-size-dense, 13px)',
          margin: 0,
          ...(wrapped ? null : style),
        }}
        {...(wrapped ? null : rest)}
      >
        {fields.map((f, i) => {
          const empty = FIELD_GRID_EMPTY(f.value);
          const dd = (
            <dd id={divided ? undefined : f.id} style={valueStyle(f, empty)}>
              {empty ? absentNode(f) : f.value}
              {noteNode(f)}
            </dd>
          );
          if (divided) {
            return (
              <div key={i} id={f.id} data-field-grid-row="" style={{ display: 'grid', gridTemplateColumns: 'subgrid', gridColumn: 'span 2', alignItems: 'baseline', padding: rowPad, ...rule }}>
                <dt style={labelStyle}>{labelNode(f)}</dt>
                {dd}
              </div>
            );
          }
          return (
            <React.Fragment key={i}>
              <dt style={labelStyle}>{labelNode(f)}</dt>
              {dd}
            </React.Fragment>
          );
        })}
      </dl>
    );
  } else {
    const minCol = Number(minColumnWidth) > 0 ? Number(minColumnWidth) : 200;
    const tracks = auto ? `repeat(auto-fit, minmax(min(100%, ${minCol}px), 1fr))` : `repeat(${cols}, minmax(0, 1fr))`;
    grid = (
      <dl
        data-field-grid-layout={summary ? 'summary' : undefined}
        data-field-grid-variant={cells ? 'cells' : undefined}
        style={{
          display: 'grid',
          gridTemplateColumns: tracks,
          ...(summary ? { gap: 18 } : cells ? { gap: 0 } : { columnGap: 20, rowGap: 12 }),
          margin: 0,
          ...(wrapped ? null : style),
        }}
        {...(wrapped ? null : rest)}
      >
        {fields.map((f, i) => {
          const empty = FIELD_GRID_EMPTY(f.value);
          const data = summary || f.mono;
          const span = f.wide ? (auto ? '1 / -1' : `span ${Math.min(cols, 2)}`) : undefined;
          return (
            <div key={i} id={f.id} style={{
              minWidth: 0, gridColumn: span,
              ...(cells ? { padding: '12px 16px', borderRight: FIELD_GRID_RULE, borderBottom: FIELD_GRID_RULE } : null),
            }}>
              {summary ? (
                <dt style={{ fontSize: 'var(--font-size-label, 11px)', color: 'var(--text-secondary, #5a6268)', margin: '0 0 5px' }}>{labelNode(f)}</dt>
              ) : (
                <dt style={{ fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 'var(--letter-spacing-wide, 0.025em)', color: 'var(--text-secondary, #5a6268)', margin: cells ? '0 0 4px' : undefined }}>{labelNode(f)}</dt>
              )}
              <dd style={summary ? {
                margin: 0,
                fontFamily: empty ? undefined : 'var(--font-data)',
                fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)',
                fontSize: 'var(--font-size-sm, 14px)', fontWeight: 600, lineHeight: 1.4,
                color: f.tone || (empty ? 'var(--text-secondary, #5a6268)' : 'var(--text-strong, #111827)'),
                overflowWrap: 'anywhere',
              } : {
                margin: cells ? 0 : '2px 0 0',
                fontSize: 'var(--font-size-sm, 14px)', lineHeight: 1.45,
                fontWeight: weightOf(f, data, empty),
                textAlign: end ? 'right' : undefined,
                color: f.tone || (empty ? 'var(--text-secondary, #5a6268)' : data ? 'var(--text-data, #495057)' : 'var(--text-body, #212529)'),
                fontFamily: data ? 'var(--font-data)' : undefined,
                fontVariantNumeric: data ? 'var(--font-numeric-feature, tabular-nums)' : undefined,
                overflowWrap: 'anywhere',
              }}>
                {empty ? absentNode(f) : f.value}
                {noteNode(f)}
              </dd>
            </div>
          );
        })}
      </dl>
    );
  }

  if (!wrapped) return grid;
  return (
    <div
      data-ak-field-grid=""
      data-ak-field-grid-size={summary ? 'summary' : undefined}
      data-ak-field-grid-collapse={Number(collapseBelow) > 0 ? Number(collapseBelow) : undefined}
      style={{ containerType: 'inline-size', minWidth: 0, ...style }}
      {...rest}
    >
      {grid}
    </div>
  );
}
