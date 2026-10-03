import React from 'react';

/** Decorative route glyph; the surrounding control supplies its accessible name. */
export function NavigationIcon({ icon = 'bi-circle', active = false, style }) {
  return <i aria-hidden="true" data-icon-context="navigation" data-icon-state={active ? 'active' : undefined} className={`bi ${icon}`}
    style={{ display: 'inline-flex', flex: 'none', width: 'var(--icon-lg, 20px)',
      height: 'var(--icon-lg, 20px)', fontSize: 'var(--icon-lg, 20px)', lineHeight: 1, ...style }} />;
}
