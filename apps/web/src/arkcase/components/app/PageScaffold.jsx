import React from 'react';
import { SectionHeading } from '../record/SectionHeading.jsx';

/**
 * ArkCase PageScaffold — the frame every admin and settings route opens in. A band on the
 * card surface carries the screen's `SectionHeading` — serif title, count chip, meta line,
 * the screen's actions at the end — over a rule; beneath it the body scrolls on its own,
 * and the content sits in one column capped at `maxWidth` (1000px) with a 14px rhythm
 * between its blocks, so a settings form or a card grid never stretches across a wide
 * monitor. The band stays put while the body scrolls.
 *
 * Harvested from the Artifacts workstation's admin screens, which each repeated the band,
 * the scroller and the capped column by hand. It owns no state.
 */
export function PageScaffold({
  title, count, meta, level = 2, actions, maxWidth = 1000, bodyPadding = '14px 18px 24px', label, style, children, ...rest
}) {
  const name = label != null ? label : typeof title === 'string' ? title : undefined;
  return (
    <section
      aria-label={name}
      data-screen-label={label}
      style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', ...style }}
      {...rest}
    >
      <div style={{ flex: 'none', padding: '14px 18px 12px', background: 'var(--surface-card, #fff)', borderBottom: '1px solid var(--border-color, #dee2e6)' }}>
        <SectionHeading level={level} title={title} count={count} meta={meta}>{actions}</SectionHeading>
      </div>
      {/* Focusable so a keyboard can scroll a body with no controls in it. */}
      <div tabIndex={0} data-page-body="" style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: bodyPadding }}>
        <div style={{ maxWidth, display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
      </div>
    </section>
  );
}
