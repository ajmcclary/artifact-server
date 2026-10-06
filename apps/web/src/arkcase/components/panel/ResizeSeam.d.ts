export interface ResizeSeamState {
  /** The live width while a press is down, else null: the caller draws its own width then. */
  width: number | null;
  dragging: boolean;
  arming: boolean;
  /** 0..1 while the hold runs, 0 otherwise. */
  armPct: number;
}

export interface ResizeSeamOptions {
  /** Minimum permitted width in pixels. */
  minWidth?: number;
  /** Maximum permitted width in pixels. */
  maxWidth?: number;
  /** Which edge the seam sits on; 'end' flips the drag direction and the key table. */
  side?: 'start' | 'end';
  /** One arrow press, px. */
  step?: number;
  /** As it reads in a sentence: 'case list', 'navigation'; capitalised for the announcement. */
  name?: string;
  /** The measured axis: 'x' is a width fed clientX; 'y' is a height fed clientY, with `side` naming the docked edge ('end' = bottom) and only the vertical arrows in the key table. @default "x" */
  axis?: 'x' | 'y';
  /** Duration of the resize hold before collapse. */
  holdMs?: number;
  /** The clamped width on a commit; null on a reset. */
  onWidthChange?: (width: number | null) => void;
  /** 'Case list width set to 400 pixels.' / 'Case list width reset to the default.' */
  onAnnounce?: (text: string) => void;
  /** Fires once when a drag has held at minWidth for holdMs; omitted, nothing arms. */
  onOvershoot?: () => void;
  /** Every change of the state. */
  onState?: (state: ResizeSeamState) => void;
  /** Injectable clock and frame, for tests. */
  now?: () => number;
  /** Animation-frame scheduler injected by the host. */
  raf?: (tick: () => void) => unknown;
  /** Cancellation function paired with the injected scheduler. */
  caf?: (handle: unknown) => void;
}

export interface ResizeSeamApi {
  /** A press at clientX over a seam whose column is startWidth px; arms at once if already at the minimum. */
  begin(x: number, startWidth: number): void;
  /** The pointer at clientX: the clamped live width; arms on reaching the minimum, disarms on leaving it. */
  move(x: number): void;
  /** The release: commit a changed width, else nothing. */
  end(): void;
  /** Drop the drag and any hold without a commit. */
  cancel(): void;
  /** The key table over `current`; true when handled. */
  key(key: string, current: number): boolean;
  /** onWidthChange(null) and the reset announcement. */
  reset(): void;
  state(): ResizeSeamState;
}

/**
 * A factory, not a component: the seam arithmetic Panel, SideNav and a product's own seam
 * scanner share — clamp, direction, hold-to-collapse, commit on change, reset, keys, announcements.
 * No DOM, no store, no window.
 */
export function ResizeSeam(options?: ResizeSeamOptions): ResizeSeamApi;
