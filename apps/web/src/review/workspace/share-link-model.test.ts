import {describe, expect, it} from "vitest";

import {
  expiryChoices,
  linkSummary,
  presetOf,
  presetPermissions,
} from "@/review/workspace/share-link-model";

const now = "2026-10-26T12:00:00.000Z";

describe("share link model", () => {
  it("maps presets to permissions and back, keeping view in every custom set", () => {
    expect(presetPermissions("view", [])).toEqual(["artifact.view"]);
    expect(presetPermissions("comment", [])).toEqual(["artifact.view", "comment.read", "comment.write"]);
    expect(presetPermissions("custom", ["comment.read"])).toEqual(["artifact.view", "comment.read"]);
    expect(presetPermissions("custom", ["comment.write", "artifact.view", "comment.write"]))
      .toEqual(["artifact.view", "comment.write"]);
    expect(presetOf(["artifact.view"])).toBe("view");
    expect(presetOf(["comment.write", "artifact.view", "comment.read"])).toBe("comment");
    expect(presetOf(["artifact.view", "comment.read"])).toBe("custom");
  });

  it("summarizes a pinned, expiring link with guests", () => {
    expect(linkSummary({
      expiresAt: "2026-11-01T12:00:00.000Z",
      guestCount: 3,
      permissions: ["artifact.view", "comment.read", "comment.write"],
      revokedAt: null,
      target: {kind: "pinned", versionId: "ver_2"},
    }, now, 2)).toBe("View and comment · This version (v2) · Expires in 6 days · 3 guests");
  });

  it("summarizes latest and never-expiring links, and an ended one", () => {
    const latest = {
      expiresAt: null,
      guestCount: 0,
      permissions: ["artifact.view"],
      revokedAt: null,
      target: {kind: "latest"},
    } as const;
    expect(linkSummary(latest, now, null)).toBe("View only · Latest · Never expires · No guests yet");
    expect(linkSummary({...latest, expiresAt: "2026-10-26T18:00:00.000Z", guestCount: 1}, now, null))
      .toBe("View only · Latest · Expires in under a day · 1 guest");
    expect(linkSummary({...latest, expiresAt: "2026-10-26T11:00:00.000Z"}, now, null))
      .toBe("View only · Latest · Expired · No guests yet");
    expect(linkSummary({...latest, permissions: ["artifact.view", "comment.read"], revokedAt: now}, now, null))
      .toBe("Custom · Latest · Revoked · No guests yet");
    expect(linkSummary({...latest, target: {kind: "pinned", versionId: "ver_9"}}, now, null))
      .toBe("View only · This version · Never expires · No guests yet");
  });

  it("offers only expiries the policy allows", () => {
    expect(expiryChoices(null).map((choice) => choice.days)).toEqual([null, 1, 7, 30]);
    expect(expiryChoices(7).map((choice) => choice.days)).toEqual([1, 7]);
    expect(expiryChoices(14).map((choice) => choice.days)).toEqual([1, 7, 14]);
  });
});
