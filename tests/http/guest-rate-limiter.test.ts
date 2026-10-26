import {describe, expect, test} from "vitest";

import {GuestRateLimiter} from "../../src/http/guest-rate-limiter.js";

describe("guest rate limiter", () => {
  test("refuses a guest's 21st write in an hour and frees the window an hour later", () => {
    let now = Date.parse("2026-10-26T12:00:00.000Z");
    const limiter = new GuestRateLimiter(undefined, () => now);
    for (let index = 0; index < 20; index += 1) {
      expect(limiter.take("shl_1", "guest:a")).toEqual({allowed: true});
    }
    const refused = limiter.take("shl_1", "guest:a");
    expect(refused.allowed).toBe(false);
    expect(refused.allowed ? 0 : refused.retryAfterSeconds).toBeGreaterThan(0);
    // Another guest on the same link still has room.
    expect(limiter.take("shl_1", "guest:b")).toEqual({allowed: true});
    now += 3_600_000;
    expect(limiter.take("shl_1", "guest:a")).toEqual({allowed: true});
  });

  test("refuses a link's 61st write in an hour across its guests", () => {
    const now = Date.parse("2026-10-26T12:00:00.000Z");
    const limiter = new GuestRateLimiter(undefined, () => now);
    for (let index = 0; index < 60; index += 1) {
      expect(limiter.take("shl_1", `guest:${index % 5}-${Math.floor(index / 5)}`)).toEqual({allowed: true});
    }
    expect(limiter.take("shl_1", "guest:fresh").allowed).toBe(false);
    expect(limiter.take("shl_2", "guest:fresh")).toEqual({allowed: true});
  });

  test("a refused write does not consume a slot", () => {
    const now = Date.parse("2026-10-26T12:00:00.000Z");
    const limiter = new GuestRateLimiter({guestLimit: 1, linkLimit: 10, windowMilliseconds: 1_000}, () => now);
    expect(limiter.take("shl_1", "guest:a")).toEqual({allowed: true});
    expect(limiter.take("shl_1", "guest:a").allowed).toBe(false);
    expect(limiter.take("shl_1", "guest:b")).toEqual({allowed: true});
  });
});
