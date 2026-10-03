import React from 'react';
import { StatusPill } from './StatusPill.jsx';

const PALETTE = {
  primary: 'var(--bs-primary, #0079a8)', secondary: 'var(--bs-gray-600, #6c757d)', success: 'var(--bs-success, #00b532)',
  danger: 'var(--bs-danger, #d83506)', warning: 'var(--bs-warning, #ff9a15)', info: 'var(--bs-info, #0a7a90)', light: 'var(--bs-gray-600, #6c757d)',
  navy: 'var(--text-navy, #073652)',
};

/* The eyebrow label's ink per colour: the text-safe partner of each tint, so the 11px caption
   clears AA on its own ground in every theme. */
const EYEBROW_INK = {
  primary: 'var(--text-link-hover, #005a7d)', info: 'var(--text-link-hover, #005a7d)', navy: 'var(--text-navy, #073652)',
  success: 'var(--pill-success-fg, #15803d)', danger: 'var(--pill-danger-fg, #991b1b)', warning: 'var(--pill-warning-fg, #92400e)',
  secondary: 'var(--text-secondary, #5a6268)', light: 'var(--text-secondary, #5a6268)',
};

/**
 * ArkCase MetricCard — KPI tile with a tinted background, left accent rule,
 * and an optional up/down trend line. Recreation of MetricCardComponent.
 *
 * `dataFont` (opt-in) renders the big value in var(--font-data) with
 * tabular-nums: display-scale amounts and counts keep the data font at every
 * size, so a stacked set of metrics aligns and a total lines up with the mono
 * column it sums. Display weight comes from size and weight — never from
 * switching to the serif, whose figures are proportional.
 *
 * `variant="surface"` swaps the tint and accent rule for the card surface;
 * `icon`, `status`, `unit` and `delta` extend the rows; `onClick` renders the
 * tile as a native button and `pressed` exposes aria-pressed.
 *
 * `size="sm"` is the compact strip tile (a 20px/600 value, a one-line 13px caption) that
 * reserve, report and audit strips use; `labelVariant="eyebrow"` sets the caption as an
 * 11px uppercase label in the colour's text-safe ink; `color="navy"` is the navy wash.
 */
const DELTA_TONES = {
  success: 'var(--pill-success-fg, #15803d)', danger: 'var(--text-overdue, #991b1b)',
  warning: 'var(--text-due-soon, #92400e)', neutral: 'var(--text-secondary, #5a6268)',
};
const DATA_FONT = "var(--font-data, 'Source Code Pro', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace)";
/* A value made of digits and figure punctuation: counts, amounts, percentages, durations. */
const isNumericValue = (v) => v != null && /^[-+\d.,%:\s]+$/.test(String(v));

