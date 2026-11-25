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
 * them (zoom out · zoom select · zoom in); `variant="flush"` sets a run of ghost controls (filter
 * menus) shoulder to shoulder with no border, wrapping inside itself or, with `overflow="scroll"`,
 * scrolling sideways on a phone. `wrap` lets a crowded toolbar wrap its rows.
 *
 * `placement="floating"` is a viewer's control pill, promoted from the ArkCase Artifacts Office
 * viewers: centred at the foot of its positioned container on a card ground with a hairline and
 * the large shadow. `quiet` dims it while the host says so (the column is scrolling) until the
 * pointer is over it or focus is inside it.
 */
/* Created on first render, not at module load: the portable bundle evaluates on pages that
   load no React, and its lazy React bridge throws on any use before then. */
let _toolbarContext = null;
const toolbarContext = () => _toolbarContext || (_toolbarContext = React.createContext({ orientation: 'horizontal', variant: 'light' }));

const ITEMS = 'button:not([tabindex="-1"]), input:not([type="hidden"]):not([tabindex="-1"]), select:not([tabindex="-1"]), textarea:not([tabindex="-1"]), a[href]:not([tabindex="-1"]), [role="button"]:not(button):not([tabindex="-1"])';

/* Pane chrome: a toolbar ruled under a pane header, or docked at a pane's foot; or a viewer's
   floating pill. The pill is centred by auto margins, not a transform: a transform would become
   the containing block of any fixed-position menu opened from inside it. */
const PLACEMENTS = {
  floating: {
    position: 'absolute', left: 0, right: 0, bottom: 16, zIndex: 50, margin: '0 auto', width: 'fit-content', maxWidth: 'calc(100% - 24px)',
    padding: 4, borderRadius: 'var(--radius-pill, 10px)', background: 'var(--surface-card, #ffffff)',
    border: '1px solid var(--border-color, #dee2e6)', boxShadow: 'var(--shadow-lg, 0 8px 24px rgba(7, 54, 82, 0.18))',
    transition: 'opacity 160ms ease',
  },
  'pane-top': { flex: 'none', padding: '10px 16px', background: 'var(--surface-card, #ffffff)', borderBottom: '1px solid var(--border-color, #dee2e6)' },
  'pane-footer': { flex: 'none', minHeight: 56, padding: '8px 20px', background: 'var(--surface-card, #ffffff)', borderTop: '1px solid var(--border-color, #dee2e6)', boxShadow: 'var(--shadow-up, 0 -6px 16px rgba(0, 0, 0, 0.14))' },
};

export function Toolbar({ label, orientation = 'horizontal', variant = 'light', placement = 'inline', quiet = false, gap = 4, wrap = false, children, style, onKeyDown,
  onPointerEnter, onPointerLeave, onFocus, onBlur, ...rest }) {
  const Ctx = toolbarContext();
  const vertical = orientation === 'vertical';
  const navy = variant === 'navy';
  const floating = placement === 'floating';
  /* Pointer over the bar or focus inside it: a quiet floating bar returns to full strength. */
  const [near, setNear] = React.useState(false);
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
        data-toolbar-placement={placement === 'inline' ? undefined : placement}
        data-quiet={floating && quiet && !near ? 'true' : undefined}
        onKeyDown={handleKey}
        onPointerEnter={(e) => { if (floating) setNear(true); onPointerEnter && onPointerEnter(e); }}
        onPointerLeave={(e) => { if (floating) setNear(false); onPointerLeave && onPointerLeave(e); }}
        onFocus={(e) => { if (floating) setNear(true); onFocus && onFocus(e); }}
        onBlur={(e) => { if (floating && !e.currentTarget.contains(e.relatedTarget)) setNear(false); onBlur && onBlur(e); }}
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
          ...(PLACEMENTS[placement] || null),
          ...(floating ? { opacity: quiet && !near ? 0.4 : 1 } : null),
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

/* A flush group: adjacent ghost controls with no border or dividers between them (their own
   padding spaces them). It keeps its width and wraps inside itself only when wider than the row;
   with `overflow="scroll"` it is one row that scrolls sideways instead (a phone's filter menus,
   which open as sheets, so nothing is clipped by the scrolling row). */
const FLUSH = {
  wrap: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', flexShrink: 0, maxWidth: '100%' },
  scroll: {
    display: 'flex', flexWrap: 'nowrap', alignItems: 'center', flex: '1 1 100%', minWidth: 0, maxWidth: '100%', overflowX: 'auto',
    overscrollBehaviorX: 'contain', scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch', padding: '2px 0',
  },
};

export function ToolbarGroup({ label, variant = 'joined', overflow = 'wrap', children, style, ...rest }) {
  React.useEffect(ensureToolbarGroupStyles, []);
  if (variant === 'flush') {
    const mode = overflow === 'scroll' ? 'scroll' : 'wrap';
    return <div role="group" aria-label={label} data-ak-toolbar-flush={mode} style={{ ...FLUSH[mode], ...style }} {...rest}>{children}</div>;
  }
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
