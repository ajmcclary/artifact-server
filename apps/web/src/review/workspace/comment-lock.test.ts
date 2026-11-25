import {describe, expect, it} from "vitest";

import type {EffectiveAccess} from "@/api/client";
import {commentLockReason} from "@/review/workspace/comment-lock";
import {rolePermissions} from "@/review/settings/project-access-model";

const access = (role: "commenter" | "editor" | "viewer", extra: EffectiveAccess["sources"] = []) => ({
  permissions: new Set(rolePermissions(role)),
  sources: [{layer: "project_default" as const, role}, ...extra],
});

describe("comment lock reason", () => {
  it("names the role that decided a read-only reviewer's access", () => {
    expect(commentLockReason(access("viewer"), "Claims", false))
      .toBe("You have Viewer access to Claims: you can read these conversations but not write in them.");
  });

  it("names the archived project before any role, even for an editor", () => {
    expect(commentLockReason(access("editor"), "Claims", true)).toBe("Claims is archived, so its conversations are read-only.");
    expect(commentLockReason(access("viewer", [{layer: "state", reason: "archived", removed: ["comment.write"]}]), "Claims", false))
      .toBe("Claims is archived, so its conversations are read-only.");
  });

  it("names the last grant that decided, and says nothing when writing is allowed", () => {
    const granted = access("editor", [{added: [], grantId: "g", layer: "project_grant", removed: [], role: "viewer"}]);
    expect(commentLockReason({...granted, permissions: new Set(rolePermissions("viewer"))}, "Claims", false))
      .toBe("You have Viewer access to Claims: you can read these conversations but not write in them.");
    expect(commentLockReason(access("commenter"), "Claims", false)).toBeNull();
  });

  it("falls back to a plain sentence when no role decided", () => {
    expect(commentLockReason({permissions: new Set(["artifact.view", "comment.read"] as const), sources: [{layer: "share_link", shareLinkId: "s"}]}, "Claims", false))
      .toBe("Your access lets you read these conversations but not write in them.");
  });
});
