/**
 * The application's back stack, carried in `history.state`. Every entry this
 * application pushes records its position (`idx`) and, once left, the window's
 * scroll offset (`scrollY`), so a phone's ‹ Back and the browser's Back both
 * return to the place a person left: the phone's pages scroll the document,
 * and the browser cannot restore an offset the next screen's shorter page has
 * already clamped. A pushed screen (a review, a project's settings) also
 * records the entry it was opened from (`from`), which survives its own page
 * and version changes so ‹ Back returns straight to it.
 */
import {z} from "zod";

/** The entry a pushed screen was opened from. */
export interface HistoryOrigin {
  /** The application URL of that entry. */
  readonly href: string;
  /** Its position in the stack; behind the current entry, ‹ Back pops to it. */
  readonly idx: number;
}

const originSchema = z.object({href: z.string(), idx: z.number().int().nonnegative()});
const entrySchema = z.object({
  from: originSchema.optional(),
  idx: z.number().int().nonnegative().optional(),
  scrollY: z.number().nonnegative().optional(),
});
type EntryState = z.infer<typeof entrySchema>;

let currentIndex = 0;
let listening = false;
let stopRestoring: (() => void) | null = null;
let pendingScroll: number | null = null;

/** The current entry's state; this application is the only writer of `history.state`. */
function readEntry(): EntryState {
  const parsed = entrySchema.safeParse(window.history.state);
  return parsed.success ? parsed.data : {};
}

/**
 * Number the current entry and follow Back and Forward. Scroll restoration is
 * manual: the application restores each entry's own offset once it renders.
 */
export function startReviewHistory(): void {
  if (listening) return;
  listening = true;
  if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
  const entry = readEntry();
  currentIndex = entry.idx ?? 0;
  if (entry.idx === undefined) {
    window.history.replaceState({...entry, idx: 0} satisfies EntryState, "", window.location.href);
  }
  window.addEventListener("popstate", (event) => {
    currentIndex = readEntry().idx ?? 0;
    // Only the browser's own history moves are trusted; the application's in-place links are not.
    // Read here, first: the browser runs microtasks between listeners, so a screen may render
    // before any later listener sees the event.
    pendingScroll = event.isTrusted ? readEntry().scrollY ?? null : null;
  });
}

/** The current entry's position in the stack. */
export function historyIndex(): number {
  return currentIndex;
}

/** The entry the current screen was opened from, if this application recorded one. */
export function historyOrigin(): HistoryOrigin | null {
  return readEntry().from ?? null;
}

/** The offset the last Back or Forward returned to, once; null after an in-place navigation. */
export function takePendingScroll(): number | null {
  const y = pendingScroll;
  pendingScroll = null;
  return y;
}

/**
 * Push `href`. The entry being left keeps the window's offset; the new one
 * takes the next position and `from`, the entry a pushed screen came from.
 */
export function pushHistoryEntry(href: string, from: HistoryOrigin | null): void {
  stopRestoring?.();
  const leaving: EntryState = {...readEntry(), idx: currentIndex, scrollY: Math.max(0, window.scrollY)};
  window.history.replaceState(leaving, "", window.location.href);
  currentIndex += 1;
  const entering: EntryState = {idx: currentIndex};
  if (from !== null) entering.from = from;
  window.history.pushState(entering, "", href);
}

/** Replace the current entry's URL, keeping its position, origin and offset. */
export function replaceHistoryEntry(href: string): void {
  window.history.replaceState({...readEntry(), idx: currentIndex} satisfies EntryState, "", href);
}

/** Return to an entry behind the current one, as the browser's Back would. */
export function popHistoryTo(origin: HistoryOrigin): boolean {
  if (origin.idx >= currentIndex) return false;
  window.history.go(origin.idx - currentIndex);
  return true;
}

/** How long a restored offset is re-applied while the page settles. */
const settleMilliseconds = 2_000;

/**
 * Scroll the window to `y` once the screen has rendered, and keep re-applying
 * it while the page settles: a feed loads after it mounts, and headers that
 * dock on scroll compact once the offset is applied, which shortens the page
 * above them. A person scrolling stops it at once.
 */
export function restoreWindowScroll(y: number): () => void {
  stopRestoring?.();
  const deadline = performance.now() + settleMilliseconds;
  let frame = 0;
  let held = 0;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    if (stopRestoring === stop) stopRestoring = null;
    cancelAnimationFrame(frame);
    for (const type of userScrollEvents) window.removeEventListener(type, stop);
  };
  const apply = (): void => {
    if (stopped) return;
    if (Math.abs(window.scrollY - y) > 1) {
      held = 0;
      window.scrollTo(0, y);
    } else {
      held += 1;
    }
    // Held for a few frames, or out of time: the page has settled.
    if (held >= 6 || performance.now() > deadline) {
      stop();
      return;
    }
    frame = requestAnimationFrame(apply);
  };
  for (const type of userScrollEvents) window.addEventListener(type, stop, {passive: true});
  stopRestoring = stop;
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(apply);
  });
  return stop;
}

const userScrollEvents = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
