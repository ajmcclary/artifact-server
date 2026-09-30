import React from 'react';

export type DisplayProfileName = 'mobile' | 'tablet' | 'laptop' | 'desktop';
export type DisplayProfileForce = 'Mobile' | 'Tablet' | 'Laptop' | 'Desktop' | null;

/**
 * The breakpoint ladder. Widths are the pixel floor of each profile: `mobile` is
 * the floor of `tablet`, `laptop` and `desktop` their own, and `compact` is the
 * app-bar presentation threshold that sits inside the tablet band. `widths` are
 * the nominal viewport a forced profile stands in for.
 *
 * The default is the Workers Compensation ladder (768 / 900 / 1100 / 1440). The
 * ExtractionKit alternative is `{ mobile: 576, compact: 768, laptop: 992,
 * desktop: 1400 }` — pass it as `ladder` and the shell reflows on those numbers;
 * any key left out keeps its default.
 */
export interface DisplayLadder {
  mobile?: number;
  compact?: number;
  laptop?: number;
  desktop?: number;
  widths?: Partial<Record<DisplayProfileName, number>>;
}

export interface DisplayProfileValue {
  profile: DisplayProfileName;
  /** The width every tier decision reads — the ladder's nominal width when forced. */
  width: number;
  /** `window.innerWidth`, whatever is forced. */
  realWidth: number;
  /** The forced profile name in its `Mobile`/`Tablet`/… form, or null. */
  forced: string | null;
  /** `mobile` or `tablet`. */
  narrow: boolean;
  /** `mobile`, or `width` below the ladder's `compact`. */
  barCompact: boolean;
  /** `(pointer: coarse)` matched. */
  coarsePointer: boolean;
  /** `(prefers-reduced-motion: reduce)` matched. */
  reduceMotion: boolean;
  ladder: Required<DisplayLadder>;
}

export interface DisplayProfileOptions {
  /** Pin the profile, as the App's Display tweak does. Session-only; never stored. @default null */
  force?: DisplayProfileForce | string | null;
  /** @default defaultLadder */
  /** Breakpoint ladder used to resolve the display profile. */
  ladder?: DisplayLadder;
}

export interface DisplayProfileProps extends DisplayProfileOptions {
  /** Wrapper element carrying `data-ac-profile`; pass null to provide context only. @default "div" */
  as?: keyof React.JSX.IntrinsicElements | null;
  /** Style overrides for the DisplayProfile root. */
  style?: React.CSSProperties;
  /** Content rendered inside the DisplayProfile. */
  children?: React.ReactNode;
}

/** The Workers Compensation ladder: 768 / 900 / 1100 / 1440 with nominal widths 390 / 900 / 1280 / 1600. */
export const defaultLadder: Required<DisplayLadder>;

/** Provided by `DisplayProfile`; null outside one, so consumers fall back to their own defaults. */
/** The context `DisplayProfile` provides, created on first call. */
export function displayProfileContext(): React.Context<DisplayProfileValue | null>;

/**
 * Measures the viewport, the pointer and the motion preference and names the
 * profile. Not exposed on the namespace — React consumers only.
 */
export function useDisplayProfile(options?: DisplayProfileOptions): DisplayProfileValue;

/**
 * Component twin of `useDisplayProfile` for templates: provides the value
 * through `displayProfileContext` and renders a wrapper carrying
 * `data-ac-profile` so CSS can key on the profile. `AppShell` uses it as its root.
 */
export function DisplayProfile(props: DisplayProfileProps): React.JSX.Element;

export interface DisplayReading {
  force?: DisplayProfileForce | string | null;
  ladder?: DisplayLadder;
  /** `window.innerWidth`, or the host's own measurement. */
  realWidth: number;
  coarsePointer?: boolean;
  reduceMotion?: boolean;
}

export namespace DisplayProfile {
  /** The reading the hook and the component share, for a host that keeps its own state: no window, no media query — the caller passes what it measured. */
  const read: (input: DisplayReading) => DisplayProfileValue;
  /** `defaultLadder`, reachable without the lowercase export. */
  const ladder: Required<DisplayLadder>;
}
