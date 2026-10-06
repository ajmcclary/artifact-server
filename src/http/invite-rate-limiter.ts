/** Failed invite lookups allowed per window before further invalid lookups are refused. */
export interface InviteRateLimitPolicy {
  readonly limit: number;
  readonly windowMilliseconds: number;
}

export const defaultInviteRateLimitPolicy: InviteRateLimitPolicy = {
  limit: 30,
  windowMilliseconds: 60_000,
};

/**
 * One process-wide sliding window over failed invite lookups. The token's
 * 256-bit secret makes guessing impractical; this bounds load and log noise.
 */
export class InviteRateLimiter {
  readonly #failures: number[] = [];
  readonly #now: () => number;
  readonly #policy: InviteRateLimitPolicy;

  constructor(
    policy: InviteRateLimitPolicy = defaultInviteRateLimitPolicy,
    now: () => number = () => Date.now(),
  ) {
    this.#policy = policy;
    this.#now = now;
  }

  /** Seconds until a slot frees, or null when requests may proceed. */
  retryAfterSeconds(): number | null {
    const now = this.#now();
    this.#prune(now);
    const oldest = this.#failures[0];
    if (this.#failures.length < this.#policy.limit || oldest === undefined) return null;
    return Math.max(1, Math.ceil((oldest + this.#policy.windowMilliseconds - now) / 1_000));
  }

  noteFailure(): void {
    const now = this.#now();
    this.#prune(now);
    this.#failures.push(now);
    if (this.#failures.length > this.#policy.limit) this.#failures.shift();
  }

  #prune(now: number): void {
    while (this.#failures[0] !== undefined && this.#failures[0] <= now - this.#policy.windowMilliseconds) {
      this.#failures.shift();
    }
  }
}
