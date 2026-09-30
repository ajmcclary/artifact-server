/** One temporary layer in an Escape chain. */
export interface DismissLayer {
  /** Whether the layer is showing now; closed layers are skipped. */
  open: boolean;
  /** Closes the layer (the host's own state setter or guarded close). */
  close: () => void;
}

/**
 * The Escape-chain helper: close the first open layer in `layers`, which are ordered innermost
 * first, and return true; return false when none is open so the key can pass through. Falsy
 * entries are skipped, so `cond && { open, close }` may be written inline.
 */
export function dismissInnermost(layers: ReadonlyArray<DismissLayer | null | undefined | false>): boolean;
