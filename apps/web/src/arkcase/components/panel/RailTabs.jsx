import React from 'react';
import { Tooltip } from '../feedback/Tooltip.jsx';
import { rovingKeyDown } from '../utilities/a11y-keys.jsx';

/**
 * ArkCase RailTabs — the vertical tab strip an inspector hangs off. A 36px column
 * (`panel-rail-width`) the full height of the workspace, on the card surface with a rule on
 * its inward edge: one toggle per inspector view — Comments, Details, Files, Versions —
 * each an icon, an optional count pill and the view's name set vertically in small caps,
 * the entries sharing the height equally with a divider between them. The pressed entry
 * is the open view; pressing it again closes the inspector, because the host treats a
 * select of the active id as a close. A 32px footer slot takes the inspector's pin so it
 * sits on the same baseline as every panel pin.
 *
 * Harvested from the Artifacts review workstation's hand-built rail. The strip owns no
 * state: `active` and `onSelect` are the host's. Arrow Up / Down, Home and End move focus
 * between entries; each entry's tooltip opens away from the edge the strip docks to.
 */

const DIVIDER = '1px solid var(--list-divider, #e9ecef)';

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

const PILL = {
  primary: { fontWeight: 600, background: 'var(--tint-primary-selected, rgba(0,121,168,.10))', color: 'var(--text-link-on-tint, #00688f)' },
  neutral: { fontWeight: 400, background: 'var(--surface-canvas, #f1f5f7)', color: 'var(--text-data, #495057)' },
};

function RailTab({ item, pressed, divider, labels, placement, onSelect, reduce }) {
  const [hover, setHover] = React.useState(false);
  const hasCount = item.count != null && item.count !== '';
  const name = item.ariaLabel != null ? item.ariaLabel : item.label + (hasCount ? ' — ' + item.count : '');
  const lit = pressed || hover;
  const pill = PILL[item.countTone] || PILL.primary;
  return (
    <Tooltip
      label={name}
      placement={placement}
      style={{ flex: '1 1 0', minHeight: 0, display: 'flex', borderTop: divider ? DIVIDER : 0 }}
    >
      <button
        type="button"
        data-rail-tab={item.id}
        aria-pressed={pressed}
        aria-label={name}
        onClick={() => onSelect && onSelect(item.id)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          flex: '1 1 auto', width: '100%', minHeight: 0, overflow: 'hidden',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
          padding: '10px 0', border: 0, borderRadius: 0, font: 'inherit', cursor: 'pointer',
          background: pressed ? 'var(--tint-primary-selected, rgba(0,121,168,.10))' : hover ? 'var(--tint-primary-hover, rgba(0,121,168,.05))' : 'transparent',
          boxShadow: pressed ? `inset ${placement === 'left' ? 3 : -3}px 0 var(--bs-primary, #0079a8)` : undefined,
          color: lit ? 'var(--text-link-on-tint, #00688f)' : 'var(--text-secondary, #5a6268)',
          /* The shared :focus-visible outline, drawn inside so the strip's edges never clip it. */
          outlineOffset: -3,
          transition: reduce ? 'none' : 'background-color .15s ease, color .15s ease',
        }}
      >
        {item.icon && <i aria-hidden="true" className={'bi ' + item.icon} style={{ flex: 'none', width: 'var(--icon-lg, 20px)', height: 'var(--icon-lg, 20px)', fontSize: 'var(--icon-lg, 20px)', lineHeight: 1 }} />}
        {hasCount && (
          <span aria-hidden="true" style={{
            flex: 'none', padding: '0 5px', borderRadius: 'var(--radius-pill, 10px)',
            fontFamily: 'var(--font-data, ui-monospace, monospace)', fontSize: 'var(--font-size-label, 11px)', lineHeight: '16px',
            ...pill,
          }}>{item.count}</span>
        )}
        {labels && (
          <span aria-hidden="true" style={{
            flex: 'none', writingMode: 'vertical-rl', whiteSpace: 'nowrap',
            fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase',
          }}>{item.label}</span>
        )}
      </button>
    </Tooltip>
  );
}

export function RailTabs({
  items = [], active = null, onSelect, labels = true, side = 'end', footer, label = 'Panels', style, ...rest
}) {
  const reduce = prefersReducedMotion();
  const placement = side === 'start' ? 'right' : 'left';
  const edgeKey = side === 'start' ? 'borderRight' : 'borderLeft';
  const onKeyDown = (e) => {
    rovingKeyDown(e, { selector: 'button[data-rail-tab]', orientation: 'vertical', container: e.currentTarget });
  };
  return (
    <div
      role="group"
      aria-label={label}
      data-rail-tabs={side}
      style={{
        flex: 'none', width: 'var(--panel-rail-width, 36px)', boxSizing: 'border-box', alignSelf: 'stretch',
        display: 'flex', flexDirection: 'column', minHeight: 0,
        background: 'var(--surface-card, #fff)', [edgeKey]: '1px solid var(--border-color, #dee2e6)',
        ...style,
      }}
      {...rest}
    >
      <div onKeyDown={onKeyDown} style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {items.map((item, i) => (
          <RailTab
            key={item.id}
            item={item}
            pressed={active != null && active === item.id}
            divider={i > 0}
            labels={labels}
            placement={placement}
            onSelect={onSelect}
            reduce={reduce}
          />
        ))}
      </div>
      {footer != null && (
        <div style={{ flex: 'none', height: 32, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', borderTop: DIVIDER }}>
          {footer}
        </div>
      )}
    </div>
  );
}
