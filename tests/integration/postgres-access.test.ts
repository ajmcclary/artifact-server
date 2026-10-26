// tests/integration/postgres-access.test.ts
import {randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {PostgresAccessRepository} from "../../src/storage/postgres-access-repository.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {requiredPostgresSchemaVersion} from "../../src/storage/postgres-migrations.js";
import {
  accessRepositoryCases,
  caseManager,
  type AccessFixture,
} from "../support/access-repository-cases.js";

const clock = {now: () => new Date("2026-10-26T12:00:00.000Z")};

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

describe("Postgres access repository", () => {
  let scratch: string;
  let installationId: string;
  let maintenance: PostgresDatabase;
  let database: PostgresDatabase;
  let artifacts: PostgresArtifactRepository;
  let fixture: AccessFixture;
  let scratchUrl: URL;

  beforeEach(async () => {
    scratch = `artifact_access_${randomUUID().replaceAll("-", "")}`;
    installationId = `test-access-${randomUUID()}`;
    maintenance = await PostgresDatabase.inspect({url: Redacted.make(readDatabaseUrl())});
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));
    scratchUrl = new URL(readDatabaseUrl());
    scratchUrl.pathname = `/${scratch}`;
    database = await PostgresDatabase.open({url: Redacted.make(scratchUrl.toString())}, "apply");
    artifacts = await PostgresArtifactRepository.open(database, installationId);
    fixture = {
      actions: () => database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        return yield* sql.unsafe<{action: string; projectId: string | null; subjectId: string | null}>(
          `SELECT action, project_id AS "projectId", subject_id AS "subjectId" FROM actions
           WHERE installation_id = $1 ORDER BY created_at, action`,
          [installationId],
        );
      })),
      installationId,
      otherInstallation: async () => {
        const otherId = `test-access-other-${randomUUID()}`;
        await PostgresArtifactRepository.open(database, otherId);
        return {installationId: otherId, store: new PostgresAccessRepository(database, clock)};
      },
      seedProject: async (projectId, archived = false) => {
        await artifacts.createProject({
          archivedAt: null,
          attribution: caseManager,
          createdAt: "2026-10-26T11:00:00.000Z",
          id: projectId,
          installationId,
          name: projectId,
        });
        if (archived) {
          await artifacts.setProjectArchive({
            archivedAt: "2026-10-26T11:30:00.000Z",
            attribution: caseManager,
            changedAt: "2026-10-26T11:30:00.000Z",
            projectId,
          });
        }
      },
      store: new PostgresAccessRepository(database, clock),
    };
  });

  afterEach(async () => {
    await database.close();
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }));
    await maintenance.close();
  });

  test.for(accessRepositoryCases)("$name", async ({run}) => {
    await expect(run(fixture)).resolves.toBeUndefined();
  });

  test("the database refuses a none-role artifact grant written directly", async () => {
    await fixture.seedProject("prj_access");
    await expect(database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`INSERT INTO access_grants (
        installation_id, id, project_id, artifact_id, member_id, role,
        created_at, created_by_principal_id, updated_at, revision
      ) VALUES ($1, 'g_bad', 'prj_access', 'art_1', 'mem_x', 'none', 'x', 'm', 'x', 1)`,
      [installationId]);
    }))).rejects.toBeDefined();
  });

  test("migration 0025 upgrades a populated schema-24 database with every project open/editor and every key unscoped", async () => {
    await fixture.seedProject("prj_second");
    await database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`INSERT INTO managed_api_keys (
        installation_id, id, name, prefix, secret_digest, principal_id, principal_kind,
        capabilities_json, authorized_by_principal_id, created_at, expires_at
      ) VALUES ($1, 'key_upgrade', 'Reader', 'as_key_upgrade', 'digest', 'service:key_upgrade',
        'service', '["artifact:read"]', 'mem_admin', 'x', 'y')`, [installationId]);
      // Return the database to schema 24.
      yield* sql.unsafe("DROP TABLE access_grants");
      yield* sql.unsafe("DROP TABLE installation_access_policy");
      yield* sql.unsafe(`ALTER TABLE projects
        DROP COLUMN access_mode, DROP COLUMN default_member_role, DROP COLUMN access_revision`);
      yield* sql.unsafe("ALTER TABLE managed_api_keys DROP COLUMN project_ids_json");
      yield* sql.unsafe("DELETE FROM artifact_server_postgres_migrations WHERE migration_id >= 25");
    }));
    await database.close();

    database = await PostgresDatabase.open({url: Redacted.make(scratchUrl.toString())}, "apply");
    const access = new PostgresAccessRepository(database, clock);
    const projects = await access.listProjectAccess(installationId);
    expect(projects.map((project) => project.projectId).toSorted()).toEqual(["prj_default", "prj_second"]);
    for (const project of projects) {
      expect(project).toMatchObject({accessMode: "open", defaultMemberRole: "editor", revision: 0});
    }
    const keys = await database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.unsafe<{projectIds: string}>(
        `SELECT project_ids_json AS "projectIds" FROM managed_api_keys WHERE installation_id = $1`,
        [installationId],
      );
    }));
    expect(keys).toEqual([{projectIds: "[]"}]);
    const migrations = await database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.unsafe<{migrationId: number}>(
        `SELECT max(migration_id) AS "migrationId" FROM artifact_server_postgres_migrations`,
      );
    }));
    expect(Number(migrations[0]?.migrationId)).toBe(requiredPostgresSchemaVersion);
  });
});
