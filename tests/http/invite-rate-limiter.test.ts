// tests/http/invite-rate-limiter.test.ts
import {describe, expect, test} from "vitest";

import {InviteRateLimiter} from "../../src/http/invite-rate-limiter.js";

describe("invite rate limiter", () => {
  test("limits after the window fills and frees as failures age out", () => {
    let now = 0;
    const limiter = new InviteRateLimiter({limit: 3, windowMilliseconds: 60_000}, () => now);
    for (let index = 0; index < 3; index += 1) {
      expect(limiter.retryAfterSeconds()).toBeNull();
      limiter.noteFailure();
    }
    expect(limiter.retryAfterSeconds()).toBe(60);
    now = 30_000;
    expect(limiter.retryAfterSeconds()).toBe(30);
    now = 60_001;
    expect(limiter.retryAfterSeconds()).toBeNull();
  });
});
