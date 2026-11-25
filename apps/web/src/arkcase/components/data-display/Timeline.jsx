import { akStyleDocument } from '@/arkcase-style';
import React from 'react';
import { Button } from '../actions/Button.jsx';
import { visuallyHiddenStyle } from '../utilities/VisuallyHidden.jsx';
import { useElementSize } from '../utilities/element-size.jsx';

const DATA_FONT = 'var(--font-data, "Source Code Pro", ui-monospace, monospace)';
const MARKER = 'calc(var(--space-1, 4px) * 6)';
const DOT = 'var(--space-input-padding-x, 10px)';
const LINE = 'calc(var(--space-1, 4px) * 0.5)';
const LINE_COLOR = 'var(--border-color-strong, #ced4da)';

// Text-safe inks, so every ring, dot and glyph clears 3:1 on the card.
const TONES = {
  primary: 'var(--text-link, #0079a8)',
  success: 'var(--pill-success-fg, #15803d)',
  warning: 'var(--pill-warning-fg, #92400e)',
  danger: 'var(--pill-danger-fg, #991b1b)',
  neutral: 'var(--text-secondary, #5a6268)',
};

/* `markerStyle="soft"` grounds: the pill tint under the tone's ink, no ring — the stepper that
   record notices, workflows and approvals draw. */
const SOFT_GROUNDS = {
  primary: { bg: 'var(--tint-primary-selected, rgba(0,121,168,.10))', fg: 'var(--pill-primary-fg, #0369a1)' },
  success: { bg: 'var(--pill-success-bg, #dcfce7)', fg: 'var(--pill-success-fg, #15803d)' },
  warning: { bg: 'var(--pill-warning-bg, #fef3c7)', fg: 'var(--pill-warning-fg, #92400e)' },
  danger: { bg: 'var(--pill-danger-bg, #fee2e2)', fg: 'var(--pill-danger-fg, #991b1b)' },
  neutral: { bg: 'var(--surface-tertiary, #e9ecef)', fg: 'var(--text-secondary, #5a6268)' },
};

/* The ledger's square index: a 32px tile on the navy wash, recoloured to the pill pair when
   the step escalated (warning) or failed (danger). Ink pairs are the pill and link tokens, so
   the numeral clears 4.5:1 on its ground in every theme. */
const LEDGER_TONES = {
  primary: { bg: 'var(--surface-navy-subtle, #eaf1f6)', fg: 'var(--text-link-hover, #005a7d)', bd: 'var(--border-color, #dee2e6)' },
  neutral: { bg: 'var(--surface-navy-subtle, #eaf1f6)', fg: 'var(--text-link-hover, #005a7d)', bd: 'var(--border-color, #dee2e6)' },
  success: { bg: 'var(--pill-success-bg, #dcfce7)', fg: 'var(--pill-success-fg, #15803d)', bd: 'var(--border-color, #dee2e6)' },
  warning: { bg: 'var(--pill-warning-bg, #fef3c7)', fg: 'var(--pill-warning-fg, #92400e)', bd: 'var(--bs-warning, #ff9a15)' },
  danger: { bg: 'var(--pill-danger-bg, #fee2e2)', fg: 'var(--pill-danger-fg, #991b1b)', bd: 'var(--border-color, #dee2e6)' },
};

function TimelineLedgerMarker({ item, index }) {
  const t = LEDGER_TONES[item.tone] || LEDGER_TONES.primary;
  return (
    <span
      aria-hidden="true"
      data-icon-tone="current"
      style={{
        width: 32, height: 32, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: t.bg, border: 'var(--border-width, 1px) solid ' + t.bd, color: t.fg, borderRadius: 'var(--radius-md, 5px)',
        fontFamily: DATA_FONT, fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)', fontSize: 'var(--font-size-xs, 12px)', fontWeight: 600, lineHeight: 1,
      }}
    >
      {item.marker === 'icon' ? <i className={`bi ${item.icon || 'bi-circle'}`} style={{ color: t.fg, fontSize: 'var(--font-size-sm, 14px)' }} /> : (item.number ?? String(index + 1).padStart(2, '0'))}
    </span>
  );
}

/* A per-item `onSelect` makes the title a link, and a compact ledger row a button; their hover
   and focus need pseudo-classes, injected once. An attention row keeps its inline wash. */
