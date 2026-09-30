import React from 'react';

/** The pointer a budget decides for: 'none' can never pin (mobile), 'coarse' is a tablet, 'fine' a mouse. */
export type PanelPointer = 'none' | 'coarse' | 'fine';

/** The display profile the floor is read against. Anything but 'tablet' and 'laptop' takes the desktop floor. */
export type PanelProfile = 'mobile' | 'tablet' | 'laptop' | 'desktop' | string;

export interface PanelBudgetConfig {
  /** The route's panels in priority order — the working list before secondary filters and selectors. */
  order?: string[];
  /** Which panels want a pin, by id — the host's stored preference before admission. */
  wants?: Record<string, boolean>;
  /** Each panel's docked width by id. @default 330 */
  widths?: Record<string, number>;
  /** Per-panel floor overrides by id — the width the working pane must keep beside this panel. @default 480 */
  floors?: Record<string, number>;
  /** Width already spent left of the panels: the navigation column — 0, 56, or its expanded width. @default 0 */
  seed?: number;
  /** The width the panels share. */
  viewportWidth?: number;
  /** Caps the floor: tablet 320, laptop 360, otherwise 480. 'mobile' derives a pointer of 'none'. */
  profile?: PanelProfile;
  /** A coarse (touch) pointer. Derives 'coarse' unless `pointer` is given. */
  coarsePointer?: boolean;
  /** Overrides the derived pointer. */
  pointer?: PanelPointer;
  /**
   * Admit by recency instead of `order`: the panel pinned most recently wins the width and
   * an older pin stands down to its rail — its preference kept, so it returns when the newer
   * pin is released or room comes back. `can` then asks only whether a panel fits beside the
   * seed, so a railed pin is never refused for want of room another pin holds. @default false
   */
  autoCollapse?: boolean;
  /** With `autoCollapse`, the keys most recently pinned first. `usePanelBudget` keeps it; pass it only to the pure `admitPanels`. */
  recent?: string[];
}

export interface PanelAdmission {
  /** Which panels in `order` are admitted: they wanted a pin and fit beside the ones before them. */
  admitted: Record<string, boolean>;
  /** The width the seed and the admitted panels take together. */
  used: number;
  /** The width used left of each key in `order`: the seed plus the admitted panels before it. */
  leftOf: Record<string, number>;
  /** The same decision for any panel — a railed one asking whether it could pin — without taking width. */
  can: (key: string, width?: number, floor?: number) => boolean;
}

export interface PanelBudgetValue extends PanelAdmission {
  pointer: PanelPointer;
  viewportWidth?: number;
  profile?: PanelProfile;
  autoCollapse: boolean;
  /** With `autoCollapse`, marks `key` as the newest pin; `initial` touches from the budget's first render are ignored so `order` holds on load. `Panel` calls it. */
  touch?: (key: string, initial?: boolean) => void;
}

/** The narrowest working pane a profile protects: `requested` (default 480) capped at 320 on a tablet, 360 on a laptop, 480 otherwise. */
export function pinFloor(profile: PanelProfile | undefined, requested?: number): number;

/** One pure pin decision: false for a 'none' pointer, else whether the viewport minus what is occupied and the panel clears the floor. */
export function canPin(panelWidth: number, occupiedWidth: number, pointer: PanelPointer, floor: number | undefined, viewportWidth: number, profile?: PanelProfile): boolean;

/** The App's `tbLeftOf` / `tbAdmit` / `tbCould` as one pure function over the route's order. */
export function admitPanels(config: PanelBudgetConfig): PanelAdmission;

/** `admitPanels` memoised over the config, plus the derived pointer. React consumers use this; templates use `PanelBudget`. */
export function usePanelBudget(config: PanelBudgetConfig): PanelBudgetValue;

/** The context `Panel` reads its admission from by `id`. Lower-case so the compiler does not list it as a component. */
/** The context `PanelBudget` provides, created on first call. */
export function panelBudgetContext(): React.Context<PanelBudgetValue | null>;

export interface PanelBudgetProps extends PanelBudgetConfig {
  /** Content rendered inside the PanelBudget. */
  children?: React.ReactNode;
}

/**
 * The component twin of `usePanelBudget`: the config as props, the admission
 * provided to every `Panel` beneath it.
 */
export function PanelBudget(props: PanelBudgetProps): React.JSX.Element;

export namespace PanelBudget {
  const pinFloor: (profile: PanelProfile | undefined, requested?: number) => number;
  const canPin: (panelWidth: number, occupiedWidth: number, pointer: PanelPointer, floor: number | undefined, viewportWidth: number, profile?: PanelProfile) => boolean;
  const admitPanels: (config: PanelBudgetConfig) => PanelAdmission;
  /** 'none' on mobile, else 'coarse' for a coarse pointer, else 'fine'; an explicit `pointer` wins. */
  const pointerFor: (profile: PanelProfile | undefined, coarsePointer?: boolean, pointer?: PanelPointer) => PanelPointer;
}
