// tests/support/access-repository-cases.ts
import assert from "node:assert/strict";
import {createHash} from "node:crypto";

import type {AccessGrantDraft, AccessRepository} from "../../src/core/access-ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import type {
  ArtifactRepository,
  CommentRepository,
  StagedUploadRepository,
} from "../../src/core/ports.js";
import type {ShareLinkDraft, ShareLinkRepository} from "../../src/core/share-link-ports.js";
import type {ShareLink} from "../../src/core/share-links.js";
import {defaultAccessPolicy} from "../../src/core/access-policy.js";

/** One backend's access store plus the hooks the shared cases need. */
export interface AccessFixture {
  readonly actions: () => Promise<readonly {
    readonly action: string;
    readonly projectId: string | null;
    readonly subjectId: string | null;
  }[]>;
  readonly installationId: string;
  /** A second installation's store over the same database, or null when the backend has one installation per file. */
  readonly otherInstallation: (() => Promise<{readonly installationId: string; readonly store: AccessRepository}>) | null;
  readonly seedProject: (projectId: string, archived?: boolean) => Promise<void>;
  readonly store: AccessRepository;
}

export const caseManager = {
  actor: {displayName: "Jordan Lee", kind: "human"},
  authorizedByPrincipalId: null,
  principalId: "mem_admin",
} as const;

export function caseGrant(overrides: Partial<AccessGrantDraft> = {}): AccessGrantDraft {
  return {
    add: [],
    artifactId: null,
    createdByPrincipalId: "mem_admin",
    expiresAt: null,
    id: "grt_00000000000000000000000001",
    memberId: "mem_dana",
    projectId: "prj_access",
    remove: [],
    role: "viewer",
    ...overrides,
  };
}

async function upsert(
  fixture: AccessFixture,
  grant: AccessGrantDraft,
  expectedRevision: number | null,
) {
  return fixture.store.upsertGrant({
    attribution: caseManager,
    expectedRevision,
    grant,
    installationId: fixture.installationId,
  });
}

