import React from 'react';

/** A measured element size in CSS px (client box: padding included, border and scrollbar excluded). */
export interface ElementSize {
  /** The element's `clientWidth`. */
  width: number;
  /** The element's `clientHeight`. */
  height: number;
}

/** Options for `useElementSize`. */
export interface ElementSizeOptions {
  /** Size reported until the element is first measured (and when the ref is empty). @default { width: 0, height: 0 } */
  initial?: Partial<ElementSize>;
}

/**
 * Live client size of `ref.current`: measured before paint, then updated through a
 * ResizeObserver whose read is deferred to the next animation frame so layout that depends on
 * the size never raises the "ResizeObserver loop" error. The observer attaches when the host
 * mounts with the ref filled; an unchanged size returns the same object.
 */
export function useElementSize(ref: React.RefObject<HTMLElement | null>, options?: ElementSizeOptions): ElementSize;
