import {Result, Schema} from "effect";
import {describe, expect, test} from "vitest";

import {
  accessPolicyParseOptions,
  accessPolicySchema,
  defaultAccessPolicy,
  type AccessPolicy,
} from "../../src/core/access-policy.js";
import {
  allPermissions,
  computeVisibleScope,
  guestHoldablePermissions,
  resolveEffectiveAccess,
  rolePermissions,
  writePermissions,
  type AccessGrant,
  type AccessResolutionInput,
  type ProjectAccess,
} from "../../src/core/permissions.js";

const now = "2026-10-26T12:00:00.000Z";

const project = (overrides: Partial<ProjectAccess> = {}): ProjectAccess => ({
  accessMode: "open",
  archived: false,
  defaultMemberRole: "editor",
  projectId: "prj_a",
  revision: 0,
  ...overrides,
});

const grant = (overrides: Partial<AccessGrant> = {}): AccessGrant => ({
  add: [],
  artifactId: null,
  createdAt: now,
  createdByPrincipalId: "mem_admin",
  expiresAt: null,
  id: "grt_1",
  memberId: "mem_dana",
  projectId: "prj_a",
  remove: [],
  revision: 1,
  role: "viewer",
  updatedAt: now,
  ...overrides,
});

const base: AccessResolutionInput = {
  artifactDeleted: false,
  artifactGrants: [],
  now,
  policy: defaultAccessPolicy,
  project: project(),
  projectGrant: null,
  subject: {kind: "member", memberId: "mem_dana"},
};

const decodeJson = (text: string) =>
  Schema.decodeUnknownResult(accessPolicySchema)(JSON.parse(text), accessPolicyParseOptions);

const sorted = (permissions: ReadonlySet<string>) => [...permissions].toSorted();

