import {randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {systemAttribution} from "../../src/core/action-attribution.js";
import {memberAdmissions} from "../../src/core/identity-ports.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {PostgresIdentityRepository} from "../../src/storage/postgres-identity-repository.js";

const administrator = {
  actor: {displayName: "Rosa Santoro", kind: "human"},
  authorizedByPrincipalId: null,
  principalId: "member_rosa",
} as const;

const rowSchema = z.object({
  action: z.string(),
  actorName: z.string().nullable(),
  detailJson: z.string().nullable(),
  idempotencyKey: z.string(),
  principalId: z.string().nullable(),
  projectId: z.string().nullable(),
  subjectId: z.string().nullable(),
});

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

describe("Postgres activity-log writes", () => {
  const scratch = `artifact_activity_writes_${randomUUID().replaceAll("-", "")}`;
  const installationId = `test-activity-writes-${randomUUID()}`;
  let maintenance: PostgresDatabase;
  let database: PostgresDatabase;
  let artifacts: PostgresArtifactRepository;
  let identity: PostgresIdentityRepository;

  beforeEach(async () => {
    maintenance = await PostgresDatabase.inspect({url: Redacted.make(readDatabaseUrl())});
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));
    const scratchUrl = new URL(readDatabaseUrl());
    scratchUrl.pathname = `/${scratch}`;
    database = await PostgresDatabase.open({url: Redacted.make(scratchUrl.toString())}, "apply");
    artifacts = await PostgresArtifactRepository.open(database, installationId);
    identity = new PostgresIdentityRepository(database, installationId);
  });

  afterEach(async () => {
    await database.close();
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }));
    await maintenance.close();
  });

  test("member, key and project administration each append one attributed row, and no-ops append none", async () => {
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

    const rows = await readRows();
    expect(rows.map((row) => [row.action, row.subjectId, row.principalId, row.projectId])).toEqual([
      ["member_admit", "member_rosa", null, null],
      ["member_admit", "member_dana", "member_rosa", null],
      ["key_issue", "key_release", "member_rosa", null],
      ["key_revoke", "key_release", "member_rosa", null],
      ["member_deactivate", "member_dana", "member_rosa", null],
      ["project_create", "prj_claims", "member_rosa", "prj_claims"],
      ["project_archive", "prj_claims", "member_rosa", "prj_claims"],
    ]);
    expect(JSON.parse(rows[1]?.detailJson ?? "null"))
      .toEqual({how: "manual", role: "member", subjectName: "Dana Okonkwo"});
    expect(rows[1]?.actorName).toBe("Rosa Santoro");
  });

  async function readRows(): Promise<z.infer<typeof rowSchema>[]> {
    return database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const result = yield* sql.unsafe<object>(
        `SELECT action, actor_name AS "actorName", detail_json::text AS "detailJson",
           idempotency_key AS "idempotencyKey", principal_id AS "principalId",
           project_id AS "projectId", subject_id AS "subjectId"
         FROM actions WHERE installation_id = $1 AND artifact_id IS NULL
         ORDER BY created_at, id`,
        [installationId],
      );
      return z.array(rowSchema).parse(result);
    }));
  }
});
