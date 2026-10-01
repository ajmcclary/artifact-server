/** The coarsest interval at which last-active and last-used facts advance. */
export const principalActivityResolutionMilliseconds = 5 * 60 * 1_000;

/**
 * The newest stored instant that a write at `at` may replace. A stored value
 * at or after it is recent enough, and a later clock never moves it backwards.
 */
export function principalActivityThreshold(at: string): string {
  return new Date(Date.parse(at) - principalActivityResolutionMilliseconds)
    .toISOString();
}
