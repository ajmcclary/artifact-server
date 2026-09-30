import React from 'react';
import { Button } from '../actions/Button.jsx';
import { VisuallyHidden } from '../utilities/VisuallyHidden.jsx';

/* Emphasis re-weights the same surface: `primary` is the panel a page leads with (a navy-subtle
   cap, stronger hairlines, the card lift); `reference` is supporting detail that sits flat. */
const RECORD_PANEL_EMPHASIS = {
  default: {
    border: 'var(--border-color, #dee2e6)',
    shadow: 'var(--shadow-sm, 0 1px 2px rgba(0,0,0,.06), 0 1px 3px rgba(0,0,0,.04))',
    cap: 'var(--surface-secondary, #f8f9fa)',
    capRule: 'var(--border-color, #dee2e6)',
  },
  primary: {
    border: 'var(--border-color-strong, #ced4da)',
    shadow: 'var(--shadow-card, 0 1px 3px rgba(7, 54, 82, 0.10))',
    cap: 'var(--surface-navy-subtle, #eaf1f6)',
    capRule: 'var(--border-color-strong, #ced4da)',
  },
  reference: {
    border: 'var(--border-color, #dee2e6)',
    shadow: 'none',
    cap: 'var(--surface-secondary, #f8f9fa)',
    capRule: 'var(--border-color, #dee2e6)',
  },
};

const RECORD_PANEL_ALIGN = { baseline: 'baseline', start: 'flex-start', center: 'center' };

/* Tone recolours the frame for a panel whose content is an alarm or a caution — the
   Enforcement and Subrogation cards: a pill-border hairline, a tinted cap and the pill ink on
   the label. Tone wins over emphasis for the border and cap; the shadow stays the emphasis's. */
const RECORD_PANEL_TONE = {
  danger: { border: 'var(--pill-danger-border, #f5c2bd)', cap: 'var(--tint-danger-hover, rgba(216,53,6,.05))', capRule: 'var(--pill-danger-border, #f5c2bd)', ink: 'var(--pill-danger-fg, #991b1b)' },
  warning: { border: 'var(--pill-warning-border, #ffd894)', cap: 'var(--pill-warning-bg, #fef3c7)', capRule: 'var(--pill-warning-border, #ffd894)', ink: 'var(--pill-warning-fg, #92400e)' },
  success: { border: 'var(--pill-success-border, #a7e3ba)', cap: 'var(--pill-success-bg, #dcfce7)', capRule: 'var(--pill-success-border, #a7e3ba)', ink: 'var(--pill-success-fg, #15803d)' },
};

/* Cap grounds a host can pick independently of emphasis — the five the Workers' Compensation
   cards draw. `solid` is the filled primary cap with a sentence-case white label. */
const RECORD_PANEL_CAP = {
  secondary: 'var(--surface-secondary, #f8f9fa)',
  navy: 'var(--surface-navy-subtle, #eaf1f6)',
  tint: 'var(--tint-primary-selected, rgba(0,121,168,.10))',
  solid: 'var(--bs-primary, #0079a8)',
  plain: 'var(--surface-card, #fff)',
};

/**
 * ArkCase RecordPanel — the record surface. A white panel with a tinted cap that
 * names what the panel holds, an optional right-aligned route or provenance
 * string, and an optional footer band for the sentence that qualifies the data.
 * Harvested from the ExtractionKit console (2026), where this cap/body/footer
 * shape carries every ledger, table and reading on the run surfaces.
 *
 * `icon`, `emphasis`, `capAlign`, `metaWrap` and `collapsible` are additive: without
 * them the panel renders exactly as the plain cap/body/footer surface. `collapsible`
 * turns the meta slot into an Inspect/Close button that swaps a one-line preview for
 * the body, capped at `maxHeight` and scrolled; `collapsible.placement="strip"` moves
 * the toggle to a full-width strip under the body instead.
 *
 * The Workers' Compensation cards add the rest, all additive too: `actions` (a sans
 * cap slot for buttons, links and audit lines), `tone` (danger / warning / success
 * frames), `capTone` (the cap ground: secondary, navy, tint, solid primary or plain),
 * `capSize="md"` (their 12px cap label), `footerVariant="note"` (an unbanded footnote)
 * and a CSS `padded` value for row lists.
 */