export function MetricCard({
  label, value, subtext, trend = 'none', trendColor = 'secondary',
  color = 'info', borderStart = true, dataFont: dataFontProp,
  variant = 'tinted', icon, status, unit, delta, deltaTone = 'neutral', onClick, pressed,
  size = 'md', labelVariant = 'default',
  onMouseEnter, onMouseLeave, style, ...rest
}) {
  const sm = size === 'sm';
  /* `quiet` is the unboxed summary figure: no ground, rule or shadow; the caption wraps; the data
     face follows the value unless the host says otherwise. */
  const quiet = variant === 'quiet';
  const dataFont = dataFontProp != null ? !!dataFontProp : quiet && isNumericValue(value);
  const eyebrow = labelVariant === 'eyebrow';
  const [hover, setHover] = React.useState(false);
  const accent = PALETTE[color] || PALETTE.info;
  const trendCol = trendColor === 'secondary' ? 'var(--text-data, #495057)' : PALETTE[trendColor] || 'var(--text-data, #495057)';
  const tintBg = color === 'light' ? 'var(--surface-secondary, #f8f9fa)' : color === 'navy' ? 'var(--surface-navy-subtle, #eaf1f6)' : hexA(accent, 0.1);
  const interactive = typeof onClick === 'function';
  const surface = variant === 'surface';
  const selected = interactive && pressed === true;
  // Inside a <button> only phrasing content is valid, so the rows become block spans.
  const Row = interactive ? 'span' : 'div';
  const block = interactive ? { display: 'block' } : null;
  const labelRow = icon || status;

  const primaryEdge = 'var(--bs-primary, #0079a8)';
  const shadowSm = 'var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04))';
  const shadowMd = 'var(--shadow-md, 0 2px 4px rgba(0,0,0,0.05), 0 4px 12px rgba(0,0,0,0.10))';
  const highlighted = interactive && (selected || hover);
  const shadows = [surface ? (hover ? shadowMd : shadowSm) : (interactive && hover ? shadowMd : null), selected ? `inset 0 0 0 1px ${primaryEdge}` : null].filter(Boolean);
  let base;
  if (quiet) {
    base = { backgroundColor: 'transparent', border: 0, borderRadius: 0, boxShadow: 'none', padding: '4px 0', height: 'auto' };
  } else if (surface) {
    base = {
      backgroundColor: 'var(--surface-card, #fff)',
      borderRadius: 'var(--radius-lg, 0.5rem)',
      padding: sm ? '12px 14px' : 'var(--space-4, 1rem)',
      height: '100%',
      border: `1px solid ${highlighted ? primaryEdge : 'var(--border-color, #dee2e6)'}`,
    };
  } else {
    const edge = highlighted ? primaryEdge : borderStart ? 'transparent' : 'var(--border-color, #dee2e6)';
    base = {
      backgroundColor: tintBg,
      borderRadius: 'var(--radius-md, 5px)',
      padding: sm ? '12px 14px' : '0.875rem',
      height: '100%',
      border: `1px solid ${edge}`,
      borderLeft: borderStart ? `4px solid ${accent}` : `1px solid ${edge}`,
    };
  }
  if (!quiet && shadows.length) base.boxShadow = shadows.join(', ');
  const buttonReset = interactive
    ? { display: 'block', width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer', transition: 'border-color .15s ease, box-shadow .15s ease' }
    : null;

  /* The caption's type: the 14px default, the one-line 13px strip caption, or the eyebrow. */
  const captionType = eyebrow
    ? { fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, letterSpacing: 'var(--letter-spacing-wide, 0.025em)', textTransform: 'uppercase', color: EYEBROW_INK[color] || EYEBROW_INK.secondary }
    : { fontSize: sm ? 'var(--font-size-dense, 13px)' : '0.875rem', color: 'var(--text-secondary, #5a6268)' };
  const oneLine = sm && !quiet ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : quiet ? { whiteSpace: 'normal', overflowWrap: 'anywhere' } : null;
  const captionGap = sm || eyebrow ? '0.25rem' : '0.375rem';
  const content = (
    <>
      {labelRow ? (
        <Row style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', ...captionType, marginBottom: captionGap }}>
          {icon && <i className={`bi ${icon}`} aria-hidden="true" style={{ fontSize: 'var(--font-size-md, 1rem)', flex: '0 0 auto' }} />}
          <span style={{ flex: 1, minWidth: 0, ...oneLine }} title={sm && typeof label === 'string' ? label : undefined}>{label}</span>
          {status && <StatusPill tone={status.tone} label={status.label} style={{ flex: '0 0 auto' }} />}
        </Row>
      ) : (
        <Row data-metric-label="" title={sm && typeof label === 'string' ? label : undefined} style={{ ...block, ...captionType, ...oneLine, marginBottom: captionGap }}>{label}</Row>
      )}
      <Row data-metric-value="" style={{ ...block, fontSize: sm ? 'var(--font-size-lg, 1.25rem)' : '1.5rem', fontWeight: sm ? 600 : 700, lineHeight: sm ? 1.25 : 1.2, marginBottom: '0.125rem', color: 'var(--text-body, #212529)', fontFamily: dataFont ? DATA_FONT : undefined, fontVariantNumeric: dataFont ? 'var(--font-numeric-feature, tabular-nums)' : undefined }}>
        {value}
        {unit && (
          <span style={{ marginLeft: '0.375rem', fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)', fontSize: 'var(--font-size-dense, 0.8125rem)', fontWeight: 400, color: 'var(--text-secondary, #5a6268)' }}>{unit}</span>
        )}
      </Row>
      {subtext && (
        <Row style={{ fontSize: '0.875rem', color: 'var(--text-secondary, #5a6268)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          {trend !== 'none' && (
            <span style={{ color: trendCol, fontWeight: 600 }}>{trend === 'up' ? '↑' : '↓'}</span>
          )}
          {subtext}
        </Row>
      )}
      {delta != null && delta !== false && delta !== '' && (
        <Row style={{ ...block, marginTop: '0.25rem', fontFamily: DATA_FONT, fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)', fontSize: 'var(--font-size-xs, 0.75rem)', color: DELTA_TONES[deltaTone] || DELTA_TONES.neutral }}>{delta}</Row>
      )}
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={typeof pressed === 'boolean' ? pressed : undefined}
        onMouseEnter={(event) => { setHover(true); onMouseEnter && onMouseEnter(event); }}
        onMouseLeave={(event) => { setHover(false); onMouseLeave && onMouseLeave(event); }}
        data-metric-quiet={quiet ? '' : undefined}
        style={{ ...base, ...buttonReset, ...style }}
        {...rest}
      >
        {content}
      </button>
    );
  }
  return (
    <div data-metric-quiet={quiet ? '' : undefined} style={{ ...base, ...style }} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} {...rest}>
      {content}
    </div>
  );
}

/* The palette entries are `var(--token, #rrggbb)` strings, so a maths helper has to read the
   fallback out rather than assume the whole value is a hex. parseInt('ar(--bs-...', 16) reads the
   leading 'a' as 10 and yields rgb(0, 0, 10) -- a near-black tint where a green one belongs. This
   was already true of `primary`, the one entry that carried a token before Phase 4; the token
   sweep simply made it true of the rest. */
function hexOf(value) {
  const m = String(value).match(/#[0-9a-fA-F]{6}\b(?!.*#[0-9a-fA-F]{6})/);
  return m ? m[0] : String(value);
}

function hexA(hex, a) {
  const n = parseInt(hexOf(hex).slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
