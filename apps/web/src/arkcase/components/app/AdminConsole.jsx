import React from 'react';

/**
 * ArkCase AdminConsole — the administration layout the ArkCase workstations share: an area
 * menu at the start (a `SideNav` the host pins or peeks), then a heading band on the card
 * surface (a breadcrumb `SectionHeading`), and under it a scrolling region of list panels on
 * the canvas with an optional inspector docked at its end (a `SlideOver` for the selected
 * member or key). The region is a named landmark; `overlay` renders the confirmations.
 */
export function AdminConsole({ nav, heading, label, inspector, overlay, maxWidth = 1360, children, style, ...rest }) {
  return (
    <div data-admin-console="" style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, display: 'flex', ...style }} {...rest}>
      {nav}
      <div style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div data-adm-head="" style={{ flex: 'none', background: 'var(--surface-card, #fff)', borderBottom: '1px solid var(--border-color, #dee2e6)', padding: '8px 16px 8px 14px' }}>{heading}</div>
        <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', position: 'relative' }}>
          <div role="region" aria-label={label} tabIndex={-1} style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'auto', background: 'var(--surface-canvas, #f1f5f7)' }}>
            <div data-adm-content="" style={{ padding: '16px 20px 28px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth }}>{children}</div>
          </div>
          {inspector}
        </div>
      </div>
      {overlay}
    </div>
  );
}
