import {describe, expect, it} from "vitest";

import {joinCopy, readJoinLocation, safeReviewPath} from "@/review/join/join-model";

describe("join model", () => {
  it("reads the token from the fragment and never from the query", () => {
    expect(readJoinLocation({hash: "#as_inv_abc", search: ""})).toEqual({kind: "invite", token: "as_inv_abc"});
    expect(readJoinLocation({hash: "", search: "?token=as_inv_abc"})).toEqual({kind: "missing"});
  });

  it("reads refusal outcomes and the welcome destination", () => {
    expect(readJoinLocation({hash: "", search: "?outcome=wrong_account"}))
      .toEqual({kind: "outcome", outcome: "wrong_account"});
    expect(readJoinLocation({hash: "", search: "?outcome=nonsense"})).toEqual({kind: "missing"});
    expect(readJoinLocation({hash: "", search: "?next=%2Freview%2Fprojects"}))
      .toEqual({kind: "welcome", next: "/review/projects"});
  });

  it("only follows same-origin review paths", () => {
    expect(safeReviewPath("/review?artifact=a&project=p")).toBe("/review?artifact=a&project=p");
    expect(safeReviewPath("//evil.example/review")).toBeNull();
    expect(safeReviewPath("https://evil.example/review")).toBeNull();
    expect(safeReviewPath("/api/v1/session")).toBeNull();
    expect(safeReviewPath("/review\\@evil")).toBeNull();
  });

  it("gives every outcome a title and a next step", () => {
    for (const outcome of ["account_unavailable", "expired", "invalid", "revoked", "unverified", "used", "wrong_account"] as const) {
      const copy = joinCopy(outcome);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
    }
  });
});