export function RecordPanel({
  label, subtitle, meta, actions, footer, footerVariant = 'band', padded = false, width, icon,
  emphasis = 'default', tone = 'default', capTone = 'auto', capSize = 'sm',
  capAlign = 'baseline', metaWrap = false, collapsible, style, children, ...rest
}) {
  const base = RECORD_PANEL_EMPHASIS[emphasis] || RECORD_PANEL_EMPHASIS.default;
  const toned = RECORD_PANEL_TONE[tone] || null;
  const solid = capTone === 'solid';
  const capBg = RECORD_PANEL_CAP[capTone] || (toned ? toned.cap : base.cap);
  const capRule = solid ? RECORD_PANEL_CAP.solid : capTone === 'plain' ? 'var(--list-divider, #e9ecef)' : toned ? toned.capRule : base.capRule;
  const frame = toned ? toned.border : base.border;
  const md = capSize === 'md';
  const align = RECORD_PANEL_ALIGN[capAlign] || RECORD_PANEL_ALIGN.baseline;
  const bodyId = React.useId();
  const labelText = typeof label === 'string' ? label : undefined;
  const open = collapsible ? !!collapsible.open : true;
  const strip = !!collapsible && collapsible.placement === 'strip';
  const [stripHover, setStripHover] = React.useState(false);

  let toggle = null;
  if (collapsible && !strip) {
    const text = open ? (collapsible.closeLabel || 'Close details') : (collapsible.openLabel || 'Inspect record');
    toggle = (
      <Button
        size="sm"
        variant="secondary"
        outline
        icon={open ? 'bi-chevron-up' : 'bi-chevron-down'}
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={labelText ? text + ': ' + labelText : undefined}
        data-record-panel-toggle=""
        onClick={collapsible.onToggle}
        style={{ fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)', fontSize: 'var(--font-size-label, 11px)', whiteSpace: 'nowrap' }}
      >
        {text}
      </Button>
    );
  }

  const hasActions = actions != null && actions !== false && actions !== '';
  const hasCap = label || subtitle || meta || icon || toggle || hasActions;
  const maxHeight = collapsible && collapsible.maxHeight != null ? collapsible.maxHeight : 560;
  const padding = padded === true ? 'var(--space-card-padding, 14px)' : (typeof padded === 'number' || typeof padded === 'string') ? padded : undefined;

  /* The label ink: white on the solid cap, the tone's pill ink on a toned frame, the 12px
     link-hover ink of the `md` cap, otherwise the brand navy. */
  const labelInk = solid ? 'var(--text-on-primary, #fff)' : toned ? toned.ink : md ? 'var(--text-link-hover, #005a7d)' : 'var(--text-navy, #073652)';
  const labelType = solid
    ? { fontSize: 'var(--font-size-dense, 13px)', fontWeight: 600 }
    : md
      ? { fontSize: 'var(--font-size-xs, 12px)', fontWeight: 600, letterSpacing: 'var(--letter-spacing-wide, 0.025em)', textTransform: 'uppercase' }
      : { fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' };
  const capPadding = solid ? '8px 14px' : md ? '10px 14px' : '11px 14px';
  const sideInk = solid ? 'var(--text-on-primary, #fff)' : 'var(--text-secondary, #5a6268)';

  let stripButton = null;
  if (strip) {
    const verb = open ? (collapsible.closeLabel || 'Collapse') : (collapsible.openLabel || 'Expand');
    const hasPreview = collapsible.preview != null && collapsible.preview !== '';
    stripButton = (
      <button
        type="button"
        data-record-panel-strip=""
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={collapsible.onToggle}
        onMouseEnter={() => setStripHover(true)}
        onMouseLeave={() => setStripHover(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box',
          padding: '8px 14px', margin: 0, border: 0, borderTop: '1px solid var(--list-divider, #e9ecef)',
          background: stripHover ? 'var(--surface-canvas, #f1f5f7)' : 'var(--surface-secondary, #f8f9fa)',
          font: 'inherit', fontSize: 'var(--font-size-xs, 12px)', lineHeight: 1.5, color: 'var(--text-secondary, #5a6268)',
          textAlign: 'left', cursor: 'pointer',
        }}
      >
        <i aria-hidden="true" className={'bi ' + (open ? 'bi-chevron-down' : 'bi-chevron-right')} style={{ flex: '0 0 auto', fontSize: 'var(--icon-xs, 12px)' }} />
        <VisuallyHidden>{verb + (labelText ? ' ' + labelText : '') + (hasPreview ? ': ' : '')}</VisuallyHidden>
        {hasPreview && <span data-record-panel-preview="" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{collapsible.preview}</span>}
      </button>
    );
  }

  let body;
  if (collapsible && !strip) {
    body = open ? (
      <div
        id={bodyId}
        data-record-panel-body=""
        role={labelText ? 'region' : undefined}
        aria-label={labelText}
        tabIndex={0}
        style={{ padding: 16, maxHeight, overflow: 'auto', background: 'var(--surface-card, #fff)' }}
      >
        {children}
      </div>
    ) : (
      <div data-record-panel-preview="" style={{ padding: '12px 16px', fontSize: 'var(--font-size-xs, 12px)', lineHeight: 1.55, color: 'var(--text-secondary, #5a6268)', overflowWrap: 'anywhere' }}>
        {collapsible.preview}
      </div>
    );
  } else if (strip) {
    const capped = collapsible.maxHeight != null;
    body = open ? (
      <div
        id={bodyId}
        data-record-panel-body=""
        role={capped && labelText ? 'region' : undefined}
        aria-label={capped ? labelText : undefined}
        tabIndex={capped ? 0 : undefined}
        style={{ padding, ...(capped ? { maxHeight: collapsible.maxHeight, overflow: 'auto' } : null) }}
      >
        {children}
      </div>
    ) : null;
  } else {
    body = <div style={padding != null ? { padding } : undefined}>{children}</div>;
  }

  return (
    <div
      data-record-panel=""
      data-record-panel-emphasis={emphasis !== 'default' ? emphasis : undefined}
      data-record-panel-tone={toned ? tone : undefined}
      data-record-panel-cap-tone={capTone !== 'auto' ? capTone : undefined}
      style={{
        background: 'var(--surface-card, #fff)',
        border: '1px solid ' + frame,
        borderRadius: 'var(--radius-md, 5px)',
        boxShadow: base.shadow,
        overflow: 'hidden',
        width,
        ...style,
      }}
      {...rest}
    >
      {hasCap && (
        <div
          data-record-panel-cap=""
          data-icon-tone={solid ? 'current' : undefined}
          style={{
            display: 'flex', alignItems: align, justifyContent: 'space-between', gap: 10, padding: capPadding,
            background: capBg, borderBottom: '1px solid ' + capRule,
            color: solid ? 'var(--text-on-primary, #fff)' : undefined,
            ...(capAlign === 'center' ? { minHeight: 46, boxSizing: 'border-box' } : null),
            ...(metaWrap ? { flexWrap: 'wrap', rowGap: 8 } : null),
          }}
        >
          <div style={{ display: 'flex', alignItems: align, gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
            {(label || icon) && (
              <span data-record-panel-label="" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, ...labelType, color: labelInk }}>
                {icon && <i aria-hidden="true" className={'bi ' + icon} style={{ fontSize: 'var(--icon-md, 16px)', fontWeight: 400, lineHeight: 1 }} />}
                {label}
              </span>
            )}
            {subtitle && <span style={{ fontSize: 'var(--font-size-xs, 12px)', color: sideInk }}>{subtitle}</span>}
          </div>
          {(meta || toggle || hasActions) && (
            <span data-record-panel-aside="" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0, flexWrap: metaWrap ? 'wrap' : undefined }}>
              {meta && (
                <span data-record-panel-meta="" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0, fontFamily: 'var(--font-data, monospace)', fontSize: 'var(--font-size-label, 11px)', color: sideInk, whiteSpace: metaWrap ? 'normal' : 'nowrap', overflowWrap: metaWrap ? 'anywhere' : undefined }}>
                  {meta}
                </span>
              )}
              {hasActions && (
                <span data-record-panel-actions="" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0, ...(metaWrap ? { flexWrap: 'wrap', rowGap: 6 } : null), fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)', fontSize: 'var(--font-size-xs, 12px)', color: sideInk, whiteSpace: metaWrap ? 'normal' : 'nowrap' }}>
                  {actions}
                </span>
              )}
              {toggle}
            </span>
          )}
        </div>
      )}
      {body}
      {stripButton}
      {footer && (footerVariant === 'note' ? (
        <div data-record-panel-footer="note" style={{ padding: '0 14px 12px', fontSize: 'var(--font-size-xs, 12px)', lineHeight: 1.5, color: 'var(--text-secondary, #5a6268)' }}>{footer}</div>
      ) : (
        <div data-record-panel-footer="" style={{ padding: '10px 14px', borderTop: '1px solid var(--border-color, #dee2e6)', background: 'var(--surface-secondary, #f8f9fa)', fontSize: 'var(--font-size-xs, 12px)', lineHeight: 1.5, color: 'var(--text-data, #495057)' }}>{footer}</div>
      ))}
    </div>
  );
}
