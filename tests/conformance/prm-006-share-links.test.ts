import {randomUUID} from "node:crypto";

import {Cause, type Effect, Exit, Option} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {AccessAdministrationService} from "../../src/application/access-administration.js";
import {ArtifactManagementService} from "../../src/application/artifact-management.js";
import {ShareLinkService} from "../../src/application/share-links.js";
import {defaultAccessPolicy, type AccessPolicy} from "../../src/core/access-policy.js";
import type {Principal} from "../../src/core/identity.js";
import type {Permission} from "../../src/core/permissions.js";
import type {ShareLinkTarget} from "../../src/core/share-links.js";
import {startAccessRuntime} from "../support/access-runtime.js";

type AccessRuntime = Awaited<ReturnType<typeof startAccessRuntime>>;
type Services = AccessAdministrationService | ArtifactManagementService | ShareLinkService;

async function failureTag<A, E extends {readonly _tag: string}>(
  harness: AccessRuntime,
  effect: Effect.Effect<A, E, Services>,
): Promise<string | null> {
  const exit = await harness.runtime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return null;
  return Option.getOrNull(Cause.findErrorOption(exit.cause).pipe(Option.map((error) => error._tag)));
}

const create = (
  principal: Principal,
  projectId: string,
  artifactId: string,
  overrides: {
    readonly expiresAt?: string | null;
    readonly label?: string;
    readonly permissions?: readonly Permission[];
    readonly target?: ShareLinkTarget;
  } = {},
) => ShareLinkService.use((links) => links.create({
  artifactId,
  expiresAt: overrides.expiresAt ?? null,
  label: overrides.label ?? "Client review",
  permissions: overrides.permissions ?? ["artifact.view", "comment.read", "comment.write"],
  principal,
  projectId,
  target: overrides.target ?? {kind: "latest"},
}));

const writePolicy = (harness: AccessRuntime, policy: AccessPolicy, expectedRevision = 0) =>
  harness.runtime.runPromise(AccessAdministrationService.use((service) => service.writePolicy({
    expectedRevision,
    policy,
    principal: harness.administrator,
  })));

