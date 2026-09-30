import { akStyleDocument } from '@/arkcase-style';
import React from 'react';
import { rovingKeyDown } from '../utilities/a11y-keys.jsx';

/**
 * ArkCase Toolbar — a labelled `role="toolbar"` row (or column) of controls with arrow-key
 * movement between them, promoted from the Designer Storybook prototype's preview toolbars.
 * `variant="navy"` is the app-chrome bar: `surface-header` fill, `text-on-navy` ink, and
 * `data-navy` / `data-icon-tone="current"` so the children's studio icons render tonal.
 *
 * Tab order stays native: every enabled control remains a tab stop, and Left/Right (Up/Down
 * when vertical), Home and End add movement between them, wrapping at the ends. The APG single
 * tab stop would rewrite the children's `tabindex`; the prototype kept native order and so do
 * we. Arrow keys inside text fields and native selects keep their own meaning, and composites
 * nested in the toolbar (menus, listboxes, radio groups) own their keys.
 *
 * `ToolbarSeparator` is a `role="separator"` hairline perpendicular to the toolbar;
 * `ToolbarSpacer` is a flexible gap that pushes the following controls to the far end;
 * `ToolbarGroup` joins a few controls into one bordered segment with hairlines between
 * them (zoom out · zoom select · zoom in). `wrap` lets a crowded toolbar wrap its rows.
 */
/* Created on first render, not at module load: the portable bundle evaluates on pages that
   load no React, and its lazy React bridge throws on any use before then. */
let _toolbarContext = null;
const toolbarContext = () => _toolbarContext || (_toolbarContext = React.createContext({ orientation: 'horizontal', variant: 'light' }));

const ITEMS = 'button:not([tabindex="-1"]), input:not([type="hidden"]):not([tabindex="-1"]), select:not([tabindex="-1"]), textarea:not([tabindex="-1"]), a[href]:not([tabindex="-1"]), [role="button"]:not(button):not([tabindex="-1"])';

export function Toolbar({ label, orientation = 'horizontal', variant = 'light', gap = 4, wrap = false, children, style, onKeyDown, ...rest }) {
  const Ctx = toolbarContext();
  const vertical = orientation === 'vertical';
  const navy = variant === 'navy';
  const ctx = React.useMemo(() => ({ orientation: vertical ? 'vertical' : 'horizontal', variant: navy ? 'navy' : 'light' }), [vertical, navy]);

  const handleKey = (e) => {
    onKeyDown && onKeyDown(e);
    rovingKeyDown(e, { selector: ITEMS, orientation: vertical ? 'vertical' : 'horizontal', wrap: true });
  };

  return (
    <Ctx.Provider value={ctx}>
      <div
        role="toolbar"
        aria-label={label}
        aria-orientation={vertical ? 'vertical' : 'horizontal'}
        data-navy={navy ? 'true' : undefined}
        data-icon-tone={navy ? 'current' : undefined}
        onKeyDown={handleKey}
        style={{
          display: 'flex',
          flexDirection: vertical ? 'column' : 'row',
          alignItems: 'center',
          flexWrap: wrap ? 'wrap' : undefined,
          gap,
          boxSizing: 'border-box',
          ...(navy ? {
            padding: vertical ? '8px 4px' : '4px 8px',
            background: 'var(--surface-header, #073652)',
            color: 'var(--text-on-navy, #ffffff)',
          } : null),
          ...style,
        }}
        {...rest}
      >
        {children}
      </div>
    </Ctx.Provider>
  );
}

export function ToolbarSeparator({ variant, orientation, style, ...rest }) {
  const ctx = React.useContext(toolbarContext());
  const toolbarVertical = (orientation || ctx.orientation) === 'vertical';
  const navy = (variant || ctx.variant) === 'navy';
  const line = navy ? 'var(--border-on-navy, rgba(255,255,255,0.18))' : 'var(--border-color, #dee2e6)';
  return (
    <span
      role="separator"
      aria-orientation={toolbarVertical ? 'horizontal' : 'vertical'}
      style={{
        flex: 'none',
        display: 'block',
        width: toolbarVertical ? 20 : 1,
        height: toolbarVertical ? 1 : 20,
        margin: toolbarVertical ? '4px 0' : '0 4px',
        background: line,
        ...style,
      }}
      {...rest}
    />
  );
}

export function ToolbarSpacer({ style }) {
  return <span aria-hidden="true" style={{ flex: 1, minWidth: 0, minHeight: 0, ...style }} />;
}

/* The joined look needs child selectors (the controls keep their own inline borders), so
   the rules live in a sheet injected once and scoped by data attribute. */
function ensureToolbarGroupStyles() {
  if (typeof document === 'undefined' || akStyleDocument.getElementById('ak-toolbar-group-css')) return;
  const s = akStyleDocument.createElement('style');
  s.id = 'ak-toolbar-group-css';
  const kids = '[data-ak-toolbar-group]>:not([data-ak-toolbar-group-divider])';
  const ctl = (sel) => sel + ',' + sel + ' :is(button,select,input)';
  s.textContent =
    ctl(kids) + '{border-color:transparent!important;border-radius:0!important;box-shadow:none!important}' +
    ctl('[data-ak-toolbar-group]>:first-child') + '{border-top-left-radius:var(--radius-sm, 4px)!important;border-bottom-left-radius:var(--radius-sm, 4px)!important}' +
    ctl('[data-ak-toolbar-group]>:last-child') + '{border-top-right-radius:var(--radius-sm, 4px)!important;border-bottom-right-radius:var(--radius-sm, 4px)!important}';
  akStyleDocument.head.appendChild(s);
}

export function ToolbarGroup({ label, children, style, ...rest }) {
  React.useEffect(ensureToolbarGroupStyles, []);
  const items = React.Children.toArray(children).filter((c) => c != null && c !== false);
  const joined = [];
  items.forEach((child, i) => {
    if (i > 0) {
      joined.push(
        <span
          key={'divider-' + i}
          aria-hidden="true"
          data-ak-toolbar-group-divider=""
          style={{ flex: 'none', alignSelf: 'stretch', width: 1, background: 'var(--border-color, #dee2e6)' }}
        />,
      );
    }
    joined.push(child);
  });
  return (
    <div
      role="group"
      aria-label={label}
      data-ak-toolbar-group=""
      style={{
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'stretch',
        boxSizing: 'border-box',
        border: '1px solid var(--border-color-strong, #ced4da)',
        borderRadius: 'var(--radius-md, 5px)',
        background: 'var(--surface-card, #fff)',
        ...style,
      }}
      {...rest}
    >
      {joined}
    </div>
  );
}