function ensureTimelineLinkStyles() {
  if (typeof document === 'undefined' || akStyleDocument.getElementById('ak-timeline-link-css')) return;
  const s = akStyleDocument.createElement('style');
  s.id = 'ak-timeline-link-css';
  s.textContent = '[data-ak-timeline-link]:hover{color:var(--text-link, #0079a8) !important;text-decoration:underline}'
    /* !important: the row's inline transparent fill would otherwise win over :hover. */
    + '[data-ak-timeline-row]:not(:disabled):not([data-attention]):hover{background-color:var(--tint-primary-hover, rgba(0, 121, 168, 0.05)) !important}'
    + '[data-ak-timeline-row]:focus-visible{outline:var(--focus-outline, 2px solid #0079a8);outline-offset:-2px}';
  akStyleDocument.head.appendChild(s);
}

/* An item's own `data-*` keys (data-step-row…) land on its row, so host hooks survive. */
function timelineItemAttrs(item) {
  const out = {};
  Object.keys(item).forEach((k) => { if (k.indexOf('data-') === 0) out[k] = item[k]; });
  return out;
}

/* The marker's state as words, after the title: the marker itself is decorative. */
function MarkerLabel({ item }) {
  return item.markerLabel ? <span data-timeline-marker-label="" style={visuallyHiddenStyle}>{', ' + item.markerLabel}</span> : null;
}

function Marker({ item, index, markerStyle: listStyle }) {
  const color = TONES[item.tone] || TONES.primary;
  const kind = item.marker || 'dot';
  if (kind === 'dot') {
    return <span style={{ width: DOT, height: DOT, flex: 'none', borderRadius: '50%', background: color }} />;
  }
  const markerStyle = item.markerStyle || listStyle;
  const soft = markerStyle === 'soft' ? SOFT_GROUNDS[item.tone] || SOFT_GROUNDS.primary : null;
  const solid = markerStyle === 'solid';
  /* `dashed` is a step not yet reached: an empty disc in a dashed strong hairline. */
  const dashed = markerStyle === 'dashed';
  const ink = soft ? soft.fg : solid ? 'var(--text-on-primary, #ffffff)' : dashed ? 'var(--text-secondary, #5a6268)' : color;
  return (
    <span
      data-icon-tone="current"
      data-timeline-marker={soft ? 'soft' : solid ? 'solid' : dashed ? 'dashed' : 'ring'}
      style={{
        width: MARKER, height: MARKER, flex: 'none', boxSizing: 'border-box',
        display: 'grid', placeItems: 'center', borderRadius: '50%',
        border: soft ? 0 : dashed ? `1.5px dashed ${LINE_COLOR}` : `${LINE} solid ${color}`,
        background: soft ? soft.bg : solid ? color : dashed ? 'transparent' : 'var(--surface-card, #ffffff)', color: ink,
        fontFamily: DATA_FONT, fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)',
        fontSize: 'var(--font-size-label, 11px)', fontWeight: 'var(--bs-font-weight-semibold, 600)', lineHeight: 1,
      }}
    >
      {kind === 'icon' ? (item.icon || !dashed ? <i className={`bi ${item.icon || 'bi-circle'}`} style={{ color: ink, fontSize: 'var(--font-size-xs, 12px)' }} /> : null) : (item.number ?? index + 1)}
    </span>
  );
}

function Heading({ item, index, ledger }) {
  const titleType = {
    minWidth: 0, fontSize: 'var(--font-size-sm, 14px)', lineHeight: 'var(--line-height-normal, 1.5)',
    fontWeight: 'var(--bs-font-weight-semibold, 600)', color: 'var(--text-body, #212529)', textWrap: 'pretty',
  };
  return (
    <>
      <span style={{ display: 'flex', flexWrap: ledger ? 'nowrap' : 'wrap', alignItems: 'center', justifyContent: ledger ? 'space-between' : undefined, gap: 'var(--space-1, 4px) var(--space-2, 8px)' }}>
        {item.onSelect ? (
          <button
            type="button"
            data-ak-timeline-link=""
            aria-current={item.current ? 'step' : undefined}
            onClick={() => item.onSelect(item, index)}
            style={{ font: 'inherit', ...titleType, padding: 0, margin: 0, border: 0, background: 'none', textAlign: 'left', color: 'var(--text-link-hover, #005a7d)', cursor: 'pointer' }}
          >{item.title}<MarkerLabel item={item} /></button>
        ) : <span style={titleType}>{item.title}<MarkerLabel item={item} /></span>}
        {item.tag != null && <span style={{ flex: 'none', display: 'inline-flex' }}>{item.tag}</span>}
      </span>
      {item.meta != null && (item.metaTone && item.metaTone !== 'default' ? (
        <span data-timeline-meta-tone={item.metaTone} style={{
          display: 'block', fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
          fontSize: 'var(--font-size-xs, 12px)', fontWeight: 600, lineHeight: 'var(--line-height-normal, 1.5)',
          color: TONES[item.metaTone] || TONES.neutral,
        }}>{item.meta}</span>
      ) : (
        <span style={{
          display: 'block', fontFamily: DATA_FONT, fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)',
          fontSize: 'var(--font-size-xs, 12px)', lineHeight: 'var(--line-height-normal, 1.5)', color: 'var(--text-data, #495057)',
        }}>{item.meta}</span>
      ))}
    </>
  );
}