describe("share links", () => {
  let harness: AccessRuntime;

  beforeEach(async () => {
    harness = await startAccessRuntime();
  });

  afterEach(async () => {
    await harness.stop();
  });

  test("an editor creates a pinned view-and-comment link and lists it", async () => {
    const projectId = await harness.createProject("Design");
    const published = await harness.publish(harness.administrator, projectId);
    const editor = await harness.person("Dana");
    const link = await harness.runtime.runPromise(create(editor, projectId, published.artifact.id, {
      target: {kind: "pinned", versionId: published.version.id},
    }));
    expect(link).toMatchObject({
      createdByName: "Dana",
      generation: 0,
      label: "Client review",
      permissions: ["artifact.view", "comment.read", "comment.write"],
      revision: 1,
      target: {kind: "pinned", versionId: published.version.id},
    });
    expect(link.token).toMatch(/^shr_[0-9a-f]{48}$/u);
    const listed = await harness.runtime.runPromise(ShareLinkService.use((links) =>
      links.listForArtifact({artifactId: published.artifact.id, principal: editor, projectId})));
    expect(listed.map((item) => item.id)).toEqual([link.id]);
  });

  test("a viewer cannot create a link, and a member who cannot see the artifact gets not found", async () => {
    const projectId = await harness.createProject("Design");
    const published = await harness.publish(harness.administrator, projectId);
    const viewer = await harness.person("Vic");
    await harness.grant({memberId: viewer.id, projectId, role: "viewer"});
    expect(await failureTag(harness, create(viewer, projectId, published.artifact.id))).toBe("AuthorizationDenied");
    await harness.setProjectAccess(projectId, "restricted");
    const outsider = await harness.person("Olive");
    expect(await failureTag(harness, create(outsider, projectId, published.artifact.id))).toBe("ProjectNotFound");
  });

  test("permissions beyond the policy, bad expiries, a foreign version and an empty label are refused", async () => {
    const projectId = await harness.createProject("Design");
    const published = await harness.publish(harness.administrator, projectId);
    const other = await harness.publish(harness.administrator, projectId, "Other");
    const admin = harness.administrator;
    const artifactId = published.artifact.id;
    expect(await failureTag(harness, create(admin, projectId, artifactId, {permissions: ["artifact.view", "artifact.publish"]})))
      .toBe("ShareLinkInvalid");
    expect(await failureTag(harness, create(admin, projectId, artifactId, {expiresAt: "2026-10-25T00:00:00.000Z"})))
      .toBe("ShareLinkInvalid");
    expect(await failureTag(harness, create(admin, projectId, artifactId, {
      target: {kind: "pinned", versionId: other.version.id},
    }))).toBe("ShareLinkInvalid");
    expect(await failureTag(harness, create(admin, projectId, artifactId, {label: " \u200B "}))).toBe("ShareLinkInvalid");
    await writePolicy(harness, {...defaultAccessPolicy, shareLinks: {...defaultAccessPolicy.shareLinks, maxExpiryDays: 7}});
    expect(await failureTag(harness, create(admin, projectId, artifactId, {expiresAt: null}))).toBe("ShareLinkInvalid");
    expect(await failureTag(harness, create(admin, projectId, artifactId, {expiresAt: "2026-12-26T00:00:00.000Z"})))
      .toBe("ShareLinkInvalid");
    expect(await failureTag(harness, create(admin, projectId, artifactId, {expiresAt: "2026-10-30T00:00:00.000Z"})))
      .toBeNull();
  });

  test("updating, rotating and revoking a link follow its revision", async () => {
    const projectId = await harness.createProject("Design");
    const published = await harness.publish(harness.administrator, projectId);
    const link = await harness.runtime.runPromise(create(harness.administrator, projectId, published.artifact.id));
    const updated = await harness.runtime.runPromise(ShareLinkService.use((links) => links.update({
      expectedRevision: link.revision,
      expiresAt: null,
      label: "Renamed",
      linkId: link.id,
      permissions: ["artifact.view"],
      principal: harness.administrator,
      projectId,
      target: {kind: "latest"},
    })));
    expect(updated).toMatchObject({label: "Renamed", permissions: ["artifact.view"], revision: 2});
    const rotated = await harness.runtime.runPromise(ShareLinkService.use((links) => links.rotate({
      expectedRevision: updated.revision,
      linkId: link.id,
      principal: harness.administrator,
      projectId,
    })));
    expect(rotated.generation).toBe(1);
    expect(rotated.token).not.toBe(link.token);
    expect(await failureTag(harness, ShareLinkService.use((links) => links.rotate({
      expectedRevision: updated.revision,
      linkId: link.id,
      principal: harness.administrator,
      projectId,
    })))).toBe("AccessRevisionConflict");
    const revoked = await harness.runtime.runPromise(ShareLinkService.use((links) =>
      links.revoke({linkId: link.id, principal: harness.administrator, projectId})));
    expect(revoked.revokedAt).not.toBeNull();
  });

  test("making an artifact private revokes its share links and turns off the bare link", async () => {
    const projectId = await harness.createProject("Design");
    const published = await harness.publish(harness.administrator, projectId);
    const changeAccess = (accessSetting: "account_required" | "public_link") =>
      ArtifactManagementService.use((artifacts) => artifacts.changeAccess({
        accessSetting,
        artifactId: published.artifact.id,
        expectedCurrentVersionId: published.version.id,
        idempotencyKey: `access-${randomUUID()}`,
        principal: harness.administrator,
        projectId,
      }));
    await harness.runtime.runPromise(changeAccess("public_link"));
    const link = await harness.runtime.runPromise(create(harness.administrator, projectId, published.artifact.id));
    const state = await harness.runtime.runPromise(changeAccess("account_required"));
    expect(state.artifact.accessSetting).toBe("account_required");
    const listed = await harness.runtime.runPromise(ShareLinkService.use((links) =>
      links.listForArtifact({artifactId: published.artifact.id, principal: harness.administrator, projectId})));
    expect(listed.find((item) => item.id === link.id)?.revokedAt).not.toBeNull();
  });

  test("a policy that disables share links refuses new links and public links", async () => {
    const projectId = await harness.createProject("Design");
    const published = await harness.publish(harness.administrator, projectId);
    await writePolicy(harness, {...defaultAccessPolicy, shareLinks: {...defaultAccessPolicy.shareLinks, enabled: false}});
    expect(await failureTag(harness, create(harness.administrator, projectId, published.artifact.id)))
      .toBe("ShareLinksDisabled");
    expect(await failureTag(harness, ArtifactManagementService.use((artifacts) => artifacts.changeAccess({
      accessSetting: "public_link",
      artifactId: published.artifact.id,
      expectedCurrentVersionId: published.version.id,
      idempotencyKey: `access-${randomUUID()}`,
      principal: harness.administrator,
      projectId,
    })))).toBe("ShareLinksDisabled");
  });

  test("a policy that reserves links for administrators refuses an editor", async () => {
    const projectId = await harness.createProject("Design");
    const published = await harness.publish(harness.administrator, projectId);
    const editor = await harness.person("Dana");
    await writePolicy(harness, {...defaultAccessPolicy, shareLinks: {...defaultAccessPolicy.shareLinks, linkCreators: "administrators"}});
    expect(await failureTag(harness, create(editor, projectId, published.artifact.id))).toBe("ShareLinksDisabled");
    expect(await failureTag(harness, create(harness.administrator, projectId, published.artifact.id))).toBeNull();
  });

  test("the inventory lists active links for administrators only, and policy narrowing counts them", async () => {
    const projectId = await harness.createProject("Design");
    const published = await harness.publish(harness.administrator, projectId);
    await harness.runtime.runPromise(create(harness.administrator, projectId, published.artifact.id));
    const page = await harness.runtime.runPromise(ShareLinkService.use((links) =>
      links.inventory({cursor: null, limit: 25, principal: harness.administrator})));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.artifactName).toBe(published.artifact.name);
    const member = await harness.person("Sam");
    expect(await failureTag(harness, ShareLinkService.use((links) =>
      links.inventory({cursor: null, limit: 25, principal: member})))).toBe("AuthorizationDenied");
    const written = await writePolicy(harness, {
      ...defaultAccessPolicy,
      shareLinks: {...defaultAccessPolicy.shareLinks, guestPermissionsMax: ["artifact.view"]},
    });
    expect(written.narrowed.shareLinks).toBe(1);
  });
});
