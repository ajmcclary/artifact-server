import React from 'react';
import { Button } from '../actions/Button.jsx';
import { Popover } from '../overlays/Popover.jsx';

/**
 * ArkCase CrumbMenu — a breadcrumb crumb that opens a picker: the version of a record, the page
 * of a version. The trigger is a ghost Button with a trailing chevron whose label truncates;
 * the menu is a `Popover` on a desktop and a viewport sheet on a phone (`presentation`). On
 * open, focus moves to the element `focusSelector` names (the current row), else to the first
 * field or button; picking calls `close`, which shuts the menu and hands focus back to the
 * crumb. Place it in a `Breadcrumb variant="controls"` as a `{ node }` item.
 */
export function CrumbMenu({
  label, ariaLabel, title, open = false, onOpenChange, presentation = 'popover', width = 320,
  maxWidth = 260, current = false, focusSelector, zIndex = 1200, children, style, ...rest
}) {
  const wrapRef = React.useRef(null);
  const bodyRef = React.useRef(null);
  const sheet = presentation === 'sheet';
  React.useEffect(() => {
    if (!open) return undefined;
    const id = setTimeout(() => {
      const root = bodyRef.current;
      const target = root && ((focusSelector && root.querySelector(focusSelector)) || root.querySelector('input, button'));
      if (target) target.focus();
    }, 0);
    return () => clearTimeout(id);
  }, [open]);
  const close = () => {
    onOpenChange && onOpenChange(false);
    const trigger = wrapRef.current && wrapRef.current.querySelector('button');
    if (trigger) setTimeout(() => trigger.focus(), 0);
  };
  const trigger = (
    <Button variant="ghost" size="sm" iconRight="bi-chevron-down" aria-label={ariaLabel} title={typeof label === 'string' ? label : undefined}
      aria-current={current ? 'page' : undefined} expanded={!!open} hasPopup="dialog"
      style={{ minWidth: 0, maxWidth: sheet ? '100%' : maxWidth, minHeight: sheet ? 44 : undefined }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </Button>
  );
  const content = (
    <div ref={bodyRef} data-crumb-menu-body="" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {typeof children === 'function' ? children({ close }) : children}
    </div>
  );
  return (
    <span ref={wrapRef} data-crumb-menu="" style={{ display: 'inline-flex', minWidth: 0, maxWidth: '100%', ...style }} {...rest}>
      <Popover label={title} sheetTitle={title} presentation={sheet ? 'sheet' : 'popover'} open={open}
        onOpenChange={onOpenChange} trigger={trigger} width={width} zIndex={zIndex}
        style={{ display: 'inline-flex', minWidth: 0, maxWidth: '100%' }}
        contentStyle={{ padding: 0, gap: 0, maxHeight: '80vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {content}
      </Popover>
    </span>
  );
}
