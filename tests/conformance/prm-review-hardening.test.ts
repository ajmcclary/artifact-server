import {randomUUID} from "node:crypto";

import {Cause, type Effect, Exit, Option} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {AccessAdministrationService} from "../../src/application/access-administration.js";
import {AgentDispatchService} from "../../src/application/agent-dispatch.js";
import {ArtifactManagementService} from "../../src/application/artifact-management.js";
import {ContentAccessService} from "../../src/application/content-access.js";
import {GuestReviewService} from "../../src/application/guest-review.js";
import {ShareLinkService} from "../../src/application/share-links.js";
import type {Principal} from "../../src/core/identity.js";
import {startAccessRuntime} from "../support/access-runtime.js";

type AccessRuntime = Awaited<ReturnType<typeof startAccessRuntime>>;
type Services =
  | AccessAdministrationService
  | AgentDispatchService
  | ArtifactManagementService
  | ContentAccessService
  | GuestReviewService
  | ShareLinkService;

async function failureTag<A, E extends {readonly _tag: string}>(
  harness: AccessRuntime,
  effect: Effect.Effect<A, E, Services>,
): Promise<string | null> {
  const exit = await harness.runtime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return null;
  return Option.getOrNull(Cause.findErrorOption(exit.cause).pipe(Option.map((error) => error._tag)));
}

const lease = (principal: Principal, projectId: string, artifactId: string, versionId: string) =>
  ContentAccessService.use((content) => content.issuePreviewLease({artifactId, principal, projectId, reuseToken: null, versionId}));

