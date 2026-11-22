import {randomUUID} from "node:crypto";

import {Cause, type Effect, Exit} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {AccessAdministrationService} from "../../src/application/access-administration.js";
import {ArtifactCommentService} from "../../src/application/artifact-comments.js";
import {ArtifactManagementService} from "../../src/application/artifact-management.js";
import {InstallationAccessService} from "../../src/application/installation-access.js";
import {ProjectGitHistoryService} from "../../src/application/project-git-history.js";
import {ProjectManagementService} from "../../src/application/project-management.js";
import {ShareLinkService} from "../../src/application/share-links.js";
import type {Principal} from "../../src/core/identity.js";
import {startAccessRuntime} from "../support/access-runtime.js";

type AccessRuntime = Awaited<ReturnType<typeof startAccessRuntime>>;

/** The failure tag of an effect run against the real runtime, or "success". */
async function outcome<A, E extends {readonly _tag: string}>(
  harness: AccessRuntime,
  effect: Effect.Effect<
    A,
    E,
    | AccessAdministrationService
    | ArtifactCommentService
    | ArtifactManagementService
    | ProjectGitHistoryService
    | ProjectManagementService
    | ShareLinkService
  >,
): Promise<string> {
  const exit = await harness.runtime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return "success";
  const failure = Cause.findErrorOption(exit.cause);
  return failure._tag === "Some" ? failure.value._tag : Cause.pretty(exit.cause);
}

const getArtifact = (principal: Principal, projectId: string, artifactId: string) =>
  ArtifactManagementService.use((artifacts) => artifacts.getArtifact({artifactId, principal, projectId}));

const rename = (principal: Principal, projectId: string, artifactId: string, versionId: string, name: string) =>
  ArtifactManagementService.use((artifacts) => artifacts.renameArtifact({
    artifactId,
    expectedCurrentVersionId: versionId,
    expectedName: "Fixture",
    idempotencyKey: `rename-${randomUUID()}`,
    name,
    principal,
    projectId,
  }));

const comment = (principal: Principal, projectId: string, artifactId: string, versionId: string) =>
  ArtifactCommentService.use((comments) => comments.createThread({
    anchor: null,
    artifactId,
    body: "Looks good.",
    idempotencyKey: `comment-${randomUUID()}`,
    path: null,
    principal,
    projectId,
    versionId,
  }));

