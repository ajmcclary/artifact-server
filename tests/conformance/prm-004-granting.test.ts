import {randomUUID} from "node:crypto";

import {Cause, type Effect, Exit, Option} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {AccessAdministrationService} from "../../src/application/access-administration.js";
import {ArtifactCommentService} from "../../src/application/artifact-comments.js";
import {defaultAccessPolicy} from "../../src/core/access-policy.js";
import type {Principal} from "../../src/core/identity.js";
import type {Permission, ProjectRole} from "../../src/core/permissions.js";
import {startAccessRuntime} from "../support/access-runtime.js";

type AccessRuntime = Awaited<ReturnType<typeof startAccessRuntime>>;

async function failureTag<A, E extends {readonly _tag: string}>(
  harness: AccessRuntime,
  effect: Effect.Effect<A, E, AccessAdministrationService | ArtifactCommentService>,
): Promise<string | null> {
  const exit = await harness.runtime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return null;
  return Option.getOrNull(Cause.findErrorOption(exit.cause).pipe(Option.map((error) => error._tag)));
}

const putGrant = (
  principal: Principal,
  projectId: string,
  memberId: string,
  role: ProjectRole,
  overrides: {
    readonly add?: readonly Permission[];
    readonly artifactId?: string | null;
    readonly expectedRevision?: number | null;
    readonly expiresAt?: string | null;
    readonly remove?: readonly Permission[];
  } = {},
) =>
  AccessAdministrationService.use((service) => service.putGrant({
    add: overrides.add ?? [],
    artifactId: overrides.artifactId ?? null,
    expectedRevision: overrides.expectedRevision ?? null,
    expiresAt: overrides.expiresAt ?? null,
    memberId,
    principal,
    projectId,
    remove: overrides.remove ?? [],
    role,
  }));

