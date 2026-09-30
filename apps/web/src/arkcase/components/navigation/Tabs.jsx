import React from 'react';

/**
 * ArkCase Tabs — underline tab bar. Active tab shows a cyan underline + text.
 *
 * `variant="stacked"` is the Workers' Compensation locked icon-over-label bar (`stackTabs()`):
 * the underline tab button (8px 14px, cyan 2px underline) holding a label block with
 * `padding: 3px 0 1px`, `margin: 0 -9px` (cancelling most of the button's side padding),
 * `minWidth: 66`, a 20px glyph over a 13px label, `gap: 6`, bottom-aligned. Counts ride the
 * icon's top-right corner as a solid primary badge and show only when greater than zero.
 * Tight and left-aligned — do not add side padding or raise the floor.
 *
 * `variant="navy"` sits on `surface-header` chrome: secondary on-navy ink at rest, white
 * ink and a white indicator when active, `surface-navy-strong` on hover, tonal icons and
 * inverted count chips. `orientation="vertical"` stacks the tabs with the separator on the
 * inline-end side and the indicator on the inline-start edge; `iconOnly` hides the labels
 * (each tab keeps its label, plus any `countLabel`, as its accessible name and tooltip) —
 * vertical + navy + iconOnly is the addon rail.
 *
 * Arrow keys, Home and End move focus and select (automatic activation); the handler stops
 * propagation so a host's document-level roving handler does not move the same press twice.
 *
 * `scrollable` keeps a horizontal bar on one line: it scrolls sideways with a hidden
 * scrollbar, fades whichever edge has more tabs beyond it, and keeps the active tab in view.
 * `countPlacement="corner"` moves an iconed tab's count onto the icon's top-right corner as a
 * solid badge; a tab's `locked` flag draws a lock in the same corner (or after the label when
 * counts are inline). Both are opt-in: the default bar is unchanged.
 */
const TONES = {
  neutral: ['var(--pill-neutral-bg, #e9ecef)', 'var(--pill-neutral-fg, #495057)'],
  primary: ['var(--pill-primary-bg, #e0f2fe)', 'var(--pill-primary-fg, #0369a1)'],
  danger: ['var(--pill-danger-bg, #fee2e2)', 'var(--pill-danger-fg, #991b1b)'],
  warning: ['var(--pill-warning-bg, #fef3c7)', 'var(--pill-warning-fg, #92400e)'],
  success: ['var(--pill-success-bg, #dcfce7)', 'var(--pill-success-fg, #15803d)'],
};
// Inverted chrome chip for counts on navy: white ground, navy ink.
const NAVY_COUNT = ['var(--text-on-navy, #ffffff)', 'var(--surface-header, #073652)'];
// Solid corner badge on an icon: the primary fill with on-primary ink.
const CORNER_COUNT = ['var(--bs-primary, #0079a8)', 'var(--text-on-primary, #ffffff)'];
const FADE = 12;
/* The settled stackTabs() label block (WC CLAUDE.md, "Stacked tab bars — locked pattern"). */
const STACK_BLOCK = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end',
  gap: 6, lineHeight: 1, padding: '3px 0 1px', margin: '0 -9px', minWidth: 66, boxSizing: 'border-box',
};

