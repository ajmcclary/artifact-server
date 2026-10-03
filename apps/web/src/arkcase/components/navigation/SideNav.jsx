import React from 'react';
import { navyNavigationStyle } from './nav-tone.js';
import { NavigationIcon } from './NavigationIcon.jsx';
import { displayProfileContext } from '../shell/DisplayProfile.jsx';
import { useResizeSeam } from '../panel/resize-seam.jsx';
import { Tooltip } from '../feedback/Tooltip.jsx';
import { matchesMedia, countText, leftToBrowser } from './nav-helpers.jsx';

const RAIL_WIDTH = 'var(--navigator-rail-width, 52px)';
const GROUP_LABEL = { fontSize: 'var(--font-size-label, 11px)', fontWeight: 700, letterSpacing: 'var(--letter-spacing-wide, .025em)', textTransform: 'uppercase', color: 'var(--ac-nav-secondary, var(--text-secondary, #5a6268))', whiteSpace: 'nowrap' };
const COUNT = { marginLeft: 'auto', flex: 'none', minWidth: 20, textAlign: 'center', background: 'var(--bs-danger, #d83506)', color: 'var(--text-on-primary, #fff)', fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, lineHeight: 1.45, borderRadius: 'var(--radius-pill, 10px)', padding: '1px 6px' };
const MINI_COUNT = { position: 'absolute', top: 2, right: 2, minWidth: 16, textAlign: 'center', background: 'var(--bs-danger, #d83506)', color: 'var(--text-on-primary, #fff)', fontSize: 10, fontWeight: 700, lineHeight: 1.6, borderRadius: 8, padding: '0 3px', boxShadow: '0 0 0 2px var(--ac-nav-surface, var(--surface-body, #fff))' };

const COUNT_NEUTRAL = { ...COUNT, background: 'var(--pill-neutral-bg, #e9ecef)', color: 'var(--pill-neutral-fg, #495057)' };
const MINI_COUNT_NEUTRAL = { ...MINI_COUNT, background: 'var(--pill-neutral-bg, #e9ecef)', color: 'var(--pill-neutral-fg, #495057)' };
/* E5c — counts are informational (neutral) unless an item says `countTone: 'danger'`: red is for "act now". */
const countStyle = (item, rail) => (item.countTone === 'danger' ? (rail ? MINI_COUNT : COUNT) : (rail ? MINI_COUNT_NEUTRAL : COUNT_NEUTRAL));

/**
 * ArkCase SideNav — the primary navigation in four modes. `drawer` is the
 * slide-in overlay (280px, backdrop, focus trap); `expanded` the persistent
 * sidebar; `rail` the icon-only column at `--navigator-rail-width`; `peek` a rail
 * with an expand button at its head whose press opens the expanded list over the
 * rail — never hover or focus, so pointer travel opens nothing — and which retracts
 * on its collapse button, a press outside, blur, Escape or selection. The rail's
 * items stay links: a press on one goes there directly. `inline` maps to `expanded`, so every earlier
 * usage renders as before. `pinned` / `onPinChange` add the 32px pin footer of the
 * Panel Pin Model; the host owns the pin and announces through `onAnnounce`.
 *
 * The expanded column is `flex: none`: its width is a decision, not a leftover, so
 * a route whose content is wider cannot squeeze the navigation narrower than the
 * route beside it left it. `resizable` adds the Panel's seam on the inward edge —
 * drag, arrow keys, Home / End, and Delete to forget the width — reported through
 * `onWidthChange` so the host stores it beside its other panel widths.
 *
 * An item with no `link` is a button, current by `item.current`; `depth: 1` is a child row of the
 * item before it, absent from the rail; a count is neutral, and `countTone: 'danger'` marks one that needs action now; and
 * `pinName` and `pinLabelVisible` name the pin and choose the glyph-only footer, which is how a
 * record's section rail draws it. `currentLabel` ("Current") suffixes the active rail item's
 * tooltip, "Review queue · Current", so the rail says which icon is the page. Arrow keys move focus between the items of the list that has
 * focus, Home and End to its ends, and select nothing; every item stays a tab stop.
 */
