import { akStyleDocument } from '@/arkcase-style';
import React from 'react';
import { Button } from '../actions/Button.jsx';

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

/* `markerStyle="soft"` grounds: the pill tint under the tone's ink, no ring — the stepper the
   Workers' Compensation notices, workflows and approvals draw. */
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

/* A per-item `onSelect` makes the title a link; its hover needs a pseudo-class, injected once. */
function ensureTimelineLinkStyles() {
  if (typeof document === 'undefined' || akStyleDocument.getElementById('ak-timeline-link-css')) return;
  const s = akStyleDocument.createElement('style');
  s.id = 'ak-timeline-link-css';
  s.textContent = '[data-ak-timeline-link]:hover{color:var(--text-link, #0079a8) !important;text-decoration:underline}';
  akStyleDocument.head.appendChild(s);
}

function Marker({ item, index, markerStyle }) {
  const color = TONES[item.tone] || TONES.primary;
  const kind = item.marker || 'dot';
  if (kind === 'dot') {
    return <span style={{ width: DOT, height: DOT, flex: 'none', borderRadius: '50%', background: color }} />;
  }
  const soft = markerStyle === 'soft' ? SOFT_GROUNDS[item.tone] || SOFT_GROUNDS.primary : null;
  const solid = markerStyle === 'solid';
  const ink = soft ? soft.fg : solid ? 'var(--text-on-primary, #ffffff)' : color;
  return (
    <span
      data-icon-tone="current"
      data-timeline-marker={soft ? 'soft' : solid ? 'solid' : 'ring'}
      style={{
        width: MARKER, height: MARKER, flex: 'none', boxSizing: 'border-box',
        display: 'grid', placeItems: 'center', borderRadius: '50%',
        border: soft ? 0 : `${LINE} solid ${color}`, background: soft ? soft.bg : solid ? color : 'var(--surface-card, #ffffff)', color: ink,
        fontFamily: DATA_FONT, fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)',
        fontSize: 'var(--font-size-label, 11px)', fontWeight: 'var(--bs-font-weight-semibold, 600)', lineHeight: 1,
      }}
    >
      {kind === 'icon' ? <i className={`bi ${item.icon || 'bi-circle'}`} style={{ color: ink, fontSize: 'var(--font-size-xs, 12px)' }} /> : (item.number ?? index + 1)}
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
          >{item.title}</button>
        ) : <span style={titleType}>{item.title}</span>}
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
 * `markerStyle="soft"` grounds icon and number markers in the pill tint, `solid` fills them.
 */
export function Timeline({ items = [], connected = true, onSelect, as = 'ol', label, variant = 'rail', markerStyle = 'ring', style, ...rest }) {
  const List = as === 'ul' ? 'ul' : 'ol';
  const last = items.length - 1;
  const ledger = variant === 'ledger';
  const links = items.some((it) => typeof it.onSelect === 'function');
  React.useEffect(() => { if (links) ensureTimelineLinkStyles(); }, [links]);
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