export function Tabs({ tabs = [], active, onChange, variant = 'underline', orientation = 'horizontal', iconOnly = false, scrollable = false, countPlacement = 'inline', style, ...rest }) {
  const [internal, setInternal] = React.useState(active ?? (tabs[0] && (tabs[0].id ?? tabs[0])));
  const cur = active !== undefined ? active : internal;
  const [hover, setHover] = React.useState(null);
  const stacked = variant === 'stacked';
  const navy = variant === 'navy';
  const vertical = orientation === 'vertical';
  const scroll = !!scrollable && !vertical;
  const listRef = React.useRef(null);
  const [edges, setEdges] = React.useState({ start: false, end: false });
  const measure = React.useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
  }, []);
  React.useEffect(() => {
    if (!scroll) return undefined;
    const el = listRef.current;
    measure();
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scroll, measure, tabs.length]);
  /* Keep the active tab inside the scroller (not the page): adjust scrollLeft only. */
  React.useEffect(() => {
    if (!scroll) return;
    const el = listRef.current;
    const tab = el && el.querySelector('[role="tab"][aria-selected="true"]');
    if (!tab) return;
    const left = tab.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
    const right = left + tab.offsetWidth;
    if (left - FADE < el.scrollLeft) el.scrollLeft = Math.max(0, left - FADE);
    else if (right + FADE > el.scrollLeft + el.clientWidth) el.scrollLeft = right + FADE - el.clientWidth;
    measure();
  }, [scroll, cur, measure]);
  const onKeyDown = (e) => {
    const KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (KEYS.indexOf(e.key) < 0) return;
    const buttons = Array.from(e.currentTarget.querySelectorAll('[role="tab"]:not([disabled])')).filter((b) => b.offsetWidth > 0 || b.offsetHeight > 0);
    if (!buttons.length) return;
    /* This bar owns its keys: a host that also roves inside any tablist (Workers Compensation's
       document-level rovingKey) must not see the event, or one press moves two tabs. */
    e.preventDefault();
    e.stopPropagation();
    const at = Math.max(0, buttons.indexOf(document.activeElement));
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
      : (at + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
    buttons[next].click();
  };

  const rule = navy ? 'var(--border-on-navy, rgba(255,255,255,0.18))' : 'var(--border-color, #dee2e6)';
  const listStyle = vertical
    ? { display: 'flex', flexDirection: 'column', gap: iconOnly ? 4 : 2, borderInlineEnd: `1px solid ${rule}` }
    : { display: 'flex', gap: stacked ? 0 : '0.25rem', borderBottom: `1px solid ${rule}` };
  if (scroll) {
    /* A scroller clips at its padding box, so the tabs cannot overlap a border: the rule
       becomes an inset shadow the tab underlines paint over. */
    const mask = edges.start || edges.end
      ? `linear-gradient(90deg, ${edges.start ? 'transparent' : '#000'} 0, #000 ${FADE}px, #000 calc(100% - ${FADE}px), ${edges.end ? 'transparent' : '#000'} 100%)`
      : undefined;
    Object.assign(listStyle, {
      borderBottom: 0, boxShadow: `inset 0 -1px 0 ${rule}`,
      flexWrap: 'nowrap', overflowX: 'auto', overflowY: 'hidden', maxWidth: '100%',
      scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch',
      maskImage: mask, WebkitMaskImage: mask,
    });
  }
  const corner = countPlacement === 'corner';

  const countChip = (t, on, extra) => {
    const [bg, fg] = t.countTone && TONES[t.countTone] ? TONES[t.countTone] : navy ? NAVY_COUNT : on ? TONES.primary : TONES.neutral;
    return (
      <span
        aria-hidden={t.countLabel || iconOnly ? 'true' : undefined}
        style={{
          fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, background: bg, color: fg, borderRadius: '50rem', padding: '0.1em 0.5em',
          ...(navy ? { fontFamily: 'var(--font-data, "Source Code Pro", monospace)', fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)' } : null),
          ...extra,
        }}
      >{t.count}</span>
    );
  };

  const cornerBadge = (t, on, shown) => {
    const base = { position: 'absolute', top: -7, right: -11, borderRadius: 10, lineHeight: 1.375, whiteSpace: 'nowrap', pointerEvents: 'none' };
    if (shown && stacked) {
      /* The locked stackTabs() badge, verbatim: 11px/600 on the primary fill, 2px 6px. */
      const [bg, fg] = t.countTone && TONES[t.countTone] ? TONES[t.countTone] : CORNER_COUNT;
      return (
        <span data-tab-badge="count" aria-hidden="true" style={{
          ...base, padding: '2px 6px', background: bg, color: fg,
          fontSize: 'var(--font-size-label, 11px)', fontWeight: 600,
        }}>{String(t.count)}</span>
      );
    }
    if (shown) {
      const [bg, fg] = t.countTone && TONES[t.countTone] ? TONES[t.countTone] : CORNER_COUNT;
      return (
        <span data-tab-badge="count" aria-hidden="true" style={{
          ...base, minWidth: 16, boxSizing: 'border-box', textAlign: 'center', padding: '0 5px',
          background: bg, color: fg, fontSize: 'var(--font-size-label, 11px)', fontWeight: 600,
          fontFamily: 'var(--font-data, "Source Code Pro", monospace)', fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)',
        }}>{t.count}</span>
      );
    }
    if (t.locked) {
      return (
        <span data-tab-badge="lock" aria-hidden="true" title={t.lockLabel || 'Restricted'} style={{
          ...base, right: -9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '3px 4px', lineHeight: 1,
          background: navy ? 'var(--text-on-navy, #ffffff)' : 'var(--surface-tertiary, #e9ecef)',
          color: navy ? 'var(--surface-header, #073652)' : 'var(--text-secondary, #5a6268)',
        }}><i className="bi bi-lock" style={{ fontSize: 10, lineHeight: 1, color: 'currentColor' }} /></span>
      );
    }
    return null;
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-orientation={vertical ? 'vertical' : undefined}
      data-icon-tone={navy ? 'current' : undefined}
      data-tabs-scrollable={scroll ? '' : undefined}
      onKeyDown={onKeyDown}
      onScroll={scroll ? measure : undefined}
      style={{ ...listStyle, ...style }}
      {...rest}
    >
      {tabs.map((t, i) => {
        const id = t.id ?? t;
        const label = t.label ?? t;
        const on = id === cur;
        const isHover = hover === i;
        const stackIcon = stacked && !!t.icon;
        const inCorner = (corner || stackIcon) && !!t.icon;
        /* The locked stacked bar shows a count only when there are entries. */
        const countShown = t.count != null && t.count !== '' && !(stackIcon && Number(t.count) <= 0);
        const hasCount = countShown && !inCorner;
        const plain = !navy && !vertical && !iconOnly;
        const lockName = t.locked ? `, ${t.lockLabel || 'Restricted'}` : '';
        let name = iconOnly || t.countLabel
          ? `${label}${t.countLabel ? `, ${t.countLabel}` : hasCount && iconOnly ? `, ${t.count}` : ''}`
          : undefined;
        if (inCorner && countShown) name = `${label}, ${t.countLabel || t.count}`;
        if (lockName) name = `${name || label}${lockName}`;
        const iconNode = t.icon && <i className={`bi ${t.icon}`} aria-hidden="true" style={stacked ? { fontSize: 'var(--icon-lg, 20px)', lineHeight: 1 } : iconOnly || navy ? { fontSize: 'var(--icon-md, 16px)' } : undefined} />;
        const lockInline = t.locked && !inCorner && !iconOnly
          ? <i className="bi bi-lock" aria-hidden="true" data-tab-lock="" title={t.lockLabel || 'Restricted'} style={{ fontSize: 'var(--icon-xs, 12px)' }} />
          : null;

        let tabStyle;
        if (plain) {
          /* The stacked bar keeps the underline button untouched: its geometry lives in the
             label block (see stackBlock), exactly as the locked stackTabs() draws it. */
          tabStyle = {
            background: 'transparent',
            border: 'none', cursor: t.disabled ? 'default' : 'pointer',
            padding: '0.5rem 0.875rem',
            fontSize: '0.9375rem',
            fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
            fontWeight: on ? 600 : 400,
            color: on ? 'var(--text-link-on-tint, #00688f)' : isHover ? 'var(--text-body, #212529)' : 'var(--text-secondary, #5a6268)',
            borderBottom: `2px solid ${on ? 'var(--bs-primary, #0079a8)' : 'transparent'}`,
            borderRadius: 0,
            marginBottom: -1,
            display: 'inline-flex',
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'center',
            gap: '0.4rem',
            lineHeight: 1.2,
            transition: 'color .15s ease, border-color .15s ease, background-color .15s ease',
          };
        } else {
          const indicator = on ? (navy ? 'var(--text-on-navy, #ffffff)' : 'var(--bs-primary, #0079a8)') : 'transparent';
          const fg = navy
            ? (on || isHover ? 'var(--text-on-navy, #ffffff)' : 'var(--text-on-navy-secondary, rgba(255,255,255,0.72))')
            : on ? 'var(--text-link-on-tint, #00688f)' : isHover ? 'var(--text-body, #212529)' : 'var(--text-secondary, #5a6268)';
          const bg = navy
            ? (isHover && !t.disabled) || (on && vertical && iconOnly) ? 'var(--surface-navy-strong, #0d4a6b)' : 'transparent'
            : on && vertical ? 'var(--tint-primary-selected, rgba(0,121,168,0.10))' : isHover && !t.disabled ? 'var(--tint-primary-hover, rgba(0,121,168,0.05))' : 'transparent';
          const bar = navy ? 3 : 2;
          tabStyle = {
            position: 'relative',
            background: bg,
            border: 'none', cursor: t.disabled ? 'default' : 'pointer',
            fontSize: vertical ? 'var(--font-size-dense, 13px)' : 'var(--font-size-sm, 14px)',
            fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
            fontWeight: navy || on ? 600 : 400,
            color: fg,
            display: 'inline-flex', flexDirection: 'row', alignItems: 'center',
            gap: '0.4rem', lineHeight: 1.2, whiteSpace: 'nowrap',
            opacity: t.disabled ? 0.5 : undefined,
            transition: 'color .15s ease, border-color .15s ease, background-color .15s ease',
          };
          if (vertical) {
            Object.assign(tabStyle, {
              borderInlineStart: `${bar}px solid ${indicator}`,
              marginInlineEnd: -1,
              borderRadius: iconOnly ? 'var(--radius-md, 5px)' : 0,
              justifyContent: iconOnly ? 'center' : 'flex-start',
              padding: iconOnly ? 0 : '0.5rem 0.875rem 0.5rem 0.75rem',
              width: iconOnly ? 32 : undefined, height: iconOnly ? 32 : undefined,
              textAlign: 'start',
            });
          } else {
            Object.assign(tabStyle, {
              borderTop: `${bar}px solid transparent`,
              borderBottom: `${bar}px solid ${indicator}`,
              marginBottom: -1,
              borderRadius: 0,
              justifyContent: 'center',
              padding: iconOnly ? '0.4rem 0.625rem' : '0.4rem 0.75rem',
            });
          }
        }

        return (
          <button
            key={i}
            id={t.tabId}
            role="tab"
            aria-selected={on}
            aria-controls={t.panelId}
            aria-label={name}
            title={iconOnly ? label : undefined}
            tabIndex={on ? 0 : -1}
            disabled={!!t.disabled}
            aria-disabled={t.disabled ? 'true' : undefined}
            onClick={() => { if (active === undefined) setInternal(id); onChange && onChange(id); }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            style={scroll ? { ...tabStyle, flex: 'none', marginBottom: 0 } : tabStyle}
          >
            {stackIcon ? (
              <span data-tab-stack="" style={STACK_BLOCK}>
                <span data-tab-icon="" style={{ position: 'relative', display: 'inline-flex', lineHeight: 1 }}>
                  {iconNode}
                  {cornerBadge(t, on, countShown)}
                </span>
                <span style={{ fontSize: 'var(--font-size-dense, 13px)', whiteSpace: 'nowrap' }}>{label}</span>
              </span>
            ) : inCorner ? (
              <span data-tab-icon="" style={{ position: 'relative', display: 'inline-flex', lineHeight: 1 }}>
                {iconNode}
                {cornerBadge(t, on, countShown)}
              </span>
            ) : iconNode}
            {stackIcon ? null : iconOnly ? (
              hasCount && countChip(t, on, vertical
                ? { position: 'absolute', top: -2, right: -4, minWidth: 16, boxSizing: 'border-box', padding: '0 4px', lineHeight: '15px', textAlign: 'center' }
                : { padding: '0.1em 0.45em' })
            ) : (
              label
            )}
            {!stackIcon && !iconOnly && hasCount && countChip(t, on)}
            {!stackIcon && lockInline}
          </button>
        );
      })}
    </div>
  );
}
