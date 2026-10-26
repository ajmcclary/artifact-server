import {randomUUID} from "node:crypto";

import {Cause, type Effect, Exit, Option} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {AccessAdministrationService} from "../../src/application/access-administration.js";
import {ArtifactCommentService} from "../../src/application/artifact-comments.js";
import {ArtifactManagementService} from "../../src/application/artifact-management.js";
import {ContentAccessService} from "../../src/application/content-access.js";
import {GuestReviewService} from "../../src/application/guest-review.js";
import {ProjectManagementService} from "../../src/application/project-management.js";
import {ShareLinkService} from "../../src/application/share-links.js";
import {defaultAccessPolicy} from "../../src/core/access-policy.js";
import type {Principal} from "../../src/core/identity.js";
import type {Permission} from "../../src/core/permissions.js";
import type {ShareLinkTarget} from "../../src/core/share-links.js";
import {startAccessRuntime} from "../support/access-runtime.js";

type AccessRuntime = Awaited<ReturnType<typeof startAccessRuntime>>;
type Services =
  | AccessAdministrationService
  | ArtifactCommentService
  | ArtifactManagementService
  | ContentAccessService
  | GuestReviewService
  | ProjectManagementService
  | ShareLinkService;

async function failureTag<A, E extends {readonly _tag: string}>(
  harness: AccessRuntime,
  effect: Effect.Effect<A, E, Services>,
): Promise<string | null> {
  const exit = await harness.runtime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return null;
  return Option.getOrNull(Cause.findErrorOption(exit.cause).pipe(Option.map((error) => error._tag)));
}

const authenticate = (sessionToken: string) =>
  GuestReviewService.use((guests) => guests.authenticate({sessionToken}));

const comment = (principal: Principal, body = "From the client.") =>
  GuestReviewService.use((guests) => guests.createThread({
    anchor: null,
    body,
    idempotencyKey: `guest-${randomUUID()}`,
    path: null,
    principal,
  }));

