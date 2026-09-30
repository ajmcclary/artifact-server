import React from 'react';

/** Decorative route glyph; the surrounding control supplies its accessible name. */
export function NavigationIcon({ icon = 'bi-circle', style }) {
  return <i aria-hidden="true" data-icon-context="navigation" className={`bi ${icon}`}
    style={{ display: 'inline-flex', flex: 'none', width: 'var(--icon-lg, 20px)',
      height: 'var(--icon-lg, 20px)', fontSize: 'var(--icon-lg, 20px)', lineHeight: 1, ...style }} />;
}
