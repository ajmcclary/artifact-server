import React from 'react';
import { ShortcutKey } from '../data-display/ShortcutKey.jsx';
import { useEscapeLayer } from './overlay-layer.jsx';

const SR_ONLY = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };
const ITEM_SELECTOR = '[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]';

const MENU_ANCHOR_MARGIN = 12;
/* The phone sheet's scrim: the Modal's navy at 45%. */
const MENU_SHEET_SCRIM = 'rgba(7,54,82,.45)';
const MENU_ANCHOR_GAP = 8;

/* Fixed coordinates for a menu hung off `anchor`, clamped 12px inside the viewport.
   `top` opens upward: the menu's bottom sits 8px above the anchor's top. `bottom`
   opens 8px below the anchor's bottom. `align` picks the anchor edge it lines up with. */
function menuAnchorPosition(anchor, sheet, align, placement) {
  if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return null;
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = sheet ? sheet.offsetWidth : 0;
  const h = sheet ? sheet.offsetHeight : 0;
  const m = MENU_ANCHOR_MARGIN;
  const wantLeft = align === 'end' ? r.right - w : r.left;
  const left = Math.round(Math.max(m, Math.min(wantLeft, vw - m - w)));
  if (placement === 'top') {
    const bottom = Math.round(Math.max(m, Math.min(vh - r.top + MENU_ANCHOR_GAP, vh - m - h)));
    return { left, bottom };
  }
  const top = Math.round(Math.max(m, Math.min(r.bottom + MENU_ANCHOR_GAP, vh - m - h)));
  return { left, top };
}

/** Enabled menu items inside a menu root, in document order. */
function enabledItems(root) {
  return root ? Array.from(root.querySelectorAll(ITEM_SELECTOR)).filter((el) => !el.disabled) : [];
}

/**
 * ArkCase Menu — the row-action sheet the kebab opens. A row's verbs are a choice
 * of where to go next, so they open against the control that was clicked and
 * dismiss on the next click anywhere; they are never a modal.
 *
 * Items: `{ label, icon, onClick, danger, disabled }`, `{ heading }`, `{ divider: true }`.
 * Richer rows add `type`/`checked`, `shortcut`, `description`, `meta`, `leading`,
 * `external` and `keepOpen`. `placement="top"` opens above the trigger and takes the
 * one upward shadow; `position` pins the sheet at host-computed fixed coordinates;
 * `anchor` measures the trigger element itself and hangs the sheet off it in fixed
 * position, clamped 12px inside the viewport and recomputed on resize.
 * `presentation="sheet"` is the phone form: a bottom sheet over a navy scrim, full
 * width, 44px rows, safe-area padding, focus on the first item.
 * Arrow keys, Home/End and first-letter typeahead move focus; Tab dismisses.
 */