describe("permission model", () => {
  test("role ladder matches today's member at editor", () => {
    expect(sorted(rolePermissions("editor"))).toEqual([
      "agent.dispatch", "artifact.delete", "artifact.edit", "artifact.history",
      "artifact.publish", "artifact.share", "artifact.view", "comment.read", "comment.write",
    ]);
    expect(rolePermissions("manager").has("project.manage")).toBe(true);
    expect(rolePermissions("manager").has("comment.moderate")).toBe(true);
    expect(rolePermissions("editor").has("comment.moderate")).toBe(false);
    expect(sorted(rolePermissions("viewer"))).toEqual(["artifact.history", "artifact.view", "comment.read"]);
    expect(sorted(rolePermissions("commenter"))).toEqual(
      ["artifact.history", "artifact.view", "comment.read", "comment.write"],
    );
    expect(rolePermissions("none").size).toBe(0);
    expect(rolePermissions("manager").size).toBe(allPermissions.length);
  });

  test("guest-holdable and write permission sets", () => {
    expect(sorted(guestHoldablePermissions)).toEqual(["artifact.view", "comment.read", "comment.write"]);
    expect(writePermissions.has("artifact.view")).toBe(false);
    expect(writePermissions.has("artifact.history")).toBe(false);
    expect(writePermissions.has("comment.read")).toBe(false);
    expect(writePermissions.size).toBe(allPermissions.length - 3);
  });

  test("an open project gives its default role and names it as the source", () => {
    const access = resolveEffectiveAccess(base);
    expect(sorted(access.permissions)).toEqual(sorted(rolePermissions("editor")));
    expect(access.sources).toEqual([{layer: "project_default", role: "editor"}]);
  });

  test("project grant replaces the open-project default", () => {
    const access = resolveEffectiveAccess({...base, projectGrant: grant({role: "viewer"})});
    expect(access.permissions.has("artifact.publish")).toBe(false);
    expect(access.permissions.has("artifact.view")).toBe(true);
    expect(access.sources[0]).toMatchObject({layer: "project_grant", role: "viewer"});
  });

  test("a none grant blocks a member on an open project", () => {
    const access = resolveEffectiveAccess({...base, projectGrant: grant({role: "none"})});
    expect(access.permissions.size).toBe(0);
  });

  test("a restricted project without a grant gives nothing", () => {
    const access = resolveEffectiveAccess({...base, project: project({accessMode: "restricted"})});
    expect(access.permissions.size).toBe(0);
    expect(access.sources).toEqual([]);
  });

  test("artifact grant adds on a restricted project", () => {
    const access = resolveEffectiveAccess({
      ...base,
      artifactGrants: [grant({artifactId: "art_1", id: "grt_art", role: "commenter"})],
      project: project({accessMode: "restricted"}),
    });
    expect(access.permissions.has("comment.write")).toBe(true);
    expect(access.permissions.has("artifact.publish")).toBe(false);
    expect(access.sources).toEqual([
      {added: [], grantId: "grt_art", layer: "artifact_grant", removed: [], role: "commenter"},
    ]);
  });

  test("an override applies only to its own grant", () => {
    const projectGrant = grant({remove: ["artifact.delete"], role: "editor"});
    const withoutArtifactGrant = resolveEffectiveAccess({...base, projectGrant});
    expect(withoutArtifactGrant.permissions.has("artifact.delete")).toBe(false);
    expect(withoutArtifactGrant.permissions.has("artifact.publish")).toBe(true);
    const withArtifactGrant = resolveEffectiveAccess({
      ...base,
      artifactGrants: [grant({add: ["artifact.delete"], artifactId: "art_1", id: "grt_art", role: "viewer"})],
      projectGrant,
    });
    expect(withArtifactGrant.permissions.has("artifact.delete")).toBe(true);
  });

  test("no grant beats the member ceiling", () => {
    const policy: AccessPolicy = {
      ...defaultAccessPolicy,
      members: {memberCeiling: allPermissions.filter((permission) => permission !== "artifact.delete")},
    };
    const access = resolveEffectiveAccess({...base, policy, projectGrant: grant({role: "manager"})});
    expect(access.permissions.has("artifact.delete")).toBe(false);
    expect(access.permissions.has("project.manage")).toBe(true);
    expect(access.sources).toContainEqual({layer: "policy", removed: ["artifact.delete"]});
  });

  test("no grant beats the archived state", () => {
    const access = resolveEffectiveAccess({
      ...base,
      project: project({archived: true}),
      projectGrant: grant({role: "manager"}),
    });
    expect(sorted(access.permissions)).toEqual(["artifact.history", "artifact.view", "comment.read"]);
    expect(access.sources).toContainEqual({
      layer: "state",
      reason: "archived",
      removed: [...writePermissions].toSorted(),
    });
  });

  test("a deleted artifact removes everything", () => {
    const access = resolveEffectiveAccess({...base, artifactDeleted: true});
    expect(access.permissions.size).toBe(0);
    expect(access.sources).toContainEqual(expect.objectContaining({layer: "state", reason: "deleted"}));
  });

  test("administrators resolve to manager and ignore grants", () => {
    const access = resolveEffectiveAccess({
      ...base,
      project: project({accessMode: "restricted"}),
      projectGrant: grant({role: "none"}),
      subject: {kind: "administrator"},
    });
    expect(access.permissions.size).toBe(allPermissions.length);
    expect(access.sources).toEqual([{layer: "administrator"}]);
  });

  test("administrators are not subject to the member ceiling", () => {
    const policy: AccessPolicy = {...defaultAccessPolicy, members: {memberCeiling: ["artifact.view"]}};
    const access = resolveEffectiveAccess({...base, policy, subject: {kind: "administrator"}});
    expect(access.permissions.size).toBe(allPermissions.length);
  });

  test("expired grants are ignored and reported", () => {
    const access = resolveEffectiveAccess({
      ...base,
      projectGrant: grant({expiresAt: "2026-10-25T00:00:00.000Z", role: "viewer"}),
    });
    expect(sorted(access.permissions)).toEqual(sorted(rolePermissions("editor")));
    expect(access.sources).toContainEqual({layer: "state", reason: "expired_grant", removed: []});
  });

  test("guests get link permissions within the policy maximum", () => {
    const subject = {kind: "guest", linkPermissions: ["artifact.view", "comment.read", "comment.write"]} as const;
    const access = resolveEffectiveAccess({...base, shareLinkId: "shl_1", subject});
    expect(sorted(access.permissions)).toEqual(["artifact.view", "comment.read", "comment.write"]);
    expect(access.sources[0]).toEqual({layer: "share_link", shareLinkId: "shl_1"});

    const narrowed: AccessPolicy = {
      ...defaultAccessPolicy,
      shareLinks: {...defaultAccessPolicy.shareLinks, guestPermissionsMax: ["artifact.view"]},
    };
    expect(sorted(resolveEffectiveAccess({...base, policy: narrowed, subject}).permissions)).toEqual(["artifact.view"]);

    const disabled: AccessPolicy = {
      ...defaultAccessPolicy,
      shareLinks: {...defaultAccessPolicy.shareLinks, enabled: false},
    };
    expect(resolveEffectiveAccess({...base, policy: disabled, subject}).permissions.size).toBe(0);
  });

  test("guests never hold permissions outside the guest-holdable set", () => {
    const subject = {kind: "guest", linkPermissions: ["artifact.view", "artifact.publish"]} as const;
    const policy: AccessPolicy = {
      ...defaultAccessPolicy,
      shareLinks: {...defaultAccessPolicy.shareLinks, guestPermissionsMax: allPermissions},
    };
    expect(sorted(resolveEffectiveAccess({...base, policy, subject}).permissions)).toEqual(["artifact.view"]);
  });
});