export const accessRepositoryCases: readonly {
  readonly name: string;
  readonly run: (fixture: AccessFixture) => Promise<void>;
}[] = [
  {
    name: "existing projects read as open editor revision 0",
    run: async (fixture) => {
      await fixture.seedProject("prj_access");
      const access = await fixture.store.readProjectAccess(fixture.installationId, "prj_access");
      assert.deepEqual(access, {
        accessMode: "open",
        archived: false,
        defaultMemberRole: "editor",
        projectId: "prj_access",
        revision: 0,
      });
      const all = await fixture.store.listProjectAccess(fixture.installationId);
      assert.ok(all.some((project) => project.projectId === "prj_access"));
      assert.equal(await fixture.store.readProjectAccess(fixture.installationId, "prj_missing"), null);
    },
  },
  {
    name: "archived projects read as archived",
    run: async (fixture) => {
      await fixture.seedProject("prj_access", true);
      const access = await fixture.store.readProjectAccess(fixture.installationId, "prj_access");
      assert.equal(access?.archived, true);
    },
  },
  {
    name: "policy defaults then round-trips with revision 1 and writes policy_change",
    run: async (fixture) => {
      const initial = await fixture.store.readAccessPolicy(fixture.installationId);
      assert.deepEqual(initial, {
        policy: defaultAccessPolicy,
        revision: 0,
        updatedAt: null,
        updatedByPrincipalId: null,
      });
      const policy = {
        ...defaultAccessPolicy,
        shareLinks: {...defaultAccessPolicy.shareLinks, maxExpiryDays: 30},
      };
      const written = await fixture.store.writeAccessPolicy({
        attribution: caseManager,
        expectedRevision: 0,
        installationId: fixture.installationId,
        policy,
      });
      assert.notEqual(written, "conflict");
      assert.equal(written === "conflict" ? null : written.revision, 1);
      const reread = await fixture.store.readAccessPolicy(fixture.installationId);
      assert.deepEqual(reread.policy, policy);
      assert.equal(reread.revision, 1);
      assert.equal(reread.updatedByPrincipalId, "mem_admin");
      const actions = await fixture.actions();
      assert.deepEqual(
        actions.filter((action) => action.action === "policy_change"),
        [{action: "policy_change", projectId: null, subjectId: null}],
      );
    },
  },
  {
    name: "policy write with stale revision conflicts",
    run: async (fixture) => {
      const first = await fixture.store.writeAccessPolicy({
        attribution: caseManager,
        expectedRevision: 0,
        installationId: fixture.installationId,
        policy: defaultAccessPolicy,
      });
      assert.notEqual(first, "conflict");
      const stale = await fixture.store.writeAccessPolicy({
        attribution: caseManager,
        expectedRevision: 0,
        installationId: fixture.installationId,
        policy: defaultAccessPolicy,
      });
      assert.equal(stale, "conflict");
    },
  },
  {
    name: "project access write records project_access_change and bumps revision",
    run: async (fixture) => {
      await fixture.seedProject("prj_access");
      const written = await fixture.store.writeProjectAccess({
        accessMode: "restricted",
        attribution: caseManager,
        defaultMemberRole: "viewer",
        expectedRevision: 0,
        installationId: fixture.installationId,
        projectId: "prj_access",
      });
      assert.deepEqual(written, {
        accessMode: "restricted",
        archived: false,
        defaultMemberRole: "viewer",
        projectId: "prj_access",
        revision: 1,
      });
      const stale = await fixture.store.writeProjectAccess({
        accessMode: "open",
        attribution: caseManager,
        defaultMemberRole: "editor",
        expectedRevision: 0,
        installationId: fixture.installationId,
        projectId: "prj_access",
      });
      assert.equal(stale, "conflict");
      const actions = await fixture.actions();
      assert.deepEqual(
        actions.filter((action) => action.action === "project_access_change"),
        [{action: "project_access_change", projectId: "prj_access", subjectId: "prj_access"}],
      );
    },
  },
  {
    name: "grant upsert creates then updates with revision and records grant_create then grant_update",
    run: async (fixture) => {
      await fixture.seedProject("prj_access");
      const created = await upsert(fixture, caseGrant({add: ["comment.write"]}), null);
      assert.notEqual(created, "conflict");
      if (created === "conflict") return;
      assert.equal(created.revision, 1);
      assert.deepEqual(created.add, ["comment.write"]);
      assert.equal(created.createdAt, created.updatedAt);
      const updated = await upsert(fixture, caseGrant({role: "manager"}), 1);
      assert.notEqual(updated, "conflict");
      if (updated === "conflict") return;
      assert.equal(updated.revision, 2);
      assert.equal(updated.role, "manager");
      assert.deepEqual(updated.add, []);
      assert.equal(updated.createdAt, created.createdAt);
      const kinds = (await fixture.actions())
        .filter((action) => action.action.startsWith("grant_"))
        .map((action) => [action.action, action.projectId, action.subjectId]);
      assert.deepEqual(kinds, [
        ["grant_create", "prj_access", "mem_dana"],
        ["grant_update", "prj_access", "mem_dana"],
      ]);
    },
  },
  {
    name: "grant upsert with stale revision conflicts",
    run: async (fixture) => {
      await fixture.seedProject("prj_access");
      assert.notEqual(await upsert(fixture, caseGrant(), null), "conflict");
      assert.notEqual(await upsert(fixture, caseGrant({role: "commenter"}), 1), "conflict");
      assert.equal(await upsert(fixture, caseGrant({role: "editor"}), 1), "conflict");
      assert.equal(
        await upsert(fixture, caseGrant({id: "grt_00000000000000000000000002"}), null),
        "conflict",
        "a second project grant for the same member is a conflict, not a duplicate",
      );
    },
  },
  {
    name: "artifact grant and project grant for one member coexist and findSubjectGrants returns both",
    run: async (fixture) => {
      await fixture.seedProject("prj_access");
      await upsert(fixture, caseGrant({role: "viewer"}), null);
      await upsert(fixture, caseGrant({
        artifactId: "art_1",
        id: "grt_00000000000000000000000002",
        role: "commenter",
      }), null);
      await upsert(fixture, caseGrant({
        artifactId: "art_2",
        id: "grt_00000000000000000000000003",
        role: "editor",
      }), null);
      const found = await fixture.store.findSubjectGrants({
        artifactId: "art_1",
        installationId: fixture.installationId,
        memberId: "mem_dana",
        projectId: "prj_access",
      });
      assert.equal(found.projectGrant?.role, "viewer");
      assert.deepEqual(found.artifactGrants.map((grant) => grant.artifactId), ["art_1"]);
      const projectOnly = await fixture.store.findSubjectGrants({
        artifactId: null,
        installationId: fixture.installationId,
        memberId: "mem_dana",
        projectId: "prj_access",
      });
      assert.deepEqual(projectOnly.artifactGrants, []);
      const projectGrants = await fixture.store.listProjectGrants(fixture.installationId, "prj_access");
      assert.equal(projectGrants.length, 3);
    },
  },
  {
    name: "deleteGrant missing, conflict, deleted",
    run: async (fixture) => {
      await fixture.seedProject("prj_access");
      const missing = await fixture.store.deleteGrant({
        attribution: caseManager,
        expectedRevision: 1,
        grantId: "grt_missing",
        installationId: fixture.installationId,
      });
      assert.equal(missing, "missing");
      const created = await upsert(fixture, caseGrant(), null);
      assert.notEqual(created, "conflict");
      const conflict = await fixture.store.deleteGrant({
        attribution: caseManager,
        expectedRevision: 7,
        grantId: caseGrant().id,
        installationId: fixture.installationId,
      });
      assert.equal(conflict, "conflict");
      const deleted = await fixture.store.deleteGrant({
        attribution: caseManager,
        expectedRevision: 1,
        grantId: caseGrant().id,
        installationId: fixture.installationId,
      });
      assert.equal(deleted, "deleted");
      assert.deepEqual(await fixture.store.listMemberGrants(fixture.installationId, "mem_dana"), []);
      const actions = await fixture.actions();
      assert.ok(actions.some((action) => action.action === "grant_delete" && action.subjectId === "mem_dana"));
    },
  },
  {
    name: "listMemberGrants spans projects",
    run: async (fixture) => {
      await fixture.seedProject("prj_access");
      await fixture.seedProject("prj_other");
      await upsert(fixture, caseGrant(), null);
      await upsert(fixture, caseGrant({id: "grt_00000000000000000000000002", projectId: "prj_other"}), null);
      await upsert(fixture, caseGrant({id: "grt_00000000000000000000000003", memberId: "mem_sam"}), null);
      const grants = await fixture.store.listMemberGrants(fixture.installationId, "mem_dana");
      assert.deepEqual(grants.map((grant) => grant.projectId).toSorted(), ["prj_access", "prj_other"]);
    },
  },
  {
    name: "an installation never reads another installation's grants",
    run: async (fixture) => {
      if (fixture.otherInstallation === null) return;
      await fixture.seedProject("prj_access");
      await upsert(fixture, caseGrant(), null);
      const other = await fixture.otherInstallation();
      assert.deepEqual(await other.store.listMemberGrants(other.installationId, "mem_dana"), []);
      assert.equal(await other.store.readProjectAccess(other.installationId, "prj_access"), null);
      const found = await other.store.findSubjectGrants({
        artifactId: null,
        installationId: other.installationId,
        memberId: "mem_dana",
        projectId: "prj_access",
      });
      assert.equal(found.projectGrant, null);
    },
  },
];

