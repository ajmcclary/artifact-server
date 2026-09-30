import React from 'react';

const TONES = {
  attention: { fg: 'var(--pill-warning-fg, #92400e)', bg: 'var(--pill-warning-bg, #fef3c7)', rail: 'var(--bs-warning, #ff9a15)' },
  running:   { fg: 'var(--text-link-hover, #005a7d)', bg: 'rgba(0,121,168,.08)', rail: 'var(--bs-primary, #0079a8)' },
  settled:   { fg: 'var(--pill-success-fg, #15803d)', bg: 'var(--pill-success-bg, #dcfce7)', rail: 'var(--bs-success, #00b532)' },
  failed:    { fg: 'var(--pill-danger-fg, #991b1b)', bg: 'var(--pill-danger-bg, #fee2e2)', rail: 'var(--bs-danger, #d83506)' },
  neutral:   { fg: 'var(--text-data, #495057)', bg: 'var(--surface-secondary, #f8f9fa)', rail: 'var(--border-color-strong, #ced4da)' },
};

/**
 * ArkCase GroupBand — the band that heads a group of rows inside a record list.
 * Left rail, tinted fill, the group's name and count on the left, the rule that
 * put rows in it on the right. Harvested from the ExtractionKit run list, where
 * the three groups are the three questions a reader arrives with.
 *
 * With `onToggle` the band is a native button that discloses its rows: it reports
 * `aria-expanded` from `open`, names the rows it controls with `controls`, and ends in a
 * chevron. `sticky` pins it to the top of its scroller on an opaque fill (the tint is
 * layered over the card colour so rows never show through). `dot` adds a leading status
 * dot in the tone's rail colour, or in the CSS colour it is given.
 */
export function GroupBand({ label, count, note, tone = 'neutral', open, onToggle, controls, sticky, dot, style, ...rest }) {
  const t = TONES[tone] || TONES.neutral;
  const toggle = typeof onToggle === 'function';
  const [focusVisible, setFocusVisible] = React.useState(false);
  const [hover, setHover] = React.useState(false);
  const fill = hover ? 'linear-gradient(var(--tint-primary-hover, rgba(0,121,168,.05)), var(--tint-primary-hover, rgba(0,121,168,.05))), ' : '';
  const dotColor = typeof dot === 'string' ? dot : t.rail;
  const Tag = toggle ? 'button' : 'div';
  const name = (
    <span style={{ fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.fg }}>
      {label}{count != null && ' · ' + count}
    </span>
  );
  const noteNode = note ? <span style={{ fontSize: 'var(--font-size-label, 11px)', color: t.fg }}>{note}</span> : null;
  const interactive = toggle ? {
    type: 'button',
    'aria-expanded': !!open,
    'aria-controls': controls,
    onClick: onToggle,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: (e) => { try { setFocusVisible(e.target.matches(':focus-visible')); } catch (_) { setFocusVisible(true); } },
    onBlur: () => setFocusVisible(false),
  } : null;
  return (
    <Tag
      {...interactive}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '8px 16px',
        background: sticky || hover ? fill + 'linear-gradient(' + t.bg + ', ' + t.bg + '), var(--surface-card, #fff)' : t.bg,
        borderTop: '1px solid var(--border-color, #dee2e6)',
        borderBottom: '1px solid var(--border-color, #dee2e6)',
        borderLeft: '3px solid ' + t.rail,
        ...(toggle ? { width: '100%', margin: 0, borderRight: 0, font: 'inherit', textAlign: 'left', cursor: 'pointer', outline: focusVisible ? '2px solid var(--bs-primary, #0079a8)' : 'none', outlineOffset: -2 } : null),
        ...(sticky ? { position: 'sticky', top: 0, zIndex: 1 } : null),
        ...style,
      }}
      {...rest}
    >
      {dot ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span aria-hidden="true" data-group-band-dot="" style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flex: 'none' }} />
          {name}
        </span>
      ) : name}
      {toggle ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          {noteNode}
          <i aria-hidden="true" className={'bi ' + (open ? 'bi-chevron-down' : 'bi-chevron-right')} style={{ width: 16, textAlign: 'center', fontSize: 'var(--font-size-label, 11px)', color: t.fg }} />
        </span>
      ) : noteNode}
    </Tag>
  );
}
