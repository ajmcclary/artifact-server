/** One notification the application asks the toast region to show. */
export interface AppToast {
  readonly id?: string;
  readonly variant?: "primary" | "info" | "success" | "warning" | "danger";
  readonly title?: string;
  readonly message: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  /** Auto-dismiss delay; null keeps the toast until it is dismissed. */
  readonly durationMs?: number | null;
}

/** A toast in the queue: `count` rises when the same text is pushed again under its id. */
export interface QueuedToast {
  readonly count: number;
  readonly id: string;
  readonly leaving: boolean;
  readonly toast: AppToast;
}

export const defaultToastMilliseconds = 6_000;
/** The DS exit motion; under reduced motion a toast leaves at once. */
export const toastExitMilliseconds = 180;
export const maximumVisibleToasts = 3;

function leavingEntry(entry: QueuedToast): QueuedToast {
  return {count: entry.count, id: entry.id, leaving: true, toast: entry.toast};
}

function sameText(left: AppToast, right: AppToast): boolean {
  return left.title === right.title && left.message === right.message;
}

/**
 * Adds a toast, or replaces the one with the same id. When more than
 * `maximumVisibleToasts` would show, the oldest start leaving.
 */
export function queueToast(queue: readonly QueuedToast[], id: string, toast: AppToast): readonly QueuedToast[] {
  const existing = queue.find((entry) => entry.id === id);
  const next = existing === undefined
    ? [...queue, {count: 1, id, leaving: false, toast}]
    : queue.map((entry) => entry.id === id
      ? {count: sameText(entry.toast, toast) && !entry.leaving ? entry.count + 1 : 1, id, leaving: false, toast}
      : entry);
  let excess = next.filter((entry) => !entry.leaving).length - maximumVisibleToasts;
  return next.map((entry) => {
    if (excess <= 0 || entry.leaving || entry.id === id) return entry;
    excess -= 1;
    return leavingEntry(entry);
  });
}

export function markToastLeaving(queue: readonly QueuedToast[], id: string): readonly QueuedToast[] {
  return queue.map((entry) => entry.id === id ? leavingEntry(entry) : entry);
}

export function removeToast(queue: readonly QueuedToast[], id: string): readonly QueuedToast[] {
  return queue.filter((entry) => entry.id !== id);
}

/** Auto-dismiss delay for a toast; null means it stays until dismissed. */
export function toastLifetime(toast: AppToast): number | null {
  return toast.durationMs === undefined ? defaultToastMilliseconds : toast.durationMs;
}
