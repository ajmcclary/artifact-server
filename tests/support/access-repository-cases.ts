// tests/support/access-repository-cases.ts
import assert from "node:assert/strict";

import type {AccessGrantDraft, AccessRepository} from "../../src/core/access-ports.js";
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