/* The compact ledger's one line per step: state mark, number and name in a fixed column, what
   happened, the trailing aside and a chevron. With `onSelect` the whole row is a native button
   (disabled while the step is not reached); `stacked` folds name and body into one column and
   drops the aside, for a narrow container. */
function TimelineCompactRow({ item, index, stacked, titleWidth, markerStyle }) {
  const selectable = typeof item.onSelect === 'function';
  const disabled = !!item.disabled;
  const marker = (item.marker || 'dot') === 'dot' ? { ...item, marker: 'icon' } : item;
  const mark = (
    <span aria-hidden="true" style={{ display: 'flex', ...(stacked ? { gridRow: '1 / span 2', alignSelf: 'start' } : null) }}>
      <Marker item={marker} index={index} markerStyle={markerStyle} />
    </span>
  );
  const title = (
    <span data-timeline-title="" style={{
      minWidth: 0, fontSize: 'var(--font-size-sm, 14px)', lineHeight: 'var(--line-height-normal, 1.5)', fontWeight: 'var(--bs-font-weight-semibold, 600)',
      color: disabled ? 'var(--text-secondary, #5a6268)' : 'var(--text-strong, #111827)', overflowWrap: 'anywhere', ...(stacked ? { gridColumn: 2 } : null),
    }}>
      {item.number != null && item.marker !== 'number' && (
        <span style={{ marginRight: 'var(--space-input-padding-y, 6px)', fontFamily: DATA_FONT, fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)', fontSize: 'var(--font-size-label, 11px)', fontWeight: 400, color: 'var(--text-secondary, #5a6268)' }}>{item.number}</span>
      )}
      {item.title}
      <MarkerLabel item={item} />
    </span>
  );
  const body = item.children != null ? (
    <span data-timeline-body="" style={{ display: 'block', minWidth: 0, fontSize: 'var(--font-size-dense, 13px)', lineHeight: 'var(--line-height-normal, 1.5)', color: 'var(--text-body, #212529)', ...(stacked ? { gridColumn: 2 } : null) }}>{item.children}</span>
  ) : <span />;
  const aside = stacked ? null : (
    <span data-timeline-aside="" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2, 8px)', justifySelf: 'end', fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5a6268)', whiteSpace: 'nowrap' }}>
      {item.tag != null && item.tag}{item.aside}
    </span>
  );
  const chevron = selectable ? (
    <span aria-hidden="true" style={{ display: 'flex', justifyContent: 'center', ...(stacked ? { gridColumn: 3, gridRow: '1 / span 2' } : null) }}>
      {disabled ? null : <i className="bi bi-chevron-right" style={{ fontSize: 'var(--icon-sm, 14px)', color: 'var(--text-secondary, #5a6268)' }} />}
    </span>
  ) : null;
  const columns = stacked
    ? `${MARKER} minmax(0, 1fr)${selectable ? ' 14px' : ''}`
    : `${MARKER} ${typeof titleWidth === 'number' ? titleWidth + 'px' : titleWidth} minmax(0, 1fr) auto${selectable ? ' 14px' : ''}`;
  const rowStyle = {
    display: 'grid', gridTemplateColumns: columns, alignItems: 'center', columnGap: stacked ? 10 : 'var(--space-3, 12px)', rowGap: 2,
    width: '100%', boxSizing: 'border-box', margin: 0, padding: '11px 16px', border: 0, borderRadius: 0,
    background: item.attention ? 'var(--pill-warning-bg, #fef3c7)' : 'transparent',
    font: 'inherit', color: 'inherit', textAlign: 'left', cursor: selectable && !disabled ? 'pointer' : 'default',
  };
  const parts = <>{mark}{title}{body}{aside}{chevron}</>;
  return selectable ? (
    <button
      type="button"
      data-ak-timeline-row=""
      data-attention={item.attention ? '' : undefined}
      disabled={disabled || undefined}
      aria-current={item.current ? 'step' : undefined}
      onClick={() => item.onSelect(item, index)}
      style={rowStyle}
      {...timelineItemAttrs(item)}
    >{parts}</button>
  ) : <div data-attention={item.attention ? '' : undefined} style={rowStyle} {...timelineItemAttrs(item)}>{parts}</div>;
}