describe("access hardening from the final review", () => {
  let harness: AccessRuntime;

  beforeEach(async () => {
    harness = await startAccessRuntime();
  });

  afterEach(async () => {
    await harness.stop();
  });

  test("an older version's bytes need artifact.history; the current version needs only view", async () => {
    const projectId = await harness.createProject("Design");
    const first = await harness.publish(harness.administrator, projectId);
    await harness.publishVersion(harness.administrator, projectId, first.artifact.id, first.version.id);
    const member = await harness.person("Dana");
    await harness.grant({memberId: member.id, projectId, remove: ["artifact.history"], role: "viewer"});
    expect(await failureTag(harness, lease(member, projectId, first.artifact.id, first.version.id)))
      .toBe("AuthorizationDenied");
    const current = await harness.runtime.runPromise(ArtifactManagementService.use((artifacts) =>
      artifacts.getArtifact({artifactId: first.artifact.id, principal: member, projectId})));
    expect(await failureTag(harness, lease(member, projectId, first.artifact.id, current.artifact.currentVersionId)))
      .toBeNull();
  });

  test("removing a member's grant or restricting the project ends their preview leases on the next request", async () => {
    const projectId = await harness.createProject("Design");
    const published = await harness.publish(harness.administrator, projectId);
    const member = await harness.person("Dana");
    const issued = await harness.runtime.runPromise(lease(member, projectId, published.artifact.id, published.version.id));
    const read = ContentAccessService.use((content) =>
      content.authorizePreviewContent({fallback: "none", path: "index.html", token: issued.token}));
    expect(await failureTag(harness, read)).toBeNull();
    const {access} = await harness.runtime.runPromise(AccessAdministrationService.use((service) =>
      service.readProjectAccess({principal: harness.administrator, projectId})));
    await harness.runtime.runPromise(AccessAdministrationService.use((service) => service.changeProjectAccess({
      accessMode: "restricted",
      confirmMembersLosingAccess: 1,
      defaultMemberRole: "editor",
      expectedRevision: access.revision,
      principal: harness.administrator,
      projectId,
    })));
    expect(await failureTag(harness, read)).toBe("ContentSessionRequired");

    const granted = await harness.runtime.runPromise(AccessAdministrationService.use((service) => service.putGrant({
      add: [],
      artifactId: null,
      expectedRevision: null,
      expiresAt: null,
      memberId: member.id,
      principal: harness.administrator,
      projectId,
      remove: [],
      role: "viewer",
    })));
    const again = await harness.runtime.runPromise(lease(member, projectId, published.artifact.id, published.version.id));
    await harness.runtime.runPromise(AccessAdministrationService.use((service) => service.deleteGrant({
      artifactId: null,
      expectedRevision: granted.revision,
      memberId: member.id,
      principal: harness.administrator,
      projectId,
    })));
    expect(await failureTag(harness, ContentAccessService.use((content) =>
      content.authorizePreviewContent({fallback: "none", path: "index.html", token: again.token}))))
      .toBe("ContentSessionRequired");
  });

  test("setting an already-private artifact private keeps its share links", async () => {
    const projectId = await harness.createProject("Design");
    const published = await harness.publish(harness.administrator, projectId);
    const link = await harness.runtime.runPromise(ShareLinkService.use((links) => links.create({
      artifactId: published.artifact.id,
      expiresAt: null,
      label: "Client review",
      permissions: ["artifact.view"],
      principal: harness.administrator,
      projectId,
      target: {kind: "latest"},
    })));
    await harness.runtime.runPromise(ArtifactManagementService.use((artifacts) => artifacts.changeAccess({
      accessSetting: "account_required",
      artifactId: published.artifact.id,
      expectedCurrentVersionId: published.version.id,
      idempotencyKey: `private-${randomUUID()}`,
      principal: harness.administrator,
      projectId,
    })));
    const listed = await harness.runtime.runPromise(ShareLinkService.use((links) =>
      links.listForArtifact({artifactId: published.artifact.id, principal: harness.administrator, projectId})));
    expect(listed.find((item) => item.id === link.id)?.revokedAt).toBeNull();
  });

  test("a member who sees only one artifact cannot read the project's dispatches", async () => {
    const projectId = await harness.createProject("Design");
    const published = await harness.publish(harness.administrator, projectId);
    await harness.setProjectAccess(projectId, "restricted");
    const member = await harness.person("Dana");
    await harness.grant({artifactId: published.artifact.id, memberId: member.id, projectId, role: "viewer"});
    expect(await failureTag(harness, AgentDispatchService.use((dispatch) => dispatch.listDispatches({
      agentId: null,
      cursor: null,
      limit: 10,
      principal: member,
      projectId,
      state: null,
    })))).toBe("AuthorizationDenied");
    expect(await failureTag(harness, AgentDispatchService.use((dispatch) => dispatch.listDispatches({
      agentId: null,
      cursor: null,
      limit: 10,
      principal: harness.administrator,
      projectId,
      state: null,
    })))).toBeNull();
  });

  test("a guest who is still on the old version of a latest link is told the version changed instead of commenting on the new one", async () => {
    const projectId = await harness.createProject("Design");
    const published = await harness.publish(harness.administrator, projectId);
    const link = await harness.runtime.runPromise(ShareLinkService.use((links) => links.create({
      artifactId: published.artifact.id,
      expiresAt: null,
      label: "Client review",
      permissions: ["artifact.view", "comment.read", "comment.write"],
      principal: harness.administrator,
      projectId,
      target: {kind: "latest"},
    })));
    const started = await harness.runtime.runPromise(GuestReviewService.use((guests) => guests.startSession({admissionWait: () => null, existingSession: () => null, token: link.token})));
    const {principal} = await harness.runtime.runPromise(GuestReviewService.use((guests) =>
      guests.authenticate({sessionToken: started.sessionToken})));
    await harness.runtime.runPromise(GuestReviewService.use((guests) =>
      guests.setIdentity({contactEmail: null, displayName: "Pat", principal})));
    await harness.publishVersion(harness.administrator, projectId, published.artifact.id, published.version.id);
    const named = await harness.runtime.runPromise(GuestReviewService.use((guests) =>
      guests.authenticate({sessionToken: started.sessionToken})));
    const comment = (viewingVersionId: string) => GuestReviewService.use((guests) => guests.createThread({
      anchor: null,
      body: "Looks good.",
      idempotencyKey: `guest-${randomUUID()}`,
      path: null,
      principal: named.principal,
      viewingVersionId,
    }));
    expect(await failureTag(harness, comment(published.version.id))).toBe("GuestVersionChanged");
    expect(await failureTag(harness, comment(named.context.version.id))).toBeNull();
    expect(await failureTag(harness, GuestReviewService.use((guests) => guests.listThreads({
      cursor: null,
      limit: 25,
      principal: named.principal,
      viewingVersionId: published.version.id,
    })))).toBe("GuestVersionChanged");
  });
});
