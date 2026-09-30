import { akStyleDocument } from '@/arkcase-style';
import React from 'react';

/* Grid items default to min-width: auto, so a long code or a wide table inside a cell can
   push past its track. The shrink rule needs a child selector, so it lives in a sheet
   injected once and scoped by data attribute. */
function ensureAutoGridStyles() {
  if (typeof document === 'undefined' || akStyleDocument.getElementById('ak-auto-grid-css')) return;
  const s = akStyleDocument.createElement('style');
  s.id = 'ak-auto-grid-css';
  s.textContent = '[data-ak-auto-grid-shrink]>*{min-width:0}';
  akStyleDocument.head.appendChild(s);
}

/**
 * ArkCase AutoGrid — the responsive card grid: as many equal columns as fit at `min` px
 * each (260 by default), reflowing to one column on a narrow pane without a media query,
 * because it answers to its container's width rather than the viewport's. The `min(100%,…)`
 * clamp keeps a single column from overflowing a pane narrower than `min`.
 *
 * `maxColumns` caps the count: each column's floor becomes the larger of `min` and an
 * equal share of the row, so `min={442} maxColumns={2} gap={16}` is two equal columns that
 * collapse to one below a 900px container. `align` sets the cells' block alignment
 * (`start` stops a short card stretching to its neighbour's height); `cellMinWidth0` lets
 * cells shrink below their content's minimum width.
 *
 * Harvested from the Artifacts workstation's settings and library screens, which each wrote
 * `repeat(auto-fit, minmax(260px, 1fr))` by hand.
 */
export function AutoGrid({ min = 260, gap = 14, maxColumns, align, cellMinWidth0 = false, as: Tag = 'div', style, children, ...rest }) {
  React.useEffect(() => { if (cellMinWidth0) ensureAutoGridStyles(); }, [cellMinWidth0]);
  const floor = 'min(100%, ' + min + 'px)';
  const cap = maxColumns > 0 ? Math.floor(maxColumns) : 0;
  const gapLen = typeof gap === 'number' ? gap + 'px' : String(gap).split(' ').pop();
  const track = cap
    ? 'max(' + floor + ', calc((100% - ' + (cap - 1) + ' * ' + gapLen + ') / ' + cap + '))'
    : floor;
  return (
    <Tag
      data-ak-auto-grid-shrink={cellMinWidth0 ? '' : undefined}
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(' + track + ', 1fr))',
        gap,
        alignItems: align,
        ...style,
      }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
