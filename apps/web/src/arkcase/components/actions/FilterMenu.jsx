import React from 'react';
import { Button } from './Button.jsx';
import { Menu } from '../overlays/Menu.jsx';

/**
 * ArkCase FilterMenu — one filter of a page toolbar: a small ghost trigger with a chevron
 * ("Types · 2", "Group: Date") that opens a Menu of choices — checkboxes for a filter, radios for
 * a grouping or sort. Promoted from the ArkCase Artifacts Activity and Library toolbars.
 *
 * The menu is as wide as its longest row, never narrower than `minWidth` nor wider than 400px or
 * the viewport, and hangs under the trigger's start edge (the Menu's `anchor`, so a second press on
 * the trigger closes it). Escape or a closing item returns focus to the trigger. With `presentation="sheet"` (a phone) it
 * is the Menu's bottom sheet in the comfortable density. Checkbox items normally carry `keepOpen`,
 * so several filters can be ticked in one visit. Set several side by side in a
 * `ToolbarGroup variant="flush"`; summarise what they narrowed with `ActiveFilters`.
 *
 * Open state is controlled when `open` is passed (the host can keep one menu open at a time) and
 * kept inside otherwise; `onOpenChange` reports every change either way.
 */
/* Hands focus back to the trigger after the menu closes, unless the close came from a press
   that has already put focus somewhere else on purpose. */
function restoreFocus(el) {
  if (!el || typeof document === 'undefined') return;
  const a = document.activeElement;
  if (!a || a === document.body || (a.closest && a.closest('[role="menu"]'))) el.focus();
}

export function FilterMenu({
  open: openProp, defaultOpen = false, onOpenChange, icon, label, menuLabel, items = [], minWidth, width = 'max-content',
  density, presentation = 'popover', disabled = false, triggerRef, style, ...rest
}) {
  const [own, setOwn] = React.useState(defaultOpen);
  const controlled = openProp !== undefined;
  const open = controlled ? !!openProp : own;
  const set = (next) => {
    if (!controlled) setOwn(next);
    if (onOpenChange) onOpenChange(next);
  };
  /* The wrapper is the Menu's anchor: a press on the trigger is its own toggle, not an outside
     press that would close the menu only for the click to reopen it. */
  const wrapRef = React.useRef(null);
  const [anchorEl, setAnchorEl] = React.useState(null);
  const triggerRefLatest = React.useRef(triggerRef);
  triggerRefLatest.current = triggerRef;
  const setWrap = React.useCallback((el) => {
    wrapRef.current = el;
    setAnchorEl(el);
    const r = triggerRefLatest.current;
    if (typeof r === 'function') r(el);
    else if (r) r.current = el;
  }, []);
  /* Tab leaves the menu for the next control, so focus is not pulled back to the trigger. */
  const tabbing = React.useRef(false);
  const close = () => {
    set(false);
    if (tabbing.current) { tabbing.current = false; return; }
    restoreFocus(wrapRef.current && wrapRef.current.querySelector('button'));
  };
  const sheet = presentation === 'sheet';
  return (
    <span ref={setWrap} data-filter-menu="" style={{ position: 'relative', display: 'inline-flex', flex: 'none', ...style }} {...rest}>
      <Button variant="ghost" size="sm" icon={icon} iconRight="bi-chevron-down" expanded={open} hasPopup="menu" disabled={disabled}
        onClick={() => set(!open)} style={sheet ? { whiteSpace: 'nowrap' } : undefined}>{label}</Button>
      <Menu open={open && !disabled} onClose={close} label={menuLabel || (typeof label === 'string' ? label : undefined)} align="start"
        anchor={anchorEl} onKeyDown={(e) => { tabbing.current = e.key === 'Tab'; }}
        density={sheet ? 'comfortable' : density} items={items} presentation={presentation} width={sheet ? undefined : width}
        style={sheet ? undefined : { minWidth, maxWidth: 'min(400px, calc(100vw - 32px))' }} />
    </span>
  );
}
