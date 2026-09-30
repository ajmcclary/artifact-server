import React from 'react';

/**
 * ArkCase useElementSize — the live client width and height of a referenced element, for a
 * component that lays itself out by measured room (a document viewer fitting a page to its
 * dock). It measures once before paint, then follows a ResizeObserver. The observer's callback
 * only schedules the read for the next animation frame: a synchronous state write during
 * observer delivery can change the observed layout and make Chromium report
 * "ResizeObserver loop completed with undelivered notifications". An unchanged size keeps the
 * previous object, so it does not re-render the host.
 *
 * Promoted from the ExtractionKit prototype's `useSize` (ek-viewer.js).
 */
export function useElementSize(ref, { initial } = {}) {
  const [size, setSize] = React.useState(() => ({
    width: (initial && initial.width) || 0,
    height: (initial && initial.height) || 0,
  }));
  React.useLayoutEffect(() => {
    const el = ref && ref.current;
    if (!el) return undefined;
    let frame = 0;
    const update = () => {
      const next = { width: el.clientWidth, height: el.clientHeight };
      setSize((old) => (old.width === next.width && old.height === next.height ? old : next));
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; update(); }); };
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    return () => { observer.disconnect(); if (frame) window.cancelAnimationFrame(frame); };
  }, [ref]);
  return size;
}
