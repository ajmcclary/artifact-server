import React from 'react';

export interface AutoGridProps {
  /** Minimum column width in px; as many equal columns as fit at this width. @default 260 */
  min?: number;
  /** Gap between cells, in px or any CSS length. @default 14 */
  gap?: number | string;
  /** Most columns the grid may show, however wide the container; each column's floor becomes the larger of `min` and an equal share of the row. `min={442} maxColumns={2} gap={16}` is two equal columns collapsing to one below 900px. */
  maxColumns?: number;
  /** Block alignment of the cells (`align-items`); `start` keeps a short cell at its own height instead of stretching to the row. @default "stretch" */
  align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  /** Gives every direct child `min-width: 0`, so a long code, a wide table or a nowrap line inside a cell shrinks or scrolls within its track instead of pushing the grid wider. @default false */
  cellMinWidth0?: boolean;
  /** The element to render — "ul" for a list of cards. @default "div" */
  as?: React.ElementType;
  /** Style overrides for the AutoGrid root. */
  style?: React.CSSProperties;
  /** The cells — cards, tiles, summary panels. */
  children?: React.ReactNode;
}

/**
 * A responsive auto-fit grid: `repeat(auto-fit, minmax(min(100%, {min}px), 1fr))`, optionally
 * capped at `maxColumns`. It answers to its container's width, not the viewport's.
 */
export function AutoGrid(props: AutoGridProps): React.JSX.Element;