describe("scoped authorization", () => {
  let harness: AccessRuntime;

  beforeEach(async () => {
    harness = await startAccessRuntime();
  });

  afterEach(async () => {
    await harness.stop();
  });

  test("PRM-003-B: a viewer grant allows reading and denies publishing-class changes", async () => {
    const projectId = await harness.createProject("Design");
    const published = await harness.publish(harness.administrator, projectId);
    const dana = await harness.person("Dana");
    await harness.grant({memberId: dana.id, projectId, role: "viewer"});

    expect(await outcome(harness, getArtifact(dana, projectId, published.artifact.id))).toBe("success");
    expect(await outcome(harness, rename(dana, projectId, published.artifact.id, published.version.id, "Renamed")))
      .toBe("AuthorizationDenied");
    expect(await outcome(harness, comment(dana, projectId, published.artifact.id, published.version.id)))
      .toBe("AuthorizationDenied");
  });

  test("an editor default lets every member do what members did before project access", async () => {
    const projectId = await harness.createProject("Open");
    const published = await harness.publish(harness.administrator, projectId);
    const sam = await harness.person("Sam");
    expect(await outcome(harness, comment(sam, projectId, published.artifact.id, published.version.id)))
      .toBe("success");
    expect(await outcome(harness, rename(sam, projectId, published.artifact.id, published.version.id, "Renamed")))
      .toBe("success");
    expect(await outcome(harness, ProjectManagementService.use((projects) =>
      projects.renameProject({name: "Nope", principal: sam, projectId})))).toBe("AuthorizationDenied");
  });

  test("a manager grant lets a member rename a project and delete another member's comment", async () => {
    const projectId = await harness.createProject("Managed");
    const published = await harness.publish(harness.administrator, projectId);
    const dana = await harness.person("Dana");
    const sam = await harness.person("Sam");
    await harness.grant({memberId: dana.id, projectId, role: "manager"});
    const created = await harness.runtime.runPromise(comment(sam, projectId, published.artifact.id, published.version.id));

    expect(await outcome(harness, ProjectManagementService.use((projects) =>
      projects.renameProject({name: "Renamed", principal: dana, projectId})))).toBe("success");
    expect(await outcome(harness, ArtifactCommentService.use((comments) => comments.deleteThread({
      artifactId: published.artifact.id,
      principal: dana,
      projectId,
      threadId: created.thread.id,
    })))).toBe("success");
  });

  test("comment deletion follows authorship and bulk clear needs comment moderation", async () => {
    const projectId = await harness.createProject("Moderated");
    const published = await harness.publish(harness.administrator, projectId);
    const sam = await harness.person("Sam");
    const lee = await harness.person("Lee");
    const dana = await harness.person("Dana");
    // A manager whose comment.write is removed still moderates other people's comments.
    await harness.grant({memberId: dana.id, projectId, remove: ["comment.write"], role: "manager"});
    const deleteThread = (principal: Principal, threadId: string) =>
      ArtifactCommentService.use((comments) => comments.deleteThread({
        artifactId: published.artifact.id,
        principal,
        projectId,
        threadId,
      }));
    const clear = (principal: Principal) =>
      ArtifactCommentService.use((comments) => comments.clearThreads({
        artifactId: published.artifact.id,
        principal,
        projectId,
        state: "all",
        versionId: null,
      }));
    const first = await harness.runtime.runPromise(comment(sam, projectId, published.artifact.id, published.version.id));
    const second = await harness.runtime.runPromise(comment(sam, projectId, published.artifact.id, published.version.id));
    const third = await harness.runtime.runPromise(comment(sam, projectId, published.artifact.id, published.version.id));

    // An editor holds agent.dispatch but not comment.moderate: no bulk clear, no deleting others' words.
    expect(await outcome(harness, clear(lee))).toBe("AuthorizationDenied");
    expect(await outcome(harness, deleteThread(lee, first.thread.id))).toBe("AuthorizationDenied");
    expect(await outcome(harness, deleteThread(sam, first.thread.id))).toBe("success");
    expect(await outcome(harness, deleteThread(dana, second.thread.id))).toBe("success");
    expect(await outcome(harness, clear(dana))).toBe("success");
    expect(await outcome(harness, ArtifactCommentService.use((comments) => comments.getThread({
      artifactId: published.artifact.id,
      principal: sam,
      projectId,
      threadId: third.thread.id,
    })))).toBe("CommentNotFound");
  });

  test("PRM-003-F: a member of a restricted project without a grant gets not found for the artifact and the project, and no role beats the archived state", async () => {
    const projectId = await harness.createProject("Secret");
    const published = await harness.publish(harness.administrator, projectId);
    await harness.setProjectAccess(projectId, "restricted");
    const sam = await harness.person("Sam");

    // A hidden project answers exactly like one that does not exist, for every artifact in it.
    expect(await outcome(harness, getArtifact(sam, projectId, published.artifact.id))).toBe("ProjectNotFound");
    expect(await outcome(harness, getArtifact(sam, projectId, "art_does_not_exist"))).toBe("ProjectNotFound");
    expect(await outcome(harness, getArtifact(sam, "prj_does_not_exist", published.artifact.id))).toBe("ProjectNotFound");
    expect(await outcome(harness, ProjectManagementService.use((projects) =>
      projects.getProject({principal: sam, projectId})))).toBe("ProjectNotFound");

    // Archive makes a project read-only for its artifacts, administrators
    // included: nothing that changes content or widens exposure succeeds,
    // while every exposure-reducing action and unarchive stay open.
    const archivedId = await harness.createProject("Archived");
    const first = await harness.publish(harness.administrator, archivedId);
    const second = await harness.publishVersion(harness.administrator, archivedId, first.artifact.id, first.version.id);
    const lee = await harness.person("Lee");
    const admin = harness.administrator;
    const changeAccess = (accessSetting: "account_required" | "public_link") =>
      ArtifactManagementService.use((artifacts) => artifacts.changeAccess({
        accessSetting,
        artifactId: first.artifact.id,
        expectedCurrentVersionId: second.version.id,
        idempotencyKey: `access-${randomUUID()}`,
        principal: admin,
        projectId: archivedId,
      }));
    await harness.runtime.runPromise(changeAccess("public_link"));
    const link = await harness.runtime.runPromise(ShareLinkService.use((links) => links.create({
      artifactId: first.artifact.id,
      expiresAt: "2026-12-01T00:00:00.000Z",
      label: "Before archive",
      permissions: ["artifact.view", "comment.read"],
      principal: admin,
      projectId: archivedId,
      target: {kind: "latest"},
    })));
    const leeGrant = await harness.runtime.runPromise(AccessAdministrationService.use((access) => access.putGrant({
      add: [],
      artifactId: null,
      expectedRevision: null,
      expiresAt: null,
      memberId: lee.id,
      principal: admin,
      projectId: archivedId,
      remove: [],
      role: "commenter",
    })));
    await harness.runtime.runPromise(ProjectManagementService.use((projects) =>
      projects.archiveProject({principal: admin, projectId: archivedId})));

    const refusals = {
      createLink: await outcome(harness, ShareLinkService.use((links) => links.create({
        artifactId: first.artifact.id,
        expiresAt: null,
        label: "After archive",
        permissions: ["artifact.view"],
        principal: admin,
        projectId: archivedId,
        target: {kind: "latest"},
      }))),
      deleteArtifact: await outcome(harness, ArtifactManagementService.use((artifacts) => artifacts.deleteArtifact({
        artifactId: first.artifact.id,
        expectedCurrentVersionId: second.version.id,
        idempotencyKey: `delete-${randomUUID()}`,
        principal: admin,
        projectId: archivedId,
      }))),
      enableGitHistory: await outcome(harness, ProjectGitHistoryService.use((history) =>
        history.set({enabled: true, principal: admin, projectId: archivedId}))),
      newGrant: await outcome(harness, AccessAdministrationService.use((access) => access.putGrant({
        add: [],
        artifactId: null,
        expectedRevision: null,
        expiresAt: null,
        memberId: sam.id,
        principal: admin,
        projectId: archivedId,
        remove: [],
        role: "viewer",
      }))),
      openProject: await outcome(harness, AccessAdministrationService.use((access) => access.changeProjectAccess({
        accessMode: "open",
        confirmMembersLosingAccess: null,
        defaultMemberRole: "manager",
        expectedRevision: 0,
        principal: admin,
        projectId: archivedId,
      }))),
      restore: await outcome(harness, ArtifactManagementService.use((artifacts) => artifacts.restoreVersion({
        artifactId: first.artifact.id,
        expectedCurrentVersionId: second.version.id,
        idempotencyKey: `restore-${randomUUID()}`,
        principal: admin,
        projectId: archivedId,
        versionId: first.version.id,
      }))),
      retag: await outcome(harness, ArtifactManagementService.use((artifacts) => artifacts.changeTags({
        artifactId: first.artifact.id,
        expectedCurrentVersionId: second.version.id,
        idempotencyKey: `tags-${randomUUID()}`,
        principal: admin,
        projectId: archivedId,
        tags: ["changed"],
      }))),
      widenGrant: await outcome(harness, AccessAdministrationService.use((access) => access.putGrant({
        add: [],
        artifactId: null,
        expectedRevision: leeGrant.revision,
        expiresAt: null,
        memberId: lee.id,
        principal: admin,
        projectId: archivedId,
        remove: [],
        role: "editor",
      }))),
      widenLink: await outcome(harness, ShareLinkService.use((links) => links.update({
        expectedRevision: link.revision,
        expiresAt: null,
        label: "Before archive",
        linkId: link.id,
        permissions: ["artifact.view", "comment.read", "comment.write"],
        principal: admin,
        projectId: archivedId,
        target: {kind: "latest"},
      }))),
    };
    expect(refusals).toEqual({
      createLink: "ProjectArchived",
      deleteArtifact: "ProjectArchived",
      enableGitHistory: "ProjectArchived",
      newGrant: "ProjectArchived",
      openProject: "ProjectArchived",
      restore: "ProjectArchived",
      retag: "ProjectArchived",
      widenGrant: "ProjectArchived",
      widenLink: "ProjectArchived",
    });

    // Exposure-reducing actions stay open on the archived project.
    const narrowedLink = await harness.runtime.runPromise(ShareLinkService.use((links) => links.update({
      expectedRevision: link.revision,
      expiresAt: "2026-11-15T00:00:00.000Z",
      label: "Narrowed",
      linkId: link.id,
      permissions: ["artifact.view"],
      principal: admin,
      projectId: archivedId,
      target: {kind: "latest"},
    })));
    expect(narrowedLink.permissions).toEqual(["artifact.view"]);
    expect(await outcome(harness, AccessAdministrationService.use((access) => access.putGrant({
      add: [],
      artifactId: null,
      expectedRevision: leeGrant.revision,
      expiresAt: null,
      memberId: lee.id,
      principal: admin,
      projectId: archivedId,
      remove: [],
      role: "viewer",
    })))).toBe("success");
    expect(await outcome(harness, ShareLinkService.use((links) =>
      links.revoke({linkId: link.id, principal: admin, projectId: archivedId})))).toBe("success");
    expect(await outcome(harness, changeAccess("account_required"))).toBe("success");
    expect(await outcome(harness, changeAccess("public_link"))).toBe("ProjectArchived");

    // Unarchive restores ordinary changes.
    await harness.runtime.runPromise(ProjectManagementService.use((projects) =>
      projects.unarchiveProject({principal: admin, projectId: archivedId})));
    expect(await outcome(harness, changeAccess("public_link"))).toBe("success");
  });

  test("a none grant blocks one member on an open project", async () => {
    const projectId = await harness.createProject("Open");
    const published = await harness.publish(harness.administrator, projectId);
    const sam = await harness.person("Sam");
    await harness.grant({memberId: sam.id, projectId, role: "none"});
    expect(await outcome(harness, getArtifact(sam, projectId, published.artifact.id))).toBe("ProjectNotFound");
  });

  test("an artifact grant opens exactly one artifact of a restricted project", async () => {
    const projectId = await harness.createProject("Secret");
    const shared = await harness.publish(harness.administrator, projectId, "Shared");
    const hidden = await harness.publish(harness.administrator, projectId, "Hidden");
    await harness.setProjectAccess(projectId, "restricted");
    const sam = await harness.person("Sam");
    await harness.grant({artifactId: shared.artifact.id, memberId: sam.id, projectId, role: "commenter"});

    expect(await outcome(harness, getArtifact(sam, projectId, shared.artifact.id))).toBe("success");
    expect(await outcome(harness, comment(sam, projectId, shared.artifact.id, shared.version.id))).toBe("success");
    expect(await outcome(harness, getArtifact(sam, projectId, hidden.artifact.id))).toBe("ArtifactNotFound");
    expect(await outcome(harness, ProjectManagementService.use((projects) =>
      projects.getProject({principal: sam, projectId})))).toBe("success");
  });

  test("an archived project refuses comment writes even for a manager grant", async () => {
    const projectId = await harness.createProject("Old");
    const published = await harness.publish(harness.administrator, projectId);
    const dana = await harness.person("Dana");
    await harness.grant({memberId: dana.id, projectId, role: "manager"});
    await harness.runtime.runPromise(ProjectManagementService.use((projects) =>
      projects.archiveProject({principal: harness.administrator, projectId})));
    expect(await outcome(harness, comment(dana, projectId, published.artifact.id, published.version.id)))
      .toBe("ProjectArchived");
  });

  test("PRM-005-B: an administrator with no grants manages a restricted project", async () => {
    const projectId = await harness.createProject("Secret");
    const published = await harness.publish(harness.administrator, projectId);
    await harness.setProjectAccess(projectId, "restricted", "none");
    expect(await outcome(harness, getArtifact(harness.administrator, projectId, published.artifact.id)))
      .toBe("success");
    expect(await outcome(harness, ProjectManagementService.use((projects) =>
      projects.renameProject({name: "Still mine", principal: harness.administrator, projectId})))).toBe("success");
  });

  test("deactivating a member keeps their grants", async () => {
    const projectId = await harness.createProject("Design");
    const dana = await harness.person("Dana");
    await harness.grant({memberId: dana.id, projectId, role: "manager"});
    await harness.runtime.runPromise(InstallationAccessService.use((service) =>
      service.deactivateMember(harness.administrator, dana.id)));
    const grants = await harness.access.listMemberGrants(harness.installationId, dana.id);
    expect(grants.map((grant) => grant.role)).toEqual(["manager"]);
  });
});