describe("guest review sessions", () => {
  let harness: AccessRuntime;

  const share = async (
    projectId: string,
    artifactId: string,
    permissions: readonly Permission[] = ["artifact.view", "comment.read", "comment.write"],
    target: ShareLinkTarget = {kind: "latest"},
    expiresAt: string | null = null,
  ) => harness.runtime.runPromise(ShareLinkService.use((links) => links.create({
    artifactId,
    expiresAt,
    label: "Client review",
    permissions,
    principal: harness.administrator,
    projectId,
    target,
  })));

  const join = async (token: string) => {
    const started = await harness.runtime.runPromise(GuestReviewService.use((guests) => guests.startSession({token})));
    const authenticated = await harness.runtime.runPromise(GuestReviewService.use((guests) =>
      guests.authenticate({sessionToken: started.sessionToken})));
    return {...started, principal: authenticated.principal};
  };


  const setup = async () => {
    const projectId = await harness.createProject("Design");
    const published = await harness.publish(harness.administrator, projectId);
    return {artifactId: published.artifact.id, projectId, versionId: published.version.id};
  };

  beforeEach(async () => {
    harness = await startAccessRuntime();
  });

  afterEach(async () => {
    await harness.stop();
  });

  test("PRM-006-B: a guest on a view-and-comment link names themselves and creates, replies to, edits and deletes their own thread", async () => {
    const fixture = await setup();
    const link = await share(fixture.projectId, fixture.artifactId);
    const guest = await join(link.token);
    expect(guest.context).toMatchObject({
      artifact: {id: fixture.artifactId},
      guest: {displayName: null},
      link: {createdByName: "Jordan Lee", id: link.id, label: "Client review"},
      project: {id: fixture.projectId, name: "Design"},
      version: {id: fixture.versionId, number: 1},
    });
    const named = await harness.runtime.runPromise(GuestReviewService.use((guests) =>
      guests.setIdentity({contactEmail: "pat@client.test", displayName: "‮Pat ", principal: guest.principal})));
    expect(named.guest.displayName).toBe("Pat");
    const {principal} = await harness.runtime.runPromise(authenticate(guest.sessionToken));
    const created = await harness.runtime.runPromise(comment(principal));
    expect(created.thread.author).toMatchObject({displayName: "Pat", principalKind: "guest"});
    expect(created.thread.versionId).toBe(fixture.versionId);
    await harness.runtime.runPromise(GuestReviewService.use((guests) => guests.createReply({
      body: "One more thing.",
      idempotencyKey: `guest-reply-${randomUUID()}`,
      principal,
      threadId: created.thread.id,
    })));
    await harness.runtime.runPromise(GuestReviewService.use((guests) =>
      guests.updateThread({body: "Edited.", principal, threadId: created.thread.id})));
    const page = await harness.runtime.runPromise(GuestReviewService.use((guests) =>
      guests.listThreads({cursor: null, limit: 25, principal})));
    expect(page.items.map((thread) => thread.body)).toEqual(["Edited."]);
    await harness.runtime.runPromise(GuestReviewService.use((guests) =>
      guests.deleteThread({principal, threadId: created.thread.id})));
    expect(await failureTag(harness, GuestReviewService.use((guests) =>
      guests.getThread({principal, threadId: created.thread.id})))).toBe("CommentNotFound");
  });

  test("PRM-006-F: a guest cannot read history, another version's threads, another artifact, or a member operation", async () => {
    const fixture = await setup();
    const other = await harness.publish(harness.administrator, fixture.projectId, "Other");
    const v2 = await harness.publishVersion(harness.administrator, fixture.projectId, fixture.artifactId, fixture.versionId);
    const link = await share(fixture.projectId, fixture.artifactId, undefined, {kind: "pinned", versionId: fixture.versionId});
    const {principal} = await join(link.token);
    // A member's thread on the version the link does not open.
    const memberThread = await harness.runtime.runPromise(
      ArtifactCommentService.use((comments) =>
        comments.createThread({
          anchor: null,
          artifactId: fixture.artifactId,
          body: "On version two.",
          idempotencyKey: `member-${randomUUID()}`,
          path: null,
          principal: harness.administrator,
          projectId: fixture.projectId,
          versionId: v2.version.id,
        })),
    );
    expect(await failureTag(harness, GuestReviewService.use((guests) =>
      guests.getThread({principal, threadId: memberThread.thread.id})))).toBe("CommentNotFound");
    expect(await failureTag(harness, ArtifactManagementService.use((artifacts) =>
      artifacts.listVersions({artifactId: fixture.artifactId, cursor: null, limit: 10, principal, projectId: fixture.projectId}))))
      .toBe("AuthorizationDenied");
    expect(await failureTag(harness, ArtifactManagementService.use((artifacts) =>
      artifacts.getArtifact({artifactId: other.artifact.id, principal, projectId: fixture.projectId}))))
      .toBe("ArtifactNotFound");
    expect(await failureTag(harness, ProjectManagementService.use((projects) => projects.listProjects(principal))))
      .toBe("AuthorizationDenied");
    expect(await failureTag(harness, ShareLinkService.use((links) =>
      links.listForArtifact({artifactId: fixture.artifactId, principal, projectId: fixture.projectId}))))
      .toBe("AuthorizationDenied");
  });

  test("a view-only guest cannot comment, and commenting before naming asks for a name", async () => {
    const fixture = await setup();
    const viewOnly = await join((await share(fixture.projectId, fixture.artifactId, ["artifact.view"])).token);
    expect(await failureTag(harness, comment(viewOnly.principal))).toBe("AuthorizationDenied");
    const unnamed = await join((await share(fixture.projectId, fixture.artifactId)).token);
    expect(await failureTag(harness, comment(unnamed.principal))).toBe("GuestIdentityRequired");
  });

  test("PRM-007-B: revoke, rotate and expiry each end the session on the next request", async () => {
    const fixture = await setup();
    const revokedLink = await share(fixture.projectId, fixture.artifactId);
    const revokedGuest = await join(revokedLink.token);
    await harness.runtime.runPromise(ShareLinkService.use((links) =>
      links.revoke({linkId: revokedLink.id, principal: harness.administrator, projectId: fixture.projectId})));
    expect(await failureTag(harness, authenticate(revokedGuest.sessionToken))).toBe("GuestSessionRequired");

    const rotatedLink = await share(fixture.projectId, fixture.artifactId);
    const rotatedGuest = await join(rotatedLink.token);
    await harness.runtime.runPromise(ShareLinkService.use((links) => links.rotate({
      expectedRevision: rotatedLink.revision,
      linkId: rotatedLink.id,
      principal: harness.administrator,
      projectId: fixture.projectId,
    })));
    expect(await failureTag(harness, authenticate(rotatedGuest.sessionToken))).toBe("GuestSessionRequired");
    expect(await failureTag(harness, GuestReviewService.use((guests) => guests.startSession({token: rotatedLink.token}))))
      .toBe("ShareLinkNotFound");

    const expiringLink = await share(fixture.projectId, fixture.artifactId, undefined, {kind: "latest"}, "2026-10-26T11:00:00.000Z");
    const expiringGuest = await join(expiringLink.token);
    harness.clock.advance(3_601_000);
    expect(await failureTag(harness, authenticate(expiringGuest.sessionToken))).toBe("GuestSessionRequired");
  });

  test("PRM-007-F: a guest preview lease stops serving once its version is no longer the link's target", async () => {
    const fixture = await setup();
    const link = await share(fixture.projectId, fixture.artifactId);
    const {principal} = await join(link.token);
    const lease = await harness.runtime.runPromise(GuestReviewService.use((guests) => guests.issuePreviewLease({principal})));
    const served = await harness.runtime.runPromise(ContentAccessService.use((content) =>
      content.authorizePreviewContent({fallback: "none", path: "index.html", token: lease.token})));
    expect(served?.content.versionId).toBe(fixture.versionId);
    await harness.publishVersion(harness.administrator, fixture.projectId, fixture.artifactId, fixture.versionId);
    expect(await failureTag(harness, ContentAccessService.use((content) =>
      content.authorizePreviewContent({fallback: "none", path: "index.html", token: lease.token}))))
      .toBe("ContentSessionRequired");
  });

  test("narrowing the policy removes guest commenting on the next request", async () => {
    const fixture = await setup();
    const link = await share(fixture.projectId, fixture.artifactId);
    const guest = await join(link.token);
    await harness.runtime.runPromise(GuestReviewService.use((guests) =>
      guests.setIdentity({contactEmail: null, displayName: "Pat", principal: guest.principal})));
    await harness.runtime.runPromise(AccessAdministrationService.use((service) => service.writePolicy({
      expectedRevision: 0,
      policy: {...defaultAccessPolicy, shareLinks: {...defaultAccessPolicy.shareLinks, guestPermissionsMax: ["artifact.view"]}},
      principal: harness.administrator,
    })));
    const {principal} = await harness.runtime.runPromise(authenticate(guest.sessionToken));
    expect(await failureTag(harness, comment(principal))).toBe("AuthorizationDenied");
  });

  test("an archived project refuses guest comments and still serves the view", async () => {
    const fixture = await setup();
    const guest = await join((await share(fixture.projectId, fixture.artifactId)).token);
    await harness.runtime.runPromise(GuestReviewService.use((guests) =>
      guests.setIdentity({contactEmail: null, displayName: "Pat", principal: guest.principal})));
    await harness.runtime.runPromise(ProjectManagementService.use((projects) =>
      projects.archiveProject({principal: harness.administrator, projectId: fixture.projectId})));
    const {principal} = await harness.runtime.runPromise(authenticate(guest.sessionToken));
    expect(await failureTag(harness, comment(principal))).toBe("ProjectArchived");
    expect(await failureTag(harness, GuestReviewService.use((guests) => guests.issuePreviewLease({principal})))).toBeNull();
  });

  test("unknown, revoked and policy-disabled links answer the same not-found, and the policy stops bare public links", async () => {
    const fixture = await setup();
    expect(await failureTag(harness, GuestReviewService.use((guests) => guests.startSession({token: "shr_unknown"}))))
      .toBe("ShareLinkNotFound");
    const link = await share(fixture.projectId, fixture.artifactId);
    await harness.runtime.runPromise(ArtifactManagementService.use((artifacts) => artifacts.changeAccess({
      accessSetting: "public_link",
      artifactId: fixture.artifactId,
      expectedCurrentVersionId: fixture.versionId,
      idempotencyKey: `public-${randomUUID()}`,
      principal: harness.administrator,
      projectId: fixture.projectId,
    })));
    expect(await failureTag(harness, ContentAccessService.use((content) => content.resolvePublicArtifact(fixture.artifactId))))
      .toBeNull();
    await harness.runtime.runPromise(AccessAdministrationService.use((service) => service.writePolicy({
      expectedRevision: 0,
      policy: {...defaultAccessPolicy, shareLinks: {...defaultAccessPolicy.shareLinks, enabled: false}},
      principal: harness.administrator,
    })));
    expect(await failureTag(harness, GuestReviewService.use((guests) => guests.startSession({token: link.token}))))
      .toBe("ShareLinkNotFound");
    expect(await failureTag(harness, ContentAccessService.use((content) => content.resolvePublicArtifact(fixture.artifactId))))
      .toBe("ContentSessionRequired");
  });
});
