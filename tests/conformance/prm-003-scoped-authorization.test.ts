import {randomUUID} from "node:crypto";

import {Cause, type Effect, Exit} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {ArtifactCommentService} from "../../src/application/artifact-comments.js";
import {ArtifactManagementService} from "../../src/application/artifact-management.js";
import {InstallationAccessService} from "../../src/application/installation-access.js";
import {ProjectManagementService} from "../../src/application/project-management.js";
import type {Principal} from "../../src/core/identity.js";
import {startAccessRuntime} from "../support/access-runtime.js";

type AccessRuntime = Awaited<ReturnType<typeof startAccessRuntime>>;

/** The failure tag of an effect run against the real runtime, or "success". */
async function outcome<A, E extends {readonly _tag: string}>(
  harness: AccessRuntime,
  effect: Effect.Effect<A, E, ArtifactCommentService | ArtifactManagementService | ProjectManagementService>,
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

  test("PRM-003-F: a member of a restricted project without a grant gets not found for the artifact and the project", async () => {
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