describe("visible scope", () => {
  const projects = [
    project({projectId: "A"}),
    project({accessMode: "restricted", projectId: "B"}),
    project({accessMode: "restricted", projectId: "C"}),
    project({projectId: "D"}),
  ];

  test("computeVisibleScope", () => {
    const scope = computeVisibleScope({
      grants: [
        grant({artifactId: "art_1", id: "g1", projectId: "C", role: "viewer"}),
        grant({id: "g2", projectId: "D", role: "none"}),
      ],
      now,
      policy: defaultAccessPolicy,
      projects,
      subject: {kind: "member", memberId: "mem_dana"},
    });
    expect(scope).toEqual({
      artifactIdsByProject: new Map([["C", ["art_1"]]]),
      kind: "limited",
      projectIds: ["A"],
    });
  });

  test("administrators see everything", () => {
    expect(computeVisibleScope({
      grants: [],
      now,
      policy: defaultAccessPolicy,
      projects,
      subject: {kind: "administrator"},
    })).toEqual({kind: "all"});
  });

  test("a restricted project grant makes the whole project visible", () => {
    const scope = computeVisibleScope({
      grants: [grant({id: "g1", projectId: "B", role: "viewer"})],
      now,
      policy: defaultAccessPolicy,
      projects,
      subject: {kind: "member", memberId: "mem_dana"},
    });
    expect(scope).toMatchObject({kind: "limited", projectIds: ["A", "B", "D"]});
  });

  test("a member ceiling without view hides every project", () => {
    const policy: AccessPolicy = {...defaultAccessPolicy, members: {memberCeiling: ["comment.read"]}};
    expect(computeVisibleScope({
      grants: [],
      now,
      policy,
      projects,
      subject: {kind: "member", memberId: "mem_dana"},
    })).toEqual({artifactIdsByProject: new Map(), kind: "limited", projectIds: []});
  });
});

describe("access policy schema", () => {
  const defaultJson = JSON.stringify(defaultAccessPolicy);

  test("the default policy round-trips", () => {
    expect(Result.isSuccess(decodeJson(defaultJson))).toBe(true);
  });

  test("accessPolicySchema rejects unknown permissions and keys", () => {
    expect(Result.isFailure(decodeJson(defaultJson.replace("artifact.view", "artifact.fly")))).toBe(true);
    expect(Result.isFailure(decodeJson(defaultJson.replace('{"members"', '{"extra":true,"members"')))).toBe(true);
    expect(Result.isFailure(decodeJson(defaultJson.replace('"maxExpiryDays":null', '"maxExpiryDays":0')))).toBe(true);
  });
});