/** The repository slices the share-link cases need to publish real artifacts and comments. */
export type SeedStores =
  & Pick<ArtifactRepository, "commitNewArtifact">
  & Pick<StagedUploadRepository,
    | "claimUploadPreparation"
    | "createStagedUpload"
    | "markStagedFileUploaded"
    | "markUploadPrepared"
    | "recordStagedFileInstalled"
    | "writePreparedManifestEntries">
  & Pick<CommentRepository, "createReply" | "createThread" | "findThread" | "listReplies">;

/** One backend's share-link store plus the hooks the shared cases need. */
export interface ShareLinkFixture {
  readonly actions: AccessFixture["actions"];
  readonly artifacts: SeedStores;
  readonly installationId: string;
  readonly seedProject: AccessFixture["seedProject"];
  readonly store: ShareLinkRepository;
}

/** Publish one small artifact through the repository, as a staged upload would. */
export async function seedPublishedArtifact(
  artifacts: SeedStores,
  projectId: string,
  artifactId: string,
  versionId: string,
): Promise<void> {
  const principalId = "mem_admin";
  const createdAt = "2026-10-26T10:30:00.000Z";
  const bytes = new TextEncoder().encode(`<!doctype html><title>${artifactId}</title>`);
  const manifest = createManifest({
    entryPath: "index.html",
    files: [{
      mediaType: "text/html",
      path: "index.html",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    }],
    routingMode: "static",
  });
  const uploadId = `upl_${artifactId}`;
  const storageToken = `tok_${artifactId}`;
  await artifacts.createStagedUpload({
    createdAt,
    expiresAt: "2099-12-31T00:00:00.000Z",
    files: manifest.entries.map((entry) => ({entry, storageToken})),
    id: uploadId,
    idempotencyKey: `seed-${artifactId}`,
    manifest,
    principalId,
    projectId,
  });
  await artifacts.markStagedFileUploaded(projectId, uploadId, principalId, storageToken, createdAt);
  const claim = await artifacts.claimUploadPreparation(uploadId, createdAt, "2099-12-30T00:00:00.000Z");
  if (claim === null) throw new Error("The seed upload could not be claimed.");
  await artifacts.recordStagedFileInstalled(uploadId, storageToken, claim.attempts, createdAt);
  await artifacts.writePreparedManifestEntries(uploadId, claim.attempts, manifest.entries);
  await artifacts.markUploadPrepared(uploadId, claim.attempts, createdAt);
  await artifacts.commitNewArtifact({
    accessSetting: "account_required",
    actor: {displayName: "Jordan Lee", kind: "human"},
    artifactId,
    authorizedByPrincipalId: null,
    contentToken: `content-${artifactId}`,
    createdAt,
    idempotencyKey: `seed-publish-${artifactId}`,
    inputDigest: manifest.digest,
    manifest,
    name: artifactId,
    principalId,
    projectId,
    source: {kind: "staged_upload", principalId, projectId, uploadId},
    tags: [],
    versionId,
  });
}