function TimelineCompactLedger({ items, label, List, markerStyle, titleWidth, stackBelow, style, rest }) {
  const ref = React.useRef(null);
  const size = useElementSize(ref);
  const stacked = stackBelow != null && size.width > 0 && size.width < stackBelow;
  return (
    <List
      ref={ref}
      aria-label={label}
      data-timeline-variant="ledger"
      data-timeline-density="compact"
      data-stacked={stacked ? '' : undefined}
      style={{
        listStyle: 'none', margin: 0, padding: 0, background: 'var(--surface-card, #ffffff)',
        fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)', color: 'var(--text-body, #212529)',
        ...style,
      }}
      {...rest}
    >
      {items.map((item, i) => (
        <li key={item.id ?? i} aria-current={typeof item.onSelect !== 'function' && item.current ? 'step' : undefined}
          style={{ borderTop: i > 0 ? 'var(--border-width, 1px) solid var(--list-divider, #e9ecef)' : 0 }}>
          <TimelineCompactRow item={item} index={i} stacked={stacked} titleWidth={titleWidth} markerStyle={markerStyle} />
        </li>
      ))}
    </List>
  );
}

/**
 * ArkCase Timeline — a vertical list of events or steps, each with a dot,
 * number or icon marker on a hairline connector, a title, data-face meta, an
 * optional tag and an optional body. With `onSelect`, each title area is a
 * native button and the `current` item carries `aria-current="step"`. An item's
 * own `onSelect` makes just its title a link-styled button. `variant="ledger"`
 * is the step ledger of a run overview: square indexes, hairline-divided rows,
 * the tag at the heading's right edge.
 *
 * Opt-in additions for record steppers: an item's `metaTone` turns its meta into a
 * 12px/600 sans status line in the tone's ink ("Overdue — was due 08/12/2026"); an
 * item's `action` puts a button at the row's end (or below its body); the list's
 * `markerStyle="soft"` grounds icon and number markers in the pill tint, `solid` fills them,
 * `dashed` draws an empty dashed disc; an item's own `markerStyle` overrides the list's. An
 * item's `markerLabel` says the marker's state in words after the title (the marker is
 * decorative). `density="compact"` on the ledger is the pipeline as one line per step: the
 * round state marker, the number and name, what happened, an `aside` and a chevron, the whole
 * row a button (natively `disabled` for a step not reached, washed for `attention`).
 */
