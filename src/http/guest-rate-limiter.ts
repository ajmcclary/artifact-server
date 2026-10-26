/** Guest comment writes allowed per sliding window, per share link and per guest. */
export interface GuestRateLimitPolicy {
  readonly guestLimit: number;
  readonly linkLimit: number;
  readonly windowMilliseconds: number;
}

/** 60 writes an hour per link and 20 an hour per guest (ADR 0033). */
export const defaultGuestRateLimitPolicy: GuestRateLimitPolicy = {
  guestLimit: 20,
  linkLimit: 60,
  windowMilliseconds: 3_600_000,
};

/** The outcome of asking for one write slot. */
export type GuestRateDecision =
  | {readonly allowed: true}
  | {readonly allowed: false; readonly retryAfterSeconds: number};

/**
 * Process-local sliding windows over guest comment writes. A refused write
 * takes no slot. Several replicas each keep their own windows, so a fleet
 * admits up to its replica count times these limits.
 */
export class GuestRateLimiter {
  readonly #guests = new Map<string, number[]>();
  readonly #links = new Map<string, number[]>();
  readonly #now: () => number;
  readonly #policy: GuestRateLimitPolicy;

  constructor(
    policy: GuestRateLimitPolicy = defaultGuestRateLimitPolicy,
    now: () => number = () => Date.now(),
  ) {
    this.#policy = policy;
    this.#now = now;
  }

  /** Take one write slot for this guest on this link, or say how long to wait. */
  take(linkId: string, guestId: string): GuestRateDecision {
    const now = this.#now();
    const link = this.#window(this.#links, linkId, now);
    const guest = this.#window(this.#guests, guestId, now);
    const waits = [
      this.#waitFor(link, this.#policy.linkLimit, now),
      this.#waitFor(guest, this.#policy.guestLimit, now),
    ].filter((wait) => wait !== null);
    if (waits.length > 0) return {allowed: false, retryAfterSeconds: Math.max(...waits)};
    link.push(now);
    guest.push(now);
    return {allowed: true};
  }

  #window(windows: Map<string, number[]>, key: string, now: number): number[] {
    const kept = (windows.get(key) ?? []).filter((at) => at > now - this.#policy.windowMilliseconds);
    windows.set(key, kept);
    return kept;
  }

  #waitFor(window: readonly number[], limit: number, now: number): number | null {
    const oldest = window[0];
    if (window.length < limit || oldest === undefined) return null;
    return Math.max(1, Math.ceil((oldest + this.#policy.windowMilliseconds - now) / 1_000));
  }
}
