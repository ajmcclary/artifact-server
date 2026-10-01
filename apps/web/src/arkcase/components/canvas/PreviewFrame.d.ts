import React from 'react';

/** A viewport width the reviewer can pick; `px: null` fits the column. */
export interface PreviewPreset {
  /** Label shown in the picker — 'Fit', '1440'. */
  key: string;
  /** Frame width in pixels, or null to fill the column. */
  px: number | null;
}

export interface PreviewFrameProps extends Omit<React.HTMLAttributes<HTMLElement>, 'style' | 'title'> {
  /** The artifact's frame name in the navy bar; truncates with an ellipsis at 12px. Omit it and `meta` for a frame with no bar. */
  title?: React.ReactNode;
  /** Right-hand meta in the data face at 11px — a version such as "v3 · draft". */
  meta?: React.ReactNode;
  /** Colour of the dot before the title. @default "info" */
  dotTone?: 'info' | 'primary' | 'success' | 'warning' | 'danger' | 'neutral';
  /** Frame width in pixels from the chosen preset, or null for 100%. Always capped at the column and centred. @default null */
  width?: number | null;
  /** Accessible name of the region; defaults to `title` when it is a string. */
  label?: string;
  /** The preview content. The body is `position: relative`, so AnnotationPins and a PickLayer can be laid over it. */
  children?: React.ReactNode;
  /** Style overrides for the frame root. */
  style?: React.CSSProperties;
  /** Style overrides for the positioned content area (under the title bar, when there is one) — padding, min-height. */
  bodyStyle?: React.CSSProperties;
}

/** The titled card a review surface draws an artifact preview in, sized to a viewport preset. */
export declare function PreviewFrame(props: PreviewFrameProps): React.JSX.Element;

/**
 * The presets that fit `available` pixels (plus `slack`), always keeping the
 * null "Fit" entry. Defaults to Fit, 1440, 834 and 390 with 40px of slack.
 */
export declare function previewPresets(available: number, presets?: PreviewPreset[], slack?: number): PreviewPreset[];