async function seedShared(fixture: ShareLinkFixture): Promise<void> {
  await fixture.seedProject("prj_access");
  await seedPublishedArtifact(fixture.artifacts, "prj_access", "art_shared", "ver_shared");
}

export function caseShareLink(overrides: Partial<ShareLinkDraft> = {}): ShareLinkDraft {
  return {
    artifactId: "art_shared",
    createdAt: "2026-10-26T11:00:00.000Z",
    createdByName: "Jordan Lee",
    createdByPrincipalId: "mem_admin",
    expiresAt: null,
    id: "shl_000000000000000000000001",
    label: "Client review",
    permissions: ["artifact.view", "comment.read", "comment.write"],
    projectId: "prj_access",
    target: {kind: "latest"},
    token: "shr_000000000000000000000000000000000000000000000001",
    ...overrides,
  };
}

const guestAttribution = {
  actor: {displayName: "Guest", kind: "guest"},
  authorizedByPrincipalId: "mem_admin",
  principalId: "guest:gst_000000000000000000000001",
} as const;

/** The link a store call returned, failing the case on "conflict" or "missing". */
function linkOf(result: ShareLink | "conflict" | "missing"): ShareLink {
  if (result === "conflict" || result === "missing") throw new Error(`Expected a share link, got ${result}.`);
  return result;
}

async function createLink(fixture: ShareLinkFixture, overrides: Partial<ShareLinkDraft> = {}) {
  return fixture.store.createShareLink({
    attribution: caseManager,
    installationId: fixture.installationId,
    link: caseShareLink(overrides),
    versionId: "ver_shared",
  });
}

async function joinGuest(fixture: ShareLinkFixture, guestId: string, generation: number, tokenDigest: string) {
  await fixture.store.createGuest({
    attribution: {...guestAttribution, principalId: guestId},
    guest: {
      contactEmail: null,
      createdAt: "2026-10-26T11:10:00.000Z",
      displayName: null,
      generation,
      id: guestId,
      shareLinkId: caseShareLink().id,
    },
    installationId: fixture.installationId,
    session: {
      csrfDigest: `csrf-${tokenDigest}`,
      expiresAt: "2026-11-25T11:10:00.000Z",
      guestId,
      id: `gss_${tokenDigest}`,
      revokedAt: null,
      tokenDigest,
    },
    versionId: "ver_shared",
  });
}