export function SideNav({
  items = [], activeLink, isOpen = true, onClose, onSelect, title = 'Navigation', inline = false, style,
  mode: modeProp, tone = 'default', surface = 'default', embedded = false, pinned = false, onPinChange, footerMeta, header, footer, footerRail, width, onAnnounce,
  pinName = 'the menu', pinLabelVisible = true, currentLabel,
  resizable = false, onWidthChange, minWidth = 180, maxWidth = 420,
  ...rest
}) {
  /* An embedded view list (inside a Panel): expanded, no title row, full width, no edge rule. */
  if (embedded) {
    if (modeProp == null) modeProp = 'expanded';
    if (header === undefined) header = false;
    if (width == null) width = '100%';
  }
  /* The light section rail paints surface-secondary through the column's own surface property. */
  const surfaceVars = surface === 'secondary' && tone !== 'navy' ? { '--ac-nav-surface': 'var(--surface-secondary, #f8f9fa)' } : null;
  const extended = modeProp != null;
  const mode = modeProp || (inline ? 'expanded' : 'drawer');
  const isDrawer = mode === 'drawer';
  const isPeek = mode === 'peek';
  const railLike = mode === 'rail' || isPeek;
  const baseW = width != null ? width : (isDrawer || !extended) ? 280 : 232;
  const canResize = !!resizable && !isDrawer && !railLike;

  const dp = React.useContext(displayProfileContext());
  const reduceMotion = dp ? dp.reduceMotion : matchesMedia('(prefers-reduced-motion: reduce)');
  /* The seam: the Panel's, on the navigation's inward edge. The navigation never collapses by
     overshoot — the pin is what rails it — so the hook is called without onOvershoot. */
  const seamState = useResizeSeam({
    width: baseW, minWidth, maxWidth, side: 'start', name: title.toLowerCase(), reduceMotion,
    onWidthChange, onAnnounce, attrs: { 'data-ac-sidenav-seam': '' },
  });
  const panelW = canResize ? seamState.width : baseW;
  const dragging = canResize && seamState.dragging;
  const seam = canResize && seamState.seam;

  const [hover, setHover] = React.useState(null);
  const [peek, setPeek] = React.useState(false);
  const [measuredW, setMeasuredW] = React.useState(null);
  const drawerRef = React.useRef(null);
  const rootRef = React.useRef(null);
  /* The two item lists the arrow keys walk: the rail's and the expanded one (the peek overlay's is
     the expanded one, never on screen beside it). Refs, not attributes, so no digest moves. */
  const listRef = React.useRef(null);
  const railListRef = React.useRef(null);
  const prevFocus = React.useRef(null);
  const peekOpen = isPeek && peek;

  // WCAG 2.4.3 — move focus into the drawer on open, restore it on close.
  React.useEffect(() => {
    if (!isDrawer) return;
    if (isOpen) {
      prevFocus.current = document.activeElement;
      const el = drawerRef.current;
      if (el) {
        const f = el.querySelector('button, a[href], input, [tabindex]:not([tabindex="-1"])');
        (f || el).focus();
      }
    } else if (prevFocus.current && prevFocus.current.focus) {
      prevFocus.current.focus();
      prevFocus.current = null;
    }
  }, [isOpen, isDrawer]);

  // The pin label needs the panel's real width: 150px is where "Pin the menu" fits.
  React.useEffect(() => {
    if (!onPinChange || railLike) return undefined;
    const el = drawerRef.current;
    /* v8 ignore next */
    if (!el) return undefined;
    const read = () => setMeasuredW(el.getBoundingClientRect().width);
    read();
    /* v8 ignore next */
    if (typeof ResizeObserver === 'undefined') return undefined;
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; read(); }); };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    return () => { if (frame) cancelAnimationFrame(frame); ro.disconnect(); };
  }, [onPinChange, railLike, mode, panelW]);

  // The peek opens on a press only; a press anywhere outside it puts it away, on any pointer.
  React.useEffect(() => {
    if (!peekOpen) return undefined;
    const away = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) { setPeek(false); setHover(null); } };
    document.addEventListener('pointerdown', away, true);
    return () => { document.removeEventListener('pointerdown', away, true); };
  }, [peekOpen]);

  const peekToggleRef = React.useRef(null);
  const closePeek = () => { if (peek) { setPeek(false); setHover(null); } };
  /* Escape and the collapse button hand focus back to the rail's expand button when the peek had it. */
  const retractPeek = () => {
    const root = rootRef.current;
    const had = root && root.contains(document.activeElement);
    closePeek();
    if (had && peekToggleRef.current) peekToggleRef.current.focus({ preventScroll: true });
  };
  const select = (item) => { onSelect && onSelect(item); if (isPeek) closePeek(); };
  /* A link row leaves a modified click to the browser — no onSelect, and the peek stays open. */
  const onItemClick = (item) => (e) => {
    if (item.link != null && leftToBrowser(e)) return;
    e.preventDefault(); select(item);
  };

  /* The Angular twin's keyboard model: ArrowDown / ArrowUp move focus between the items of the
     list that has focus, Home / End to its ends, the ends hold, every item stays a tab stop and
     nothing is activated — a link only an arrow can reach is one a screen reader's link list
     cannot see, and the old rail's activate-on-arrow is not carried. The handler stops
     propagation, as Tabs does, so a host's document-level roving handler never moves the same
     press twice. Left and Right are the seam's. The drawer keeps its Escape and its Tab trap; the
     peek keeps its Escape. */
  const onKeyDown = (e) => {
    if (isDrawer && e.key === 'Escape') { e.preventDefault(); onClose && onClose(); return; }
    if (isPeek && e.key === 'Escape' && peek) { e.preventDefault(); retractPeek(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(e.key) > -1) {
      const region = [listRef.current, railListRef.current].find((el) => el && el.contains(e.target));
      if (!region) return;
      const items = Array.from(region.querySelectorAll('a[href], button:not([disabled])'));
      const at = items.indexOf(e.target);
      if (at < 0) return;
      e.preventDefault(); e.stopPropagation();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : Math.min(items.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)));
      items[next].focus();
      return;
    }
    if (!isDrawer || e.key !== 'Tab') return;
    const el = drawerRef.current;
    /* v8 ignore next */
    if (!el) return;
    const f = el.querySelectorAll('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])');
    /* v8 ignore next */
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const groupHeader = (item, i, rail, prev) => {
    if (!item.group || (prev && prev.group === item.group)) return null;
    if (rail) {
      if (i === 0) return null;
      return <div aria-hidden="true" style={{ flex: 'none', position: 'relative', height: 13 }}><span style={{ position: 'absolute', left: 11, right: 11, top: 6, borderTop: '1px solid var(--ac-nav-divider, var(--border-color-strong, #ced4da))' }} /></div>;
    }
    return <div style={{ flex: 'none', height: 30, display: 'flex', alignItems: 'flex-end', padding: '0 14px 4px', overflow: 'hidden' }}><span style={GROUP_LABEL}>{item.group}</span></div>;
  };

  /* E5c — an item with no link is a button (a record's section, not a page), current by
     item.current; depth 1 is a child row of the item before it, drawn only in the list. */
  const isActive = (item) => (item.link != null ? item.link === activeLink : !!item.current);
  const link = (item, i) => {
    const active = isActive(item);
    const isHover = hover === i;
    const isLink = item.link != null;
    const child = item.depth === 1;
    const Tag = isLink ? 'a' : 'button';
    const base = isLink
      ? { href: item.link, 'aria-current': extended && active ? 'page' : undefined }
      : { type: 'button', 'aria-current': active ? 'true' : undefined };
    const asButton = isLink ? {} : { width: '100%', boxSizing: 'border-box', border: 0, font: 'inherit', textAlign: 'left', cursor: 'pointer' };
    const style = child
      ? {
          ...asButton,
          display: 'flex', alignItems: 'center', height: 29, padding: '0 12px 0 calc(1rem + var(--icon-lg, 20px) + 0.75rem)', fontSize: 13,
          borderLeft: '3px solid transparent',
          color: active ? 'var(--ac-nav-text, var(--text-link-on-tint, #00688f))' : 'var(--ac-nav-secondary, var(--text-secondary, #5a6268))',
          fontWeight: active ? 600 : 400,
          backgroundColor: active ? 'var(--ac-nav-selected, var(--tint-primary-selected, rgba(0,121,168,.10)))' : isHover ? 'var(--ac-nav-hover, var(--tint-primary-hover, rgba(0,121,168,.05)))' : 'transparent',
          textDecoration: 'none', outlineOffset: -3,
          boxShadow: active ? 'inset 3px 0 var(--ac-nav-marker, var(--bs-primary, #0079a8))' : undefined,
          transition: 'color .15s ease, background-color .15s ease',
        }
      : {
          ...asButton,
          display: 'flex', alignItems: 'center', gap: '0.75rem',
          padding: '0.5rem 1rem',
          color: active || isHover ? 'var(--ac-nav-text, var(--text-link-on-tint, #00688f))' : 'var(--ac-nav-text, var(--text-body, #212529))',
          textDecoration: 'none',
          borderLeft: `3px solid ${active ? 'var(--ac-nav-marker, var(--bs-primary, #0079a8))' : 'transparent'}`,
          backgroundColor: active ? 'var(--ac-nav-selected, var(--tint-primary-selected, rgba(0,121,168,.10)))' : isHover ? 'var(--ac-nav-hover, var(--tint-primary-hover, rgba(0,121,168,.05)))' : 'transparent',
          fontWeight: active ? 600 : 400,
          fontSize: '0.9375rem',
          transition: 'color .15s ease, background-color .15s ease, border-color .15s ease',
        };
    return React.createElement(
      Tag,
      {
        key: i, ...base,
        onClick: onItemClick(item),
        onMouseEnter: () => setHover(i),
        onMouseLeave: () => setHover(null),
        style: { ...style, outlineOffset: -3, pointerEvents: 'auto' },
      },
      child ? item.label : [
        item.icon ? <NavigationIcon key="icon" icon={item.icon} active={active} /> : null,
        item.label,
        item.count != null ? <span key="count" style={countStyle(item, false)}>{countText(item.count)}</span> : null,
        item.locked ? <i key="lock" aria-hidden="true" className="bi bi-lock" title="Restricted for your role" style={{ marginLeft: item.count != null ? 8 : 'auto', flexShrink: 0, fontSize: 'var(--icon-xs, 12px)', color: 'var(--ac-nav-secondary, var(--text-secondary, #5a6268))' }} /> : null,
      ],
    );
  };

  const railLink = (item, i) => {
    const active = isActive(item);
    const isHover = hover === i;
    const isLink = item.link != null;
    const name = item.locked ? `${item.label} (restricted)` : item.label;
    const base = isLink
      ? { href: item.link, 'aria-current': active ? 'page' : undefined }
      : { type: 'button', 'aria-current': active ? 'true' : undefined };
    const control = React.createElement(
      isLink ? 'a' : 'button',
      {
        ...base, 'aria-label': name,
        onClick: onItemClick(item),
        onMouseEnter: () => setHover(i),
        onMouseLeave: () => setHover(null),
        style: {
          ...(isLink ? {} : { border: 0, padding: 0, font: 'inherit', cursor: 'pointer' }),
          position: 'relative', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 44, height: 44, margin: '2px auto',
          borderRadius: 'var(--radius-md, 5px)',
          color: active || isHover ? 'var(--ac-nav-text, var(--text-link-on-tint, #00688f))' : 'var(--ac-nav-text, var(--text-body, #212529))',
          backgroundColor: active ? 'var(--ac-nav-selected, var(--tint-primary-selected, rgba(0,121,168,.10)))' : isHover ? 'var(--ac-nav-hover, var(--tint-primary-hover, rgba(0,121,168,.05)))' : 'transparent',
          textDecoration: 'none', outlineOffset: -3, pointerEvents: 'auto',
          boxShadow: active ? 'inset 3px 0 var(--ac-nav-marker, var(--bs-primary, #0079a8))' : undefined,
          transition: 'color .15s ease, background-color .15s ease',
        },
      },
      <NavigationIcon key="icon" icon={item.icon || 'bi-circle'} active={active} />,
      item.count != null ? <span key="count" style={countStyle(item, true)}>{countText(item.count)}</span> : null,
    );
    return (
      <Tooltip label={active && currentLabel ? name + ' · ' + currentLabel : name} placement="right" fixed style={{ flex: 'none', display: 'flex', justifyContent: 'center' }}>
        {control}
      </Tooltip>
    );
  };

  const list = (rail) => (
    <div ref={rail ? railListRef : listRef} style={rail ? { flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '4px 0', display: 'flex', flexDirection: 'column' } : { flex: 1, overflowY: 'auto', padding: '0.5rem 0' }}>
      {(rail ? items.filter((it) => it.depth !== 1) : items).map((item, i, shown) => (
        <React.Fragment key={item.id != null ? item.id : i}>
          {groupHeader(item, i, rail, i > 0 ? shown[i - 1] : null)}
          {item.label ? (rail ? railLink(item, i) : link(item, i)) : null}
        </React.Fragment>
      ))}
    </div>
  );

  const pinRow = (rail) => {
    if (!onPinChange) return null;
    /* E5c — the pin is named by the host: "Pin the menu" for the navigation, "Pin sections" for a
       record's section rail, which also draws it as a glyph with the label as name and tooltip. */
    const pinLabel = (pinned ? 'Unpin ' : 'Pin ') + pinName;
    const who = String(pinName).replace(/^the\s+/i, '');
    const Who = who.charAt(0).toUpperCase() + who.slice(1);
    const w = rail ? 0 : measuredW != null ? measuredW : (typeof panelW === 'number' ? panelW : 999);
    const showLabel = pinLabelVisible && !rail && w >= 150;
    const toggle = () => { const next = !pinned; onPinChange(next); onAnnounce && onAnnounce(next ? Who + ' pinned.' : Who + ' unpinned.'); };
    return (
      <div style={{ flex: 'none', height: 32, borderTop: '1px solid var(--ac-nav-divider, var(--border-color-strong, #ced4da))', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: rail ? 0 : '0 10px 0 4px', overflow: 'hidden' }}>
        <button
          type="button"
          onClick={toggle}
          aria-pressed={!!pinned}
          data-ac-pin=""
          aria-label={pinLabel}
          title={pinLabel}
          style={{ display: 'flex', alignItems: 'center', justifyContent: rail ? 'center' : 'flex-start', gap: 6, height: 24, width: rail ? 44 : undefined, margin: rail ? '0 auto' : 0, padding: rail ? 0 : '0 6px 0 8px', borderRadius: 'var(--radius-md, 5px)', border: 'none', background: 'transparent', font: 'inherit', fontSize: 'var(--font-size-xs, 12px)', fontWeight: 400, letterSpacing: 'normal', cursor: 'pointer', whiteSpace: 'nowrap', color: 'var(--ac-nav-secondary, var(--text-secondary, #5a6268))', flex: 'none', pointerEvents: 'auto' }}
        >
          <i aria-hidden="true" className={`bi ${pinned ? 'bi-pin-angle-fill' : 'bi-pin-angle'}`} style={{ fontSize: 'var(--icon-sm, 14px)' }} />
          {showLabel && <span>{pinLabel}</span>}
        </button>
        {!rail && footerMeta != null && <span style={{ minWidth: 0, fontSize: 'var(--font-size-label, 11px)', color: 'var(--ac-nav-secondary, var(--text-secondary, #5a6268))', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{footerMeta}</span>}
      </div>
    );
  };

  const titleRow = header != null ? header : (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', borderBottom: '1px solid var(--ac-nav-divider, var(--border-color, #dee2e6))' }}>
      <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 500, color: 'var(--ac-nav-text, var(--text-body, #212529))' }}>{title}</h2>
      {onClose && (
        <button onClick={onClose} aria-label="Close navigation" style={{ background: 'transparent', border: 'none', fontSize: '1.25rem', lineHeight: 1, color: 'var(--ac-nav-text, var(--text-body, #212529))', cursor: 'pointer', padding: '0.25rem', borderRadius: '0.25rem' }}>
          <i className="bi bi-x-lg" />
        </button>
      )}
    </div>
  );
  const footerRow = footer != null && <div style={{ flex: 'none', borderTop: '1px solid var(--ac-nav-divider, var(--border-color, #dee2e6))', padding: '8px 12px' }}>{footer}</div>;

  /* The peek's own toggle: the rail's head opens it, the overlay's head — the same 44px row in
     the same place — closes it, so the press that opened it can be undone where it was made. */
  const whoNav = String(pinName).replace(/^the\s+/i, '');
  const peekHead = (open) => (
    <div style={{ flex: 'none', height: 44, display: 'flex', alignItems: 'center', justifyContent: open ? 'flex-start' : 'center', padding: open ? '0 4px' : 0, borderBottom: '1px solid var(--ac-nav-divider, var(--border-color, #dee2e6))' }}>
      <button
        ref={open ? undefined : peekToggleRef}
        type="button"
        data-ac-peek-toggle={open ? 'close' : 'open'}
        aria-expanded={open}
        aria-label={(open ? 'Collapse ' : 'Expand ') + whoNav}
        title={(open ? 'Collapse ' : 'Expand ') + whoNav}
        onClick={() => { if (open) retractPeek(); else setPeek(true); }}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 36, padding: 0, border: 0, borderRadius: 'var(--radius-md, 5px)', background: 'transparent', font: 'inherit', cursor: 'pointer', color: 'var(--ac-nav-secondary, var(--text-secondary, #5a6268))', pointerEvents: 'auto' }}
      >
        <i aria-hidden="true" className={'bi ' + (open ? 'bi-arrow-bar-left' : 'bi-arrow-bar-right')} style={{ fontSize: 'var(--icon-sm, 14px)' }} />
      </button>
    </div>
  );

  if (railLike) {
    const rail = (
      <nav
        ref={drawerRef}
        aria-label={title}
        data-ac-sidenav={mode}
        onKeyDown={isPeek ? undefined : onKeyDown}
        style={{
          flex: 'none', width: RAIL_WIDTH, height: '100%',
          backgroundColor: 'var(--ac-nav-surface, var(--surface-body, #fff))',
          color: 'var(--ac-nav-text, var(--text-body, #212529))',
          display: 'flex', flexDirection: 'column',
          borderRight: '1px solid var(--ac-nav-divider, var(--border-color, #dee2e6))',
          overflow: 'hidden',
          ...surfaceVars, ...(tone === 'navy' ? navyNavigationStyle : null),
          ...style,
        }}
        {...rest}
      >
        {isPeek && peekHead(false)}
        {list(true)}
        {footerRail != null && <div style={{ flex: 'none', borderTop: '1px solid var(--ac-nav-divider, var(--border-color, #dee2e6))', padding: '8px 0', display: 'flex', justifyContent: 'center' }}>{footerRail}</div>}
        {pinRow(true)}
      </nav>
    );
    if (!isPeek) return rail;
    return (
      <div
        ref={rootRef}
        data-ac-peek={peekOpen ? 'open' : 'closed'}
        onBlur={(e) => { if (!rootRef.current || !rootRef.current.contains(e.relatedTarget)) closePeek(); }}
        onKeyDown={onKeyDown}
        style={{ position: 'relative', flex: 'none', width: RAIL_WIDTH, height: '100%' }}
      >
        {rail}
        {peekOpen && (
          <div
            data-ac-peek-overlay="true"
            style={{
              position: 'absolute', top: 0, left: 0, bottom: 0, width: panelW, zIndex: 40,
              backgroundColor: 'var(--ac-nav-surface, var(--surface-body, #fff))',
          color: 'var(--ac-nav-text, var(--text-body, #212529))',
              borderRight: '1px solid var(--ac-nav-divider, var(--border-color, #dee2e6))',
              boxShadow: 'var(--shadow-nav, 0 0 24px rgba(0,0,0,0.12))',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
              animation: reduceMotion ? 'none' : undefined,
              ...surfaceVars, ...(tone === 'navy' ? navyNavigationStyle : null),
            }}
          >
            {peekHead(true)}
            {header != null && header}
            {list(false)}
            {footerRow}
            {pinRow(false)}
          </div>
        )}
      </div>
    );
  }

  const DrawerTag = isDrawer ? 'div' : 'nav';
  const drawer = (
    <DrawerTag
      ref={drawerRef}
      role={isDrawer ? 'dialog' : undefined}
      aria-modal={isDrawer ? true : undefined}
      aria-label={isDrawer || extended ? title : undefined}
      data-ac-sidenav={extended ? mode : undefined}
      tabIndex={isDrawer ? -1 : undefined}
      onKeyDown={onKeyDown}
      style={{
        /* `flex: none` is the fix for a column that used to shrink whenever the route
           beside it was wide: the width is the host's decision, not the leftover. */
        flex: 'none', position: 'relative',
        width: panelW,
        backgroundColor: 'var(--ac-nav-surface, var(--surface-body, #fff))',
          color: 'var(--ac-nav-text, var(--text-body, #212529))',
        display: 'flex', flexDirection: 'column',
        height: '100%',
        boxShadow: isDrawer ? 'var(--shadow-nav, 0 0 15px rgba(0,0,0,0.2))' : 'none',
        borderRight: isDrawer ? 'none' : '1px solid var(--ac-nav-divider, var(--border-color, #dee2e6))',
        transition: reduceMotion || dragging ? 'none' : 'width .2s ease',
        ...surfaceVars, ...(tone === 'navy' ? navyNavigationStyle : null),
        ...(embedded ? { border: 0, borderRight: 0, flex: 'none' } : null),
        ...style,
      }}
      {...rest}
    >
      {titleRow}
      {list(false)}
      {footerRow}
      {pinRow(false)}
      {seam}
    </DrawerTag>
  );

  if (!isDrawer) return drawer;

  return (
    <div hidden={!isOpen} style={{ position: 'absolute', inset: 0, pointerEvents: isOpen ? 'auto' : 'none', zIndex: 1050 }}>
      <div
        onClick={onClose}
        style={{
          position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
          opacity: isOpen ? 1 : 0, visibility: isOpen ? 'visible' : 'hidden',
          transition: 'opacity .3s ease, visibility .3s ease',
        }}
      />
      <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, transform: isOpen ? 'translateX(0)' : 'translateX(-100%)', transition: 'transform .3s ease' }}>
        {drawer}
      </div>
    </div>
  );
}
