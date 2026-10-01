import React from 'react';
import { Eyebrow } from '../data-display/Eyebrow.jsx';

/**
 * ArkCase PanelSection — one titled section of a side panel or a popover: an 11px uppercase
 * heading (the `Eyebrow`) over its body, with a full-width rule between sections. A Details
 * inspector is a column of them — This Version, Access, Links, Hosting — and a Share popover
 * ends on a `band` section on the secondary ground. The first section of a column passes
 * `divided={false}`. Its heading is a real heading at `headingLevel`.
 */
export function PanelSection({ title, headingLevel = 3, actions, divided = true, tone = 'default', gap = 10, padding = '14px 16px 16px', style, children, ...rest }) {
  const band = tone === 'band';
  return (
    <section
      data-panel-section={band ? 'band' : ''}
      style={{
        padding,
        borderTop: divided ? '1px solid var(--border-color, #dee2e6)' : 0,
        background: band ? 'var(--surface-secondary, #f8f9fa)' : undefined,
        display: 'flex', flexDirection: 'column', gap,
        ...style,
      }}
      {...rest}
    >
      {title != null && (actions
        ? <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Eyebrow as={'h' + headingLevel} style={{ margin: 0, flex: '1 1 auto' }}>{title}</Eyebrow>{actions}
        </div>
        : <Eyebrow as={'h' + headingLevel} style={{ margin: 0 }}>{title}</Eyebrow>)}
      {children}
    </section>
  );
}
