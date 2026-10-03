import React from 'react';

/** One toast a ToastRegion draws. Other Toast props (`actionPlacement`, `data-*` attributes) pass through to the Toast. */
export interface ToastRegionItem {
  /** Stable key; `onDismiss` receives it. */
  id: string | number;
  /** Toast tone. @default "info" */
  variant?: 'primary' | 'info' | 'success' | 'warning' | 'danger';
  /** Bold lead line. Strings are also spoken by the region. */
  title?: React.ReactNode;
  /** The detail line under the title. Strings are also spoken by the region. */
  message?: React.ReactNode;
  /** Repeats collapse into a count. @default 1 */
  count?: number;
  /** Single follow-up verb ("Undo", "Retry"). */
  actionLabel?: string;
  /** Called when the follow-up verb is activated. */
  onAction?: () => void;
  /** Overrides the tone's status glyph (`bi-*` icon class). */
  icon?: string;
  /** True while the toast plays its exit motion; the host drops it from `toasts` afterwards. The region stops speaking a leaving toast. */
  leaving?: boolean;
  /** Per-toast dismissal; overrides `onDismiss` for this toast. */
  onClose?: () => void;
  /** Any other Toast prop or attribute, passed through. */
  [prop: string]: unknown;
}

export interface ToastRegionProps {
  /**
   * The toasts to show, oldest first; the newest sits nearest the edge. While this array is
   * given the region keeps a polite and an assertive live region mounted and speaks the newest
   * toast that is not leaving (its string title and message) — assertively for `danger` and
   * `warning` — and its toasts render with `live="off"`.
   */
  toasts?: ToastRegionItem[];
  /** Hand-placed Toasts after the `toasts` ones; they announce for themselves. */
  children?: React.ReactNode;
  /** The corner or edge the stack sits at. `start`/`end` follow the writing direction. @default "bottom-start" */
  placement?: 'bottom-start' | 'bottom-center' | 'bottom-end' | 'top-end' | 'top-start' | 'top-center';
  /** Gap from the viewport edges in px: a number for both, or `{ x, y }`. A phone passes 12. @default { x: 20, y: 18 } */
  offset?: number | { x?: number; y?: number };
  /** Extra inline-start inset in px that clears a navigation rail (56 railed, the stored width expanded, 0 on a phone). @default 0 */
  offsetStart?: number;
  /** Layout of the toasts drawn from `toasts`. @default "snackbar" */
  layout?: 'card' | 'snackbar';
  /** Called with a toast's `id` when its dismiss control is pressed. Without it (and without the item's own `onClose`) no dismiss control is drawn. */
  onDismiss?: (id: string | number) => void;
  /** Accessible name of each dismiss control. @default "Dismiss notification" */
  dismissLabel?: string;
  /** Called once when the pointer enters the stack or focus moves into it — hold the auto-dismiss timer. */
  onPause?: () => void;
  /** Called once when the pointer leaves and focus is no longer inside — resume the timer. */
  onResume?: () => void;
  /** Speak `toasts` through the region's own live regions. False drops them: each toast then announces as an ordinary Toast, unless its item sets `live: 'off'` because the host speaks it elsewhere (AppShell `announce`). @default true */
  announce?: boolean;
  /** Stacking order of the fixed viewport. @default 1059 */
  zIndex?: number;
  /** Style overrides for the fixed viewport. */
  style?: React.CSSProperties;
}

/**
 * The fixed viewport transient toasts float in: placement, rail offset, stacking, enter and
 * exit motion, live regions and hover/focus pause. The host keeps the queue and the timers.
 */
export function ToastRegion(props: ToastRegionProps): React.JSX.Element;
