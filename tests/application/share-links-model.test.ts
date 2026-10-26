import {describe, expect, test} from "vitest";

import {toActivityEntry} from "../../src/application/activity-entries.js";
import {defaultAccessPolicy} from "../../src/core/access-policy.js";
import {
  GuestIdentityRequired,
  GuestRateLimited,
  GuestSessionRequired,
  ShareLinkInvalid,
  ShareLinkNotFound,
  ShareLinksDisabled,
} from "../../src/core/errors.js";
import {principalKinds} from "../../src/core/identity.js";
import type {ActionKind} from "../../src/core/model.js";
import {
  guestSessionExpiry,
  isShareLinkActive,
  normalizeGuestDisplayName,
  normalizeShareLinkLabel,
  validateShareLinkPermissions,
  type ShareLink,
} from "../../src/core/share-links.js";
import {SystemIdGenerator} from "../../src/core/system.js";
import {stripInvisibleControls} from "../../src/core/untrusted-text.js";
import {artifactServerFailureResponse} from "../../src/http/artifact-http-failure.js";
import {sanitizeBundleText} from "../../src/mcp/dispatch-bundle-message.js";

const now = "2026-10-26T12:00:00.000Z";

const link = (overrides: Partial<ShareLink> = {}): ShareLink => ({
  artifactId: "art_1",
  createdAt: now,
  createdByName: "Jordan Lee",
  createdByPrincipalId: "mem_admin",
  expiresAt: null,
  generation: 0,
  guestCount: 0,
  id: "shl_1",
  label: "Client review",
  permissions: ["artifact.view", "comment.read", "comment.write"],
  projectId: "prj_1",
  revision: 1,
  revokedAt: null,
  target: {kind: "latest"},
  token: "shr_token",
  ...overrides,
});

const refused = (permissions: Parameters<typeof validateShareLinkPermissions>[0]) =>
  validateShareLinkPermissions(permissions, defaultAccessPolicy) instanceof ShareLinkInvalid;

describe("share link model", () => {
  test("link permissions must include view, stay guest-holdable and within the policy", () => {
    expect(refused([])).toBe(true);
    expect(refused(["comment.read"])).toBe(true);
    expect(refused(["artifact.view", "comment.write"])).toBe(true);
    expect(refused(["artifact.view", "artifact.publish"])).toBe(true);
    expect(validateShareLinkPermissions(["comment.write", "artifact.view", "comment.read"], defaultAccessPolicy))
      .toEqual(["artifact.view", "comment.read", "comment.write"]);
    const narrowed = {
      ...defaultAccessPolicy,
      shareLinks: {...defaultAccessPolicy.shareLinks, guestPermissionsMax: ["artifact.view" as const]},
    };
    expect(validateShareLinkPermissions(["artifact.view", "comment.read"], narrowed)).toBeInstanceOf(ShareLinkInvalid);
  });

  test("guest display names are stripped of invisible controls and bounded", () => {
    expect(normalizeGuestDisplayName("\u202Ealice\u200B ")).toBe("alice");
    expect(normalizeGuestDisplayName("  ")).toBeInstanceOf(GuestIdentityRequired);
    expect(normalizeGuestDisplayName("x".repeat(61))).toBeInstanceOf(GuestIdentityRequired);
    expect(normalizeGuestDisplayName("x".repeat(60))).toBe("x".repeat(60));
  });

  test("labels are stripped and bounded", () => {
    expect(normalizeShareLinkLabel(" Client\u2066 review ")).toBe("Client review");
    expect(normalizeShareLinkLabel("")).toBeInstanceOf(ShareLinkInvalid);
    expect(normalizeShareLinkLabel("x".repeat(81))).toBeInstanceOf(ShareLinkInvalid);
  });

  test("a link is active until revoked or expired", () => {
    expect(isShareLinkActive(link(), now)).toBe(true);
    expect(isShareLinkActive(link({revokedAt: now}), now)).toBe(false);
    expect(isShareLinkActive(link({expiresAt: now}), now)).toBe(false);
    expect(isShareLinkActive(link({expiresAt: "2026-10-27T00:00:00.000Z"}), now)).toBe(true);
  });

  test("a guest session ends with its link or after thirty days", () => {
    expect(guestSessionExpiry(link({expiresAt: "2026-10-28T12:00:00.000Z"}), now)).toBe("2026-10-28T12:00:00.000Z");
    expect(guestSessionExpiry(link(), now)).toBe("2026-11-25T12:00:00.000Z");
  });

  test("stripInvisibleControls matches the bundle sanitizer it replaces", () => {
    for (const sample of ["plain", "\u202Eevil\u202C", "a\u200Bb\u2060c\uFEFF", "\u2066x\u2069"]) {
      expect(stripInvisibleControls(sample)).toBe(sanitizeBundleText(sample));
    }
    expect(stripInvisibleControls("a\u200Bb")).toBe("ab");
  });

  test("share-link identifiers and tokens have their documented shapes", () => {
    const ids = new SystemIdGenerator();
    expect(ids.shareLinkId()).toMatch(/^shl_[0-9a-f]{24}$/u);
    expect(ids.shareLinkToken()).toMatch(/^shr_[0-9a-f]{48}$/u);
    expect(ids.guestId()).toMatch(/^guest:gst_[0-9a-f]{24}$/u);
    expect(ids.guestSessionId()).toMatch(/^gss_[0-9a-f]{24}$/u);
    expect(principalKinds.guest).toBe("guest");
  });
});