export function Menu({
  open = true, items = [], onClose, align = 'end', placement = 'bottom', label = 'Actions', style,
  position, width, density = 'compact', header, autoFocus, anchor = null, presentation = 'popover',
  zIndex = 1060, ...rest
}) {
  const sheet = presentation === 'sheet';
  const focusOnOpen = autoFocus != null ? !!autoFocus : sheet;
  const ref = React.useRef(null);
  const handleEscape = useEscapeLayer(open, ref, onClose, !!onClose);
  const [hover, setHover] = React.useState(null);
  const [anchorPos, setAnchorPos] = React.useState(null);
  const baseId = React.useId();
  const anchored = !!anchor && !sheet;
  /* Measure before paint, so the sheet never flashes at the wrong place. */
  React.useLayoutEffect(() => {
    if (!open || !anchor || sheet) { setAnchorPos(null); return undefined; }
    const place = () => setAnchorPos(menuAnchorPosition(anchor, ref.current, align, placement));
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, anchor, sheet, align, placement, width, density, items.length]);
  React.useEffect(() => {
    if (!open || !onClose) return;
    /* A press on the anchor is the trigger's own toggle, not an outside press. */
    const away = (e) => { if (ref.current && !ref.current.contains(e.target) && !(anchor && anchor.contains && anchor.contains(e.target))) onClose(); };
    document.addEventListener('mousedown', away);
    return () => { document.removeEventListener('mousedown', away); };
  }, [open, onClose, anchor]);
  React.useEffect(() => {
    if (!open || !focusOnOpen) return;
    /* An anchored menu is hidden for its measuring frame, and a hidden item cannot take
       focus: wait for the position, then focus once. */
    if (anchored && !anchorPos) return;
    const list = enabledItems(ref.current);
    const target = list.find((el) => el.getAttribute('aria-checked') === 'true') || list[0];
    if (target && !ref.current.contains(document.activeElement)) target.focus();
  }, [open, focusOnOpen, anchored, !!anchorPos]);
  if (!open) return null;

  /* The sheet always takes the comfortable rows, raised to a 44px touch target. */
  const comfortable = density === 'comfortable' || sheet;
  const hasChecks = items.some((it) => it && (it.type === 'checkbox' || it.type === 'radio'));

  const onKeyDown = (e) => {
    if (rest.onKeyDown) rest.onKeyDown(e);
    if (e.defaultPrevented) return;
    if (handleEscape(e)) return;
    if (e.key === 'Tab') { if (onClose) onClose(); return; }
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const list = enabledItems(ref.current);
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    let n = null;
    if (e.key === 'ArrowDown') n = i < 0 ? 0 : (i + 1) % list.length;
    else if (e.key === 'ArrowUp') n = i <= 0 ? list.length - 1 : i - 1;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = list.length - 1;
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const ch = e.key.toLowerCase();
      const order = list.slice(i + 1).concat(list.slice(0, i + 1));
      const hit = order.find((el) => (el.getAttribute('data-menu-text') || el.textContent || '').trim().toLowerCase().indexOf(ch) === 0);
      if (hit) n = list.indexOf(hit);
    }
    if (n === null) return;
    e.preventDefault();
    e.stopPropagation();
    list[n].focus();
  };

  const positioned = sheet
    ? { position: 'fixed', zIndex, left: 0, right: 0, bottom: 0, top: 'auto', maxHeight: 'calc(100dvh - 24px)', overflowY: 'auto' }
    : anchored
    ? (anchorPos
      ? { position: 'fixed', zIndex, maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', ...anchorPos }
      : { position: 'fixed', zIndex, maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', top: 0, left: 0, visibility: 'hidden' })
    : position
    ? { position: 'fixed', zIndex, top: position.top, left: position.left, right: position.right }
    : {
      position: 'absolute', zIndex,
      [align === 'end' ? 'right' : 'left']: 0,
      [placement === 'top' ? 'bottom' : 'top']: 38,
    };
  const sizing = sheet ? {} : width !== undefined ? { width } : { minWidth: 238 };
  const itemPad = sheet
    ? { padding: '8px 8px calc(8px + env(safe-area-inset-bottom, 0px))', display: 'flex', flexDirection: 'column' }
    : { padding: 4, display: 'flex', flexDirection: 'column' };

  const renderItem = (it, i) => {
    if (it.divider) return <span key={i} aria-hidden="true" style={{ height: 1, background: 'var(--bs-gray-200, #e9ecef)', margin: '4px 0' }} />;
    if (it.heading) return <div key={i} role="presentation" style={{ padding: '8px 12px 6px', fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 'var(--letter-spacing-wide, 0.025em)', color: 'var(--text-secondary, #5a6268)' }}>{it.heading}</div>;
    const on = hover === i && !it.disabled;
    const checkable = it.type === 'checkbox' || it.type === 'radio';
    const role = it.type === 'checkbox' ? 'menuitemcheckbox' : it.type === 'radio' ? 'menuitemradio' : 'menuitem';
    const activate = () => { if (it.onClick) it.onClick(); if (onClose && !it.keepOpen) onClose(); };
    const hasShortcut = Array.isArray(it.shortcut) && it.shortcut.length > 0;
    const hasDescription = it.description != null && it.description !== false;
    const hasMeta = it.meta != null && it.meta !== false;
    const rich = comfortable || hasChecks || checkable || hasShortcut || hasDescription || hasMeta || it.leading != null || it.external;

    if (!rich) {
      const fg = it.danger ? 'var(--text-overdue, #991b1b)' : on ? 'var(--text-link-hover, #005a7d)' : 'var(--text-body, #212529)';
      return (
        <button
          key={i}
          type="button"
          role="menuitem"
          disabled={it.disabled}
          onClick={activate}
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover(null)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            padding: '7px 12px', border: 'none', textAlign: 'left',
            background: on ? 'var(--tint-primary-hover, rgba(0,121,168,.05))' : 'transparent',
            borderRadius: 'var(--radius-sm, 4px)',
            font: 'inherit', fontSize: 'var(--font-size-dense, 13px)', fontWeight: 400,
            color: fg, cursor: it.disabled ? 'not-allowed' : 'pointer',
            opacity: it.disabled ? 0.65 : 1,
            transition: 'background-color .15s ease, color .15s ease',
          }}
        >
          {it.icon && <i className={`bi ${it.icon}`} aria-hidden="true" style={{ fontSize: 'var(--icon-sm, 14px)', width: 16 }} />}
          {it.label}
        </button>
      );
    }

    const id = `${baseId}-${i}`;
    const describedBy = [
      hasDescription && `${id}-d`, hasMeta && `${id}-m`, hasShortcut && `${id}-k`, it.external && `${id}-x`,
    ].filter(Boolean).join(' ') || undefined;
    const fg = it.danger
      ? 'var(--text-overdue, #991b1b)'
      : on && !comfortable ? 'var(--text-link-hover, #005a7d)' : 'var(--text-body, #212529)';
    const hoverBg = comfortable ? 'var(--tint-primary-selected, rgba(0,121,168,.10))' : 'var(--tint-primary-hover, rgba(0,121,168,.05))';
    const leadWidth = comfortable ? 20 : 16;
    const lead = it.leading != null
      ? <span style={{ width: leadWidth, display: 'grid', placeItems: 'center', flex: 'none' }}>{it.leading}</span>
      : it.icon
        ? <i className={`bi ${it.icon}`} aria-hidden="true" style={{ fontSize: comfortable ? 'var(--font-size-md, 16px)' : 'var(--icon-sm, 14px)', width: leadWidth, textAlign: 'center', flex: 'none' }} />
        : comfortable ? <span aria-hidden="true" style={{ width: leadWidth }} /> : null;
    const text = (
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span id={`${id}-l`}>{it.label}</span>
        {hasDescription && (
          <span id={`${id}-d`} style={{ fontSize: comfortable ? 'var(--font-size-dense, 13px)' : 'var(--font-size-xs, 12px)', fontWeight: 400, color: 'var(--text-secondary, #5a6268)' }}>{it.description}</span>
        )}
      </span>
    );
    const trailing = (
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
        {hasMeta && (
          <span id={`${id}-m`} style={{ fontFamily: 'var(--font-data, monospace)', fontSize: 'var(--font-size-dense, 13px)', fontVariantNumeric: 'tabular-nums', color: 'var(--text-data, #495057)', fontWeight: 400 }}>{it.meta}</span>
        )}
        {hasShortcut && (
          <ShortcutKey id={`${id}-k`} label={it.shortcutLabel}>
            {it.shortcut.map((k, j) => <span key={j}>{k}</span>)}
          </ShortcutKey>
        )}
        {it.external && (
          <>
            <i className="bi bi-box-arrow-up-right" aria-hidden="true" style={{ fontSize: 'var(--font-size-sm, 14px)', color: 'var(--text-secondary, #5a6268)' }} />
            <span id={`${id}-x`} style={SR_ONLY}>Opens elsewhere</span>
          </>
        )}
      </span>
    );
    const mark = hasChecks
      ? (checkable
        ? <i className="bi bi-check2" aria-hidden="true" style={{ width: 16, textAlign: 'center', color: 'var(--text-link-on-tint, #00688f)', visibility: it.checked ? 'visible' : 'hidden' }} />
        : <span aria-hidden="true" style={{ width: 16 }} />)
      : null;
    const layout = comfortable
      ? {
        display: 'grid', alignItems: 'center', columnGap: 12,
        gridTemplateColumns: `${leadWidth}px minmax(0, 1fr) auto${hasChecks ? ' 16px' : ''}`,
        minHeight: sheet ? 44 : 36, padding: hasDescription ? '6px 12px' : '0 12px',
        borderRadius: 'var(--radius-md, 5px)', fontSize: 'var(--font-size-sm, 14px)',
      }
      : {
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 12px', borderRadius: 'var(--radius-sm, 4px)', fontSize: 'var(--font-size-dense, 13px)',
      };

    return (
      <button
        key={i}
        type="button"
        role={role}
        aria-checked={checkable ? !!it.checked : undefined}
        aria-labelledby={`${id}-l`}
        aria-describedby={describedBy}
        data-menu-text={typeof it.label === 'string' ? it.label : undefined}
        disabled={it.disabled}
        onClick={activate}
        onMouseEnter={() => setHover(i)}
        onMouseLeave={() => setHover(null)}
        onFocus={() => setHover(i)}
        onBlur={() => setHover((h) => (h === i ? null : h))}
        style={{
          ...layout,
          width: '100%', border: 'none', textAlign: 'left',
          background: on ? hoverBg : 'transparent',
          font: 'inherit', fontSize: layout.fontSize,
          fontWeight: checkable && it.checked ? 600 : 400,
          color: fg, cursor: it.disabled ? 'not-allowed' : 'pointer',
          opacity: it.disabled ? 0.65 : 1,
          transition: 'background-color .15s ease, color .15s ease',
        }}
      >
        {lead}
        {text}
        {trailing}
        {mark}
      </button>
    );
  };

  const rootStyle = sheet
    ? {
      ...positioned,
      background: 'var(--surface-card, #fff)',
      border: 0,
      borderTop: '1px solid var(--border-color, #dee2e6)',
      /* The phone sheet's 12px top corners have no radius token; the scale stops at 8px. */
      borderRadius: '12px 12px 0 0',
      boxShadow: 'var(--shadow-up, 0 -6px 16px rgba(0,0,0,.14))',
    }
    : {
      ...positioned,
      ...sizing,
      background: 'var(--surface-card, #fff)',
      border: '1px solid var(--border-color, #dee2e6)',
      borderRadius: comfortable ? 'var(--radius-lg, 8px)' : 'var(--radius-md, 5px)',
      boxShadow: placement === 'top' && (anchored || !position)
        ? 'var(--shadow-up, 0 -6px 16px rgba(0,0,0,.14))'
        : 'var(--shadow-md, 0 2px 4px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.10))',
    };
  /* A press on the scrim is an outside press: the document listener above calls onClose. */
  const scrim = sheet
    ? <div aria-hidden="true" data-menu-scrim="" style={{ position: 'fixed', inset: 0, zIndex: zIndex - 1, background: MENU_SHEET_SCRIM }} />
    : null;

  // A header (e.g. a zoom input) is not a menu item, so it sits beside the menu
  // role inside the floating sheet rather than inside role="menu".
  if (header != null) {
    return (
      <React.Fragment>
        {scrim}
        <div ref={ref} data-menu-presentation={sheet ? 'sheet' : undefined} style={{ ...rootStyle, display: 'flex', flexDirection: 'column', ...style }} {...rest} onKeyDown={onKeyDown}>
          <div style={{ padding: 8, borderBottom: '1px solid var(--list-divider, #e9ecef)' }}>{header}</div>
          <div role="menu" aria-label={label} style={itemPad}>{items.map(renderItem)}</div>
        </div>
      </React.Fragment>
    );
  }

  const menu = (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-menu-presentation={sheet ? 'sheet' : undefined}
      style={{ ...rootStyle, ...itemPad, ...style }}
      {...rest}
      onKeyDown={onKeyDown}
    >
      {items.map(renderItem)}
    </div>
  );
  return scrim ? <React.Fragment>{scrim}{menu}</React.Fragment> : menu;
}
