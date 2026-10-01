import React from 'react';

/**
 * ArkCase SkeletonLines — rounded bars that stand in for lines of text: a placeholder sketch
 * of a page, or a row's shape while it loads. Each entry of `lines` is one bar's width. The
 * bars are decorative (`aria-hidden`); pair them with a status message when they mean loading.
 */
export function SkeletonLines({ lines = ['72%', '58%', '64%', '41%'], height = 10, gap = 8, style, ...rest }) {
  return (
    <span data-skeleton-lines="" aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap, minWidth: 0, ...style }} {...rest}>
      {lines.map((width, i) => (
        <span key={i} style={{ display: 'block', height, width, borderRadius: 'var(--radius-sm, 4px)', background: 'var(--list-divider, #e9ecef)' }} />
      ))}
    </span>
  );
}