describe("share link errors and activity", () => {
  test("share-link errors map to stable HTTP failures", () => {
    expect(artifactServerFailureResponse(new ShareLinkNotFound({message: "Gone."})))
      .toEqual({code: "SHARE_LINK_NOT_FOUND", message: "Gone.", status: 404});
    expect(artifactServerFailureResponse(new ShareLinkInvalid({message: "Bad."})))
      .toEqual({code: "SHARE_LINK_INVALID", message: "Bad.", status: 422});
    expect(artifactServerFailureResponse(new ShareLinksDisabled({message: "Off."})))
      .toEqual({code: "SHARE_LINKS_DISABLED", message: "Off.", status: 403});
    expect(artifactServerFailureResponse(new GuestSessionRequired({message: "Who?"})))
      .toEqual({code: "GUEST_SESSION_REQUIRED", message: "Who?", status: 401});
    expect(artifactServerFailureResponse(new GuestIdentityRequired({message: "Name?"})))
      .toEqual({code: "GUEST_IDENTITY_REQUIRED", message: "Name?", status: 422});
    expect(artifactServerFailureResponse(new GuestRateLimited({message: "Slow.", retryAfterSeconds: 12})))
      .toEqual({code: "GUEST_RATE_LIMITED", details: {retryAfterSeconds: 12}, message: "Slow.", status: 429});
  });

  test("share-link activity appears in the access feed", () => {
    const row = (action: ActionKind) => ({
      action: {
        accessFrom: null,
        accessTo: null,
        action,
        actor: {displayName: "Jordan Lee", kind: "human" as const},
        artifactId: "art_1",
        createdAt: now,
        detail: null,
        id: "act_1",
        principalId: "mem_admin",
        projectId: "prj_1",
        replyId: null,
        subjectId: "shl_1",
        threadId: null,
        versionId: null,
      },
      artifact: null,
      dispatch: null,
      excerpt: null,
      project: null,
      thread: null,
      versionNumber: null,
    });
    const names = {keys: new Map(), members: new Map()};
    expect(toActivityEntry(row("share_link_create"), names)).toMatchObject({kind: "access", verb: "created a share link"});
    expect(toActivityEntry(row("share_link_update"), names)).toMatchObject({verb: "changed a share link"});
    expect(toActivityEntry(row("share_link_rotate"), names)).toMatchObject({verb: "replaced a share link"});
    expect(toActivityEntry(row("share_link_revoke"), names)).toMatchObject({verb: "ended a share link"});
    expect(toActivityEntry(row("guest_join"), names)).toMatchObject({verb: "joined as a guest"});
  });
});
