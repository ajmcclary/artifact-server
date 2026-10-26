import {Cause, type Effect, Exit, Option} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {ActivityService} from "../../src/application/activity.js";
import {ArtifactManagementService} from "../../src/application/artifact-management.js";
import {LibraryCatalogService} from "../../src/application/library-catalog.js";
import {ProjectManagementService} from "../../src/application/project-management.js";
import type {Principal} from "../../src/core/identity.js";
import {startAccessRuntime} from "../support/access-runtime.js";

type AccessRuntime = Awaited<ReturnType<typeof startAccessRuntime>>;

const feedRequest = {
  actorIds: [],
  cursor: null,
  limit: 100,
  projectIds: [],
  search: null,
  segment: "all",
  types: [],
} as const;

async function visibleProjects(harness: AccessRuntime, principal: Principal) {
  const projects = await harness.runtime.runPromise(ProjectManagementService.use((service) =>
    service.listProjects(principal)));
  return projects.map((project) => project.id).toSorted();
}

async function listedArtifacts(harness: AccessRuntime, principal: Principal, projectId: string) {
  const page = await harness.runtime.runPromise(ArtifactManagementService.use((service) =>
    service.listArtifacts({cursor: null, limit: 100, principal, projectId, search: null, tags: []})));
  return page.items.map((item) => item.id).toSorted();
}

async function feedProjects(harness: AccessRuntime, principal: Principal) {
  const page = await harness.runtime.runPromise(ActivityService.use((service) =>
    service.list(principal, feedRequest)));
  return [...new Set(page.items.flatMap((entry) => entry.project === null ? [] : [entry.project.id]))].toSorted();
}

describe("visibility filtering", () => {
  let harness: AccessRuntime;

  beforeEach(async () => {
    harness = await startAccessRuntime();
  });

  afterEach(async () => {
    await harness.stop();
  });

  test("PRM-002-B: a restricted project is absent from projects, artifacts, activity, summaries and the library for a member without a grant", async () => {
    const open = await harness.createProject("Open");
    const secret = await harness.createProject("Secret");
    await harness.publish(harness.administrator, open, "Visible");
    const hidden = await harness.publish(harness.administrator, secret, "Hidden");
    await harness.setProjectAccess(secret, "restricted");
    const sam = await harness.person("Sam");

    const projects = await visibleProjects(harness, sam);
    expect(projects).toContain(open);
    expect(projects).not.toContain(secret);
    expect(await feedProjects(harness, sam)).not.toContain(secret);
    const summary = await harness.runtime.runPromise(ActivityService.use((service) => service.summary(sam, [])));
    expect(summary.projects.map((project) => project.id)).not.toContain(secret);
    const library = await harness.runtime.runPromise(LibraryCatalogService.use((service) => service.read(sam)));
    expect(library.examined).toBe(1);
    expect(library.galleries.some((gallery) => gallery.artifactId === hidden.artifact.id)).toBe(false);

    // The administrator still sees everything.
    expect(await visibleProjects(harness, harness.administrator)).toContain(secret);
    expect(await feedProjects(harness, harness.administrator)).toContain(secret);
  });

  test("an artifact grant lists exactly that artifact in its project", async () => {
    const secret = await harness.createProject("Secret");
    const shared = await harness.publish(harness.administrator, secret, "Shared");
    await harness.publish(harness.administrator, secret, "Hidden");
    await harness.setProjectAccess(secret, "restricted");
    const sam = await harness.person("Sam");
    await harness.grant({artifactId: shared.artifact.id, memberId: sam.id, projectId: secret, role: "viewer"});

    expect(await visibleProjects(harness, sam)).toContain(secret);
    expect(await listedArtifacts(harness, sam, secret)).toEqual([shared.artifact.id]);
    // Activity covers only projects the member can see as a whole.
    expect(await feedProjects(harness, sam)).not.toContain(secret);
  });

  test("PRM-002-F: empty visibility returns nothing", async () => {
    const first = await harness.createProject("First");
    await harness.publish(harness.administrator, first, "One");
    const sam = await harness.person("Sam");
    const projects = await harness.access.listProjectAccess(harness.installationId);
    for (const project of projects) {
      // eslint-disable-next-line no-await-in-loop -- grants are written in a fixed order
      await harness.grant({memberId: sam.id, projectId: project.projectId, role: "none"});
    }

    expect(await visibleProjects(harness, sam)).toEqual([]);
    const page = await harness.runtime.runPromise(ActivityService.use((service) => service.list(sam, feedRequest)));
    expect(page.items).toEqual([]);
    const summary = await harness.runtime.runPromise(ActivityService.use((service) => service.summary(sam, [])));
    expect(summary).toMatchObject({artifactsInReview: 0, needsYou: 0, openConversations: 0, projects: [], withAgent: 0});
    const facets = await harness.runtime.runPromise(ActivityService.use((service) => service.facets(sam, feedRequest)));
    expect(facets.total).toBe(0);
    const library = await harness.runtime.runPromise(LibraryCatalogService.use((service) => service.read(sam)));
    expect(library.examined).toBe(0);
  });

  test("a direct version, version list or manifest page of a hidden project answers not found", async () => {
    const secret = await harness.createProject("Secret");
    const hidden = await harness.publish(harness.administrator, secret, "Hidden");
    await harness.setProjectAccess(secret, "restricted");
    const sam = await harness.person("Sam");
    const scope = {artifactId: hidden.artifact.id, principal: sam, projectId: secret};
    const failureTag = async <A, E extends {readonly _tag: string}>(
      effect: Effect.Effect<A, E, ArtifactManagementService>,
    ): Promise<string | null> => {
      const exit = await harness.runtime.runPromiseExit(effect);
      if (Exit.isSuccess(exit)) return null;
      return Option.getOrNull(Cause.findErrorOption(exit.cause).pipe(Option.map((error) => error._tag)));
    };
    expect(await failureTag(ArtifactManagementService.use((service) =>
      service.getVersionDetails({...scope, versionId: hidden.version.id})))).toBe("ProjectNotFound");
    expect(await failureTag(ArtifactManagementService.use((service) =>
      service.listVersions({...scope, cursor: null, limit: 10})))).toBe("ProjectNotFound");
    expect(await failureTag(ArtifactManagementService.use((service) =>
      service.listManifestEntries({...scope, cursor: null, limit: 10, versionId: hidden.version.id}))))
      .toBe("ProjectNotFound");
  });

});
