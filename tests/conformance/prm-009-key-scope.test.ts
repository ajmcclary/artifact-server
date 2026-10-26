import {Cause, type Effect, Exit, Option, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {ArtifactManagementService} from "../../src/application/artifact-management.js";
import {type IssueApiKeyCommand, InstallationAccessService} from "../../src/application/installation-access.js";
import {ProjectManagementService} from "../../src/application/project-management.js";
import type {Principal, PrincipalCapability} from "../../src/core/identity.js";
import {startAccessRuntime} from "../support/access-runtime.js";

type AccessRuntime = Awaited<ReturnType<typeof startAccessRuntime>>;

async function failureTag<A, E extends {readonly _tag: string}>(
  harness: AccessRuntime,
  effect: Effect.Effect<A, E, ArtifactManagementService | InstallationAccessService | ProjectManagementService>,
): Promise<string | null> {
  const exit = await harness.runtime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return null;
  return Option.getOrNull(Cause.findErrorOption(exit.cause).pipe(Option.map((error) => error._tag)));
}

async function publishFailure(harness: AccessRuntime, principal: Principal, projectId: string): Promise<string | null> {
  try {
    await harness.publish(principal, projectId);
    return null;
  } catch (error: unknown) {
    return error instanceof Error ? error.name : "unknown";
  }
}

const issue = (
  harness: AccessRuntime,
  capabilities: readonly PrincipalCapability[],
  projectIds: readonly string[],
  memberId?: string,
) => {
  const command: IssueApiKeyCommand = {
    capabilities,
    expiresAt: "2027-10-26T00:00:00.000Z",
    name: "Scoped key",
    principal: harness.administrator,
    projectIds,
  };
  return InstallationAccessService.use((service) =>
    service.issueApiKey(memberId === undefined ? command : {...command, memberId}));
};

async function keyPrincipal(
  harness: AccessRuntime,
  capabilities: readonly PrincipalCapability[],
  projectIds: readonly string[],
  memberId?: string,
): Promise<Principal> {
  const issued = await harness.runtime.runPromise(issue(harness, capabilities, projectIds, memberId));
  expect(issued.apiKey.projectIds).toEqual(projectIds);
  return harness.runtime.runPromise(InstallationAccessService.use((service) =>
    service.authenticateManagedApiKey(Redacted.make(issued.token))));
}

const publisher: readonly PrincipalCapability[] = ["artifact:create", "artifact:publish:any", "artifact:read"];

describe("project-scoped keys", () => {
  let harness: AccessRuntime;

  beforeEach(async () => {
    harness = await startAccessRuntime();
  });

  afterEach(async () => {
    await harness.stop();
  });

  test("PRM-009-B: a key scoped to project A publishes to A", async () => {
    const projectA = await harness.createProject("A");
    const key = await keyPrincipal(harness, publisher, [projectA]);
    expect(key.projectIds).toEqual([projectA]);
    expect(await publishFailure(harness, key, projectA)).toBeNull();
  });

  test("PRM-009-F: the same key cannot publish to, list, or read project B", async () => {
    const projectA = await harness.createProject("A");
    const projectB = await harness.createProject("B");
    const inB = await harness.publish(harness.administrator, projectB);
    const key = await keyPrincipal(harness, publisher, [projectA]);

    expect(await publishFailure(harness, key, projectB)).toBe("ProjectNotFound");
    expect(await failureTag(harness, ArtifactManagementService.use((service) =>
      service.listArtifacts({cursor: null, limit: 10, principal: key, projectId: projectB, search: null, tags: []}))))
      .toBe("ProjectNotFound");
    expect(await failureTag(harness, ArtifactManagementService.use((service) =>
      service.getArtifact({artifactId: inB.artifact.id, principal: key, projectId: projectB}))))
      .toBe("ProjectNotFound");
    const projects = await harness.runtime.runPromise(ProjectManagementService.use((service) =>
      service.listProjects(key)));
    expect(projects.map((project) => project.id)).toEqual([projectA]);
  });

  test("a member-bound key cannot exceed its member's viewer grant even with publish capabilities", async () => {
    const projectId = await harness.createProject("Design");
    const sam = await harness.person("Sam");
    await harness.grant({memberId: sam.id, projectId, role: "viewer"});
    const key = await keyPrincipal(harness, publisher, [], sam.id);
    expect(await publishFailure(harness, key, projectId)).toBe("AuthorizationDenied");
  });

  test("an administrator's member-bound key acts as an administrator within its capabilities", async () => {
    const projectId = await harness.createProject("Design");
    await harness.setProjectAccess(projectId, "restricted", "none");
    const key = await keyPrincipal(harness, [...publisher, "project:manage"], [], harness.administrator.id);
    expect(key.membershipRole).toBe("administrator");
    expect(await publishFailure(harness, key, projectId)).toBeNull();
    expect(await failureTag(harness, ProjectManagementService.use((service) =>
      service.renameProject({name: "Renamed", principal: key, projectId})))).toBeNull();
  });

  test("issuing with an unknown project id fails with PROJECT_NOT_FOUND", async () => {
    expect(await failureTag(harness, issue(harness, publisher, ["prj_missing"]))).toBe("ProjectNotFound");
  });

  test("rotation keeps the project scope", async () => {
    const projectA = await harness.createProject("A");
    const issued = await harness.runtime.runPromise(issue(harness, publisher, [projectA]));
    const rotated = await harness.runtime.runPromise(InstallationAccessService.use((service) =>
      service.rotateApiKey(harness.administrator, issued.apiKey.id)));
    expect(rotated.apiKey.projectIds).toEqual([projectA]);
  });
});