describe("granting access", () => {
  let harness: AccessRuntime;

  beforeEach(async () => {
    harness = await startAccessRuntime();
  });

  afterEach(async () => {
    await harness.stop();
  });

  test("PRM-004-B: a manager grants commenter to a member and the member can comment", async () => {
    const projectId = await harness.createProject("Design");
    const published = await harness.publish(harness.administrator, projectId);
    await harness.setProjectAccess(projectId, "restricted");
    const dana = await harness.person("Dana");
    const sam = await harness.person("Sam");
    await harness.grant({memberId: dana.id, projectId, role: "manager"});

    const granted = await harness.runtime.runPromise(putGrant(dana, projectId, sam.id, "commenter"));
    expect(granted).toMatchObject({memberId: sam.id, revision: 1, role: "commenter"});
    expect(await failureTag(harness, ArtifactCommentService.use((comments) => comments.createThread({
      anchor: null,
      artifactId: published.artifact.id,
      body: "Thanks.",
      idempotencyKey: `comment-${randomUUID()}`,
      path: null,
      principal: sam,
      projectId,
      versionId: published.version.id,
    })))).toBeNull();
  });

  test("PRM-004-F: an editor cannot grant manager or add comment moderation", async () => {
    const projectId = await harness.createProject("Design");
    const dana = await harness.person("Dana");
    const sam = await harness.person("Sam");
    await harness.grant({memberId: dana.id, projectId, role: "manager", remove: ["project.manage"]});
    // Dana can no longer manage the project, so she cannot grant there at all.
    expect(await failureTag(harness, putGrant(dana, projectId, sam.id, "viewer"))).toBe("AuthorizationDenied");

    const shareProject = await harness.createProject("Share");
    const published = await harness.publish(harness.administrator, shareProject);
    // An editor holds artifact.share and may grant on one artifact, but only what she holds.
    expect(await failureTag(harness, putGrant(sam, shareProject, dana.id, "manager", {artifactId: published.artifact.id})))
      .toBe("PermissionNotHeld");
    expect(await failureTag(harness, putGrant(sam, shareProject, dana.id, "viewer", {
      add: ["comment.moderate"],
      artifactId: published.artifact.id,
    }))).toBe("PermissionNotHeld");
    expect(await failureTag(harness, putGrant(sam, shareProject, dana.id, "commenter", {artifactId: published.artifact.id})))
      .toBeNull();
  });

  test("invalid overrides, artifact none, removing view and past expiry are refused", async () => {
    const projectId = await harness.createProject("Design");
    const published = await harness.publish(harness.administrator, projectId);
    const sam = await harness.person("Sam");
    const admin = harness.administrator;
    expect(await failureTag(harness, putGrant(admin, projectId, sam.id, "viewer", {
      add: ["comment.write"],
      remove: ["comment.write"],
    }))).toBe("AccessGrantInvalid");
    expect(await failureTag(harness, putGrant(admin, projectId, sam.id, "none", {artifactId: published.artifact.id})))
      .toBe("AccessGrantInvalid");
    expect(await failureTag(harness, putGrant(admin, projectId, sam.id, "viewer", {
      artifactId: published.artifact.id,
      remove: ["artifact.view"],
    }))).toBe("AccessGrantInvalid");
    expect(await failureTag(harness, putGrant(admin, projectId, sam.id, "viewer", {expiresAt: "2026-10-25T00:00:00.000Z"})))
      .toBe("AccessGrantInvalid");
    expect(await failureTag(harness, putGrant(admin, projectId, "mem_nobody", "viewer"))).toBe("AccessGrantInvalid");
    expect(await failureTag(harness, putGrant(admin, projectId, sam.id, "viewer", {artifactId: "art_missing"})))
      .toBe("ArtifactNotFound");
  });

  test("no-op overrides are dropped and a stale revision conflicts", async () => {
    const projectId = await harness.createProject("Design");
    const sam = await harness.person("Sam");
    const created = await harness.runtime.runPromise(putGrant(harness.administrator, projectId, sam.id, "viewer", {
      add: ["artifact.view", "comment.write", "comment.write"],
      remove: ["artifact.publish"],
    }));
    expect(created).toMatchObject({add: ["comment.write"], remove: []});
    expect(await failureTag(harness, putGrant(harness.administrator, projectId, sam.id, "editor")))
      .toBe("AccessRevisionConflict");
    expect(await failureTag(harness, putGrant(harness.administrator, projectId, sam.id, "editor", {expectedRevision: 1})))
      .toBeNull();
    expect(await failureTag(harness, AccessAdministrationService.use((service) => service.deleteGrant({
      artifactId: null,
      expectedRevision: 1,
      memberId: sam.id,
      principal: harness.administrator,
      projectId,
    })))).toBe("AccessRevisionConflict");
    expect(await failureTag(harness, AccessAdministrationService.use((service) => service.deleteGrant({
      artifactId: null,
      expectedRevision: 2,
      memberId: sam.id,
      principal: harness.administrator,
      projectId,
    })))).toBeNull();
  });

  test("PRM-005-F: granting to an administrator is refused", async () => {
    const projectId = await harness.createProject("Design");
    const other = await harness.person("Avery", "administrator");
    expect(await failureTag(harness, putGrant(harness.administrator, projectId, other.id, "viewer")))
      .toBe("AccessGrantInvalid");
  });

  test("restricting a project needs the count of members who lose access", async () => {
    const projectId = await harness.createProject("Design");
    await harness.person("Dana");
    const sam = await harness.person("Sam");
    await harness.grant({memberId: sam.id, projectId, role: "viewer"});
    const change = (confirm: number | null) => AccessAdministrationService.use((service) => service.changeProjectAccess({
      accessMode: "restricted",
      confirmMembersLosingAccess: confirm,
      defaultMemberRole: "editor",
      expectedRevision: 0,
      principal: harness.administrator,
      projectId,
    }));
    const unconfirmed = await harness.runtime.runPromiseExit(change(null));
    expect(Exit.isFailure(unconfirmed)).toBe(true);
    const failure = Exit.isFailure(unconfirmed) ? Option.getOrNull(Cause.findErrorOption(unconfirmed.cause)) : null;
    // Only Dana loses access: Sam keeps his grant and administrators always keep theirs.
    expect(failure).toMatchObject({_tag: "AccessChangeUnconfirmed", membersLosingAccess: 1});
    expect(await failureTag(harness, change(2))).toBe("AccessChangeUnconfirmed");
    const changed = await harness.runtime.runPromise(change(1));
    expect(changed).toMatchObject({accessMode: "restricted", revision: 1});
  });

  test("a policy write that narrows guests reports what it narrows and needs the current revision", async () => {
    const written = await harness.runtime.runPromise(AccessAdministrationService.use((service) => service.writePolicy({
      expectedRevision: 0,
      policy: {
        ...defaultAccessPolicy,
        shareLinks: {...defaultAccessPolicy.shareLinks, guestPermissionsMax: ["artifact.view"]},
      },
      principal: harness.administrator,
    })));
    expect(written).toMatchObject({narrowed: {grants: 0, shareLinks: 0}, policy: {revision: 1}});
    expect(await failureTag(harness, AccessAdministrationService.use((service) => service.writePolicy({
      expectedRevision: 0,
      policy: defaultAccessPolicy,
      principal: harness.administrator,
    })))).toBe("AccessRevisionConflict");
    const member = await harness.person("Sam");
    expect(await failureTag(harness, AccessAdministrationService.use((service) => service.readPolicy(member))))
      .toBe("AuthorizationDenied");
  });

  test("a member ceiling reports how many grants it narrows", async () => {
    const projectId = await harness.createProject("Design");
    const sam = await harness.person("Sam");
    await harness.grant({memberId: sam.id, projectId, role: "manager"});
    const written = await harness.runtime.runPromise(AccessAdministrationService.use((service) => service.writePolicy({
      expectedRevision: 0,
      policy: {...defaultAccessPolicy, members: {memberCeiling: ["artifact.view", "artifact.history", "comment.read"]}},
      principal: harness.administrator,
    })));
    expect(written.narrowed.grants).toBe(1);
  });

  test("explain names the project grant and the policy ceiling as sources", async () => {
    const projectId = await harness.createProject("Design");
    const sam = await harness.person("Sam");
    await harness.grant({memberId: sam.id, projectId, role: "commenter"});
    await harness.runtime.runPromise(AccessAdministrationService.use((service) => service.writePolicy({
      expectedRevision: 0,
      policy: {...defaultAccessPolicy, members: {memberCeiling: ["artifact.view", "comment.read"]}},
      principal: harness.administrator,
    })));
    const explained = await harness.runtime.runPromise(AccessAdministrationService.use((service) => service.explain({
      artifactId: null,
      principal: harness.administrator,
      projectId,
      subjectMemberId: sam.id,
    })));
    expect(explained.subject).toEqual({displayName: "Sam", id: sam.id});
    expect([...explained.permissions].toSorted()).toEqual(["artifact.view", "comment.read"]);
    expect(explained.sources).toEqual([
      expect.objectContaining({layer: "project_grant", role: "commenter"}),
      {layer: "policy", removed: ["artifact.history", "comment.write"]},
    ]);
    // A member without project management cannot explain someone else.
    expect(await failureTag(harness, AccessAdministrationService.use((service) => service.explain({
      artifactId: null,
      principal: sam,
      projectId,
      subjectMemberId: harness.administrator.id,
    })))).toBe("AuthorizationDenied");
  });

  test("project access lists every member with their effective role", async () => {
    const projectId = await harness.createProject("Design");
    const dana = await harness.person("Dana");
    const sam = await harness.person("Sam");
    await harness.grant({memberId: sam.id, projectId, role: "viewer"});
    const read = await harness.runtime.runPromise(AccessAdministrationService.use((service) =>
      service.readProjectAccess({principal: harness.administrator, projectId})));
    const roles = Object.fromEntries(read.members.map((member) => [member.displayName, member.effectiveRole]));
    expect(roles).toEqual({Dana: "editor", "Jordan Lee": "administrator", Sam: "viewer"});
    expect(read.grants.map((grant) => grant.memberId)).toEqual([sam.id]);
    expect(dana.id).not.toBe(sam.id);
  });
});
