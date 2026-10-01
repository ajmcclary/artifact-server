import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";
import {z} from "zod";

import {systemAttribution} from "../../../src/core/action-attribution.js";
import {memberAdmissions} from "../../../src/core/identity-ports.js";
import {createD1ArtifactRepository} from "../src/d1-artifact-repository.js";
import {createD1IdentityRepository} from "../src/d1-identity-repository.js";
import {migrateD1} from "../src/d1-migrations.js";

const openLocalD1 = () => getPlatformProxy<{
  ARTIFACT_SERVER_D1_DATABASE: D1Database;
}>({
  configPath: fileURLToPath(new URL("../wrangler.git-store.test.jsonc", import.meta.url)),
  envFiles: [],
  persist: false,
  remoteBindings: false,
});

const administrator = {
  actor: {displayName: "Rosa Santoro", kind: "human"},
  authorizedByPrincipalId: null,
  principalId: "member_rosa",
} as const;

const rowSchema = z.object({
  action: z.string(),
  actorName: z.string().nullable(),
  detailJson: z.string().nullable(),
  principalId: z.string().nullable(),
  projectId: z.string().nullable(),
  subjectId: z.string().nullable(),
});

describe("D1 activity-log writes", () => {
  it("member, key and project administration each append one attributed row, and no-ops append none", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-activity-log-writes";
    try {
      await migrateD1(binding, installationId);
      const identity = createD1IdentityRepository(binding);
      const artifacts = createD1ArtifactRepository(binding, installationId);
      await identity.admitMember({
        admittedHow: memberAdmissions.owner,
        attribution: systemAttribution,
        createdAt: "2026-10-01T10:00:00.000Z",
        displayName: "Rosa Santoro",
        email: "rosa@example.test",
        id: "member_rosa",
        installationId,
        role: "administrator",
      });
      await identity.admitMember({
        admittedHow: memberAdmissions.manual,
        attribution: administrator,
        createdAt: "2026-10-01T10:01:00.000Z",
        displayName: "Dana Okonkwo",
        email: "dana@example.test",
        id: "member_dana",
        installationId,
        role: "member",
      });
      const key = {
        authorizedByPrincipalId: "member_rosa",
        capabilities: ["artifact:read"] as const,
        createdAt: "2026-10-01T10:02:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        id: "key_release",
        installationId,
        name: "Release key",
        prefix: "as_key_key_release_",
        principalId: "service:key_release",
        principalKind: "service" as const,
        revokedAt: null,
        rotatedFromId: null,
        secretDigest: "digest-release",
      };
      await identity.createApiKey(key, administrator);
      await identity.revokeApiKey(installationId, key.id, "2026-10-01T10:03:00.000Z", administrator);
      await identity.revokeApiKey(installationId, key.id, "2026-10-01T10:04:00.000Z", administrator);
      await identity.deactivateMember(installationId, "member_dana", "2026-10-01T10:05:00.000Z", administrator);
      await artifacts.createProject({
        archivedAt: null,
        attribution: administrator,
        createdAt: "2026-10-01T10:06:00.000Z",
        id: "prj_claims",
        installationId,
        name: "Claims workstation",
      });
      await artifacts.setProjectArchive({
        archivedAt: "2026-10-01T10:07:00.000Z",
        attribution: administrator,
        changedAt: "2026-10-01T10:07:00.000Z",
        projectId: "prj_claims",
      });
      await artifacts.setProjectArchive({
        archivedAt: "2026-10-01T10:08:00.000Z",
        attribution: administrator,
        changedAt: "2026-10-01T10:08:00.000Z",
        projectId: "prj_claims",
      });
      await artifacts.setProjectArchive({
        archivedAt: null,
        attribution: administrator,
        changedAt: "2026-10-01T10:09:00.000Z",
        projectId: "prj_claims",
      });

      const rows = z.array(rowSchema).parse((await binding.prepare(`
        SELECT action, actor_name AS actorName, detail_json AS detailJson,
          principal_id AS principalId, project_id AS projectId, subject_id AS subjectId
        FROM actions WHERE artifact_id IS NULL AND id NOT LIKE 'recovered:%'
        ORDER BY created_at, id
      `).all()).results);
      expect(rows.map((row) => [row.action, row.subjectId, row.principalId, row.projectId])).toEqual([
        ["member_admit", "member_rosa", null, null],
        ["member_admit", "member_dana", "member_rosa", null],
        ["key_issue", "key_release", "member_rosa", null],
        ["key_revoke", "key_release", "member_rosa", null],
        ["member_deactivate", "member_dana", "member_rosa", null],
        ["project_create", "prj_claims", "member_rosa", "prj_claims"],
        ["project_archive", "prj_claims", "member_rosa", "prj_claims"],
        ["project_unarchive", "prj_claims", "member_rosa", "prj_claims"],
      ]);
      expect(JSON.parse(rows[1]?.detailJson ?? "null"))
        .toEqual({how: "manual", role: "member", subjectName: "Dana Okonkwo"});
      expect(rows[1]?.actorName).toBe("Rosa Santoro");
    } finally {
      await proxy.dispose();
    }
  });
});