export const shareLinkRepositoryCases: readonly {
  readonly name: string;
  readonly run: (fixture: ShareLinkFixture) => Promise<void>;
}[] = [
  {
    name: "create, find by token, list for artifact",
    run: async (fixture) => {
      await seedShared(fixture);
      const created = await createLink(fixture);
      assert.deepEqual(
        {generation: created.generation, guestCount: created.guestCount, revision: created.revision, revokedAt: created.revokedAt},
        {generation: 0, guestCount: 0, revision: 1, revokedAt: null},
      );
      const byToken = await fixture.store.findShareLinkByToken(caseShareLink().token);
      assert.equal(byToken?.id, created.id);
      assert.equal(byToken?.installationId, fixture.installationId);
      assert.deepEqual(byToken?.permissions, ["artifact.view", "comment.read", "comment.write"]);
      await createLink(fixture, {
        id: "shl_000000000000000000000002",
        target: {kind: "pinned", versionId: "ver_pinned"},
        token: "shr_000000000000000000000000000000000000000000000002",
      });
      const listed = await fixture.store.listArtifactShareLinks(fixture.installationId, "prj_access", "art_shared");
      assert.deepEqual(listed.map((link) => link.target), [{kind: "latest"}, {kind: "pinned", versionId: "ver_pinned"}]);
      assert.equal(await fixture.store.findShareLinkByToken("shr_missing"), null);
      const actions = await fixture.actions();
      assert.equal(actions.filter((action) => action.action === "share_link_create").length, 2);
    },
  },
  {
    name: "update changes label, permissions, expiry and target with revision",
    run: async (fixture) => {
      await seedShared(fixture);
      await createLink(fixture);
      const command = {
        attribution: caseManager,
        expectedRevision: 1,
        expiresAt: "2026-11-01T00:00:00.000Z",
        installationId: fixture.installationId,
        label: "Renamed",
        linkId: caseShareLink().id,
        permissions: ["artifact.view"] as const,
        target: {kind: "pinned", versionId: "ver_shared"} as const,
        versionId: "ver_shared",
      };
      const updated = linkOf(await fixture.store.updateShareLink(command));
      assert.equal(updated.revision, 2);
      assert.equal(updated.label, "Renamed");
      assert.deepEqual(updated.permissions, ["artifact.view"]);
      assert.deepEqual(updated.target, {kind: "pinned", versionId: "ver_shared"});
      assert.equal(await fixture.store.updateShareLink(command), "conflict");
      assert.equal(await fixture.store.updateShareLink({...command, linkId: "shl_missing"}), "missing");
    },
  },
  {
    name: "rotate bumps generation and the old guest no longer matches",
    run: async (fixture) => {
      await seedShared(fixture);
      await createLink(fixture);
      await joinGuest(fixture, "guest:gst_000000000000000000000001", 0, "digest-one");
      const before = await fixture.store.findShareLink(fixture.installationId, caseShareLink().id);
      assert.equal(before?.guestCount, 1);
      const rotated = linkOf(await fixture.store.rotateShareLink({
        attribution: caseManager,
        expectedRevision: 1,
        installationId: fixture.installationId,
        linkId: caseShareLink().id,
        token: "shr_rotated00000000000000000000000000000000000000000",
        versionId: "ver_shared",
      }));
      assert.equal(rotated.generation, 1);
      assert.equal(rotated.guestCount, 0);
      assert.equal(await fixture.store.findShareLinkByToken(caseShareLink().token), null);
      const found = await fixture.store.findGuest(fixture.installationId, "guest:gst_000000000000000000000001");
      assert.equal(found?.guest.generation, 0);
      assert.equal(found?.link.generation, 1);
    },
  },
  {
    name: "revoke and revokeArtifactShareLinks revoke only their scope",
    run: async (fixture) => {
      await seedShared(fixture);
      await seedPublishedArtifact(fixture.artifacts, "prj_access", "art_other", "ver_other");
      await createLink(fixture);
      await createLink(fixture, {
        artifactId: "art_other",
        id: "shl_000000000000000000000002",
        token: "shr_000000000000000000000000000000000000000000000002",
      });
      await createLink(fixture, {
        id: "shl_000000000000000000000003",
        token: "shr_000000000000000000000000000000000000000000000003",
      });
      const revoked = linkOf(await fixture.store.revokeShareLink({
        attribution: caseManager,
        installationId: fixture.installationId,
        linkId: caseShareLink().id,
        versionId: "ver_shared",
      }));
      assert.notEqual(revoked.revokedAt, null);
      const count = await fixture.store.revokeArtifactShareLinks({
        artifactId: "art_shared",
        attribution: caseManager,
        installationId: fixture.installationId,
        projectId: "prj_access",
        versionId: "ver_shared",
      });
      assert.equal(count, 1);
      const other = await fixture.store.findShareLink(fixture.installationId, "shl_000000000000000000000002");
      assert.equal(other?.revokedAt, null);
      assert.equal(
        await fixture.store.revokeShareLink({
          attribution: caseManager,
          installationId: fixture.installationId,
          linkId: "shl_missing",
          versionId: "ver_shared",
        }),
        "missing",
      );
    },
  },
  {
    name: "listActiveShareLinks skips revoked and expired and pages by cursor",
    run: async (fixture) => {
      await seedShared(fixture);
      for (const [index, overrides] of [
        {},
        {expiresAt: "2026-10-26T11:30:00.000Z"},
        {},
        {},
      ].entries()) {
        // eslint-disable-next-line no-await-in-loop -- links are created in a fixed order
        await createLink(fixture, {
          ...overrides,
          createdAt: `2026-10-26T11:0${index}:00.000Z`,
          id: `shl_00000000000000000000000${index}`,
          token: `shr_00000000000000000000000000000000000000000000000${index}`,
        });
      }
      await fixture.store.revokeShareLink({
        attribution: caseManager,
        installationId: fixture.installationId,
        linkId: "shl_000000000000000000000002",
        versionId: "ver_shared",
      });
      const first = await fixture.store.listActiveShareLinks({
        cursor: null,
        installationId: fixture.installationId,
        limit: 1,
        now: "2026-10-26T12:00:00.000Z",
      });
      assert.equal(first.items.length, 1);
      assert.notEqual(first.nextCursor, null);
      const rest = await fixture.store.listActiveShareLinks({
        cursor: first.nextCursor,
        installationId: fixture.installationId,
        limit: 10,
        now: "2026-10-26T12:00:00.000Z",
      });
      const ids = [...first.items, ...rest.items].map((link) => link.id).toSorted();
      assert.deepEqual(ids, ["shl_000000000000000000000000", "shl_000000000000000000000003"]);
      assert.equal(rest.nextCursor, null);
    },
  },
  {
    name: "createGuest writes guest_join and the session round-trips by digest",
    run: async (fixture) => {
      await seedShared(fixture);
      await createLink(fixture);
      await joinGuest(fixture, "guest:gst_000000000000000000000001", 0, "digest-one");
      const found = await fixture.store.findGuestSession(fixture.installationId, "digest-one");
      assert.equal(found?.guest.id, "guest:gst_000000000000000000000001");
      assert.equal(found?.session.csrfDigest, "csrf-digest-one");
      assert.equal(found?.link.id, caseShareLink().id);
      assert.equal(await fixture.store.findGuestSession(fixture.installationId, "digest-missing"), null);
      const named = await fixture.store.setGuestIdentity({
        contactEmail: "pat@client.test",
        displayName: "Pat",
        guestId: "guest:gst_000000000000000000000001",
        installationId: fixture.installationId,
      });
      assert.equal(named.displayName, "Pat");
      const actions = await fixture.actions();
      assert.deepEqual(
        actions.filter((action) => action.action === "guest_join").map((action) => action.subjectId),
        [caseShareLink().id],
      );
    },
  },
  {
    name: "a comment and reply authored by a guest read back as a guest",
    run: async (fixture) => {
      await seedShared(fixture);
      const guest = {
        authorizedByPrincipalId: "mem_admin",
        displayName: "Pat",
        principalId: "guest:gst_000000000000000000000009",
        principalKind: "guest",
      } as const;
      await fixture.artifacts.createThread({
        anchor: null,
        artifactId: "art_shared",
        author: guest,
        body: "From the client.",
        createdAt: "2026-10-26T11:20:00.000Z",
        id: "cmt_guest_000000000000000000001",
        idempotencyKey: "guest-thread-0000000001",
        installationId: fixture.installationId,
        path: null,
        projectId: "prj_access",
        versionId: "ver_shared",
      });
      await fixture.artifacts.createReply({
        artifactId: "art_shared",
        author: guest,
        body: "And a follow-up.",
        createdAt: "2026-10-26T11:21:00.000Z",
        id: "rpl_guest_000000000000000000001",
        idempotencyKey: "guest-reply-00000000001",
        projectId: "prj_access",
        threadId: "cmt_guest_000000000000000000001",
      });
      const thread = await fixture.artifacts.findThread("prj_access", "art_shared", "cmt_guest_000000000000000000001");
      assert.equal(thread?.author.principalKind, "guest");
      const replies = await fixture.artifacts.listReplies("cmt_guest_000000000000000000001");
      assert.deepEqual(replies.map((reply) => reply.author.principalKind), ["guest"]);
    },
  },
];