export function Timeline({ items = [], connected = true, onSelect, as = 'ol', label, variant = 'rail', markerStyle = 'ring', density = 'default', titleWidth = 128, stackBelow = 600, style, ...rest }) {
  const List = as === 'ul' ? 'ul' : 'ol';
  const last = items.length - 1;
  const ledger = variant === 'ledger';
  const compact = ledger && density === 'compact';
  const links = items.some((it) => typeof it.onSelect === 'function');
  React.useEffect(() => { if (links) ensureTimelineLinkStyles(); }, [links]);
  if (compact) {
    return <TimelineCompactLedger items={items} label={label} List={List} markerStyle={markerStyle === 'ring' ? 'soft' : markerStyle} titleWidth={titleWidth} stackBelow={stackBelow} style={style} rest={rest} />;
  }
  const body = (item) => item.children != null && (
    <div style={{ marginTop: 'var(--space-2, 8px)', fontSize: 'var(--font-size-dense, 13px)', lineHeight: 'var(--line-height-normal, 1.5)', color: 'var(--text-body, #212529)' }}>
      {item.children}
    </div>
  );
  const actionNode = (item) => {
    const a = item.action;
    if (!a) return null;
    if (React.isValidElement(a)) return a;
    return (
      <Button size="sm" variant={a.variant || 'secondary'} outline={a.variant ? undefined : true} icon={a.icon} disabled={a.disabled} onClick={a.onClick} style={{ whiteSpace: 'nowrap' }}>
        {a.label}
      </Button>
    );
  };
  const withAction = (item, content) => {
    const a = actionNode(item);
    if (!a) return content;
    if (item.actionPlacement === 'below') {
      return <>{content}<div data-timeline-action="" style={{ marginTop: 'var(--space-2, 8px)' }}>{a}</div></>;
    }
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 'var(--space-3, 12px)', alignItems: 'start' }}>
        <div style={{ minWidth: 0 }}>{content}</div>
        <div data-timeline-action="" style={{ display: 'flex', alignItems: 'center' }}>{a}</div>
      </div>
    );
  };
  if (ledger) {
    return (
      <List
        aria-label={label}
        data-timeline-variant="ledger"
        style={{
          listStyle: 'none', margin: 0, padding: 0, background: 'var(--surface-card, #ffffff)',
          fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)', color: 'var(--text-body, #212529)',
          ...style,
        }}
        {...rest}
      >
        {items.map((item, i) => (
          <li
            key={item.id ?? i}
            aria-current={!item.onSelect && item.current ? 'step' : undefined}
            style={{
              display: 'grid', gridTemplateColumns: '34px minmax(0, 1fr)', columnGap: 14, padding: 18,
              borderBottom: i < last ? 'var(--border-width, 1px) solid var(--border-color, #dee2e6)' : 0,
            }}
          >
            <TimelineLedgerMarker item={item} index={i} />
            <div style={{ minWidth: 0, alignSelf: 'center' }}>
              {withAction(item, <><Heading item={item} index={i} ledger />{body(item)}</>)}
            </div>
          </li>
        ))}
      </List>
    );
  }
  return (
    <List
      aria-label={label}
      style={{
        listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column',
        fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)', color: 'var(--text-body, #212529)',
        ...style,
      }}
      {...rest}
    >
      {items.map((item, i) => {
        const dot = (item.marker || 'dot') === 'dot';
        const current = !!item.current;
        const lineTop = connected && i > 0 ? LINE_COLOR : 'transparent';
        const lineBottom = connected && i < last ? LINE_COLOR : 'transparent';
        return (
          <li
            key={item.id ?? i}
            aria-current={!onSelect && !item.onSelect && current ? 'step' : undefined}
            style={{ display: 'grid', gridTemplateColumns: `${MARKER} minmax(0, 1fr)`, columnGap: 'var(--space-3, 12px)' }}
          >
            <span aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ width: LINE, flex: 'none', height: dot ? 'calc(var(--space-1, 4px) * 2.75)' : 'var(--space-1, 4px)', background: lineTop }} />
              <Marker item={item} index={i} markerStyle={markerStyle} />
              <span style={{ width: LINE, flex: 1, minHeight: 'var(--space-1, 4px)', background: lineBottom }} />
            </span>
            <div style={{ minWidth: 0, paddingTop: 'var(--space-input-padding-y, 6px)', paddingBottom: i < last ? 'var(--space-4, 16px)' : 0 }}>
              {withAction(item, <>{onSelect && !item.onSelect ? (
                <button
                  type="button"
                  aria-current={current ? 'step' : undefined}
                  onClick={() => onSelect(item, i)}
                  style={{
                    display: 'block', width: 'calc(100% + var(--space-2, 8px) * 2)', boxSizing: 'border-box',
                    margin: 'calc(var(--space-input-padding-y, 6px) * -1) calc(var(--space-2, 8px) * -1) 0',
                    padding: 'calc(var(--space-input-padding-y, 6px) - var(--border-width, 1px)) calc(var(--space-2, 8px) - var(--border-width, 1px))',
                    border: `var(--border-width, 1px) solid ${current ? 'var(--bs-primary, #0079a8)' : 'transparent'}`,
                    borderRadius: 'var(--radius-md, 5px)',
                    background: current ? 'var(--tint-primary-selected, rgba(0, 121, 168, 0.1))' : 'transparent',
                    font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer',
                  }}
                >
                  <Heading item={item} index={i} />
                </button>
              ) : <Heading item={item} index={i} />}
              {body(item)}</>)}
            </div>
          </li>
        );
      })}
    </List>
  );
}
