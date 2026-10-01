import {randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {defaultProjectId} from "../../src/core/model.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {PostgresIdentityRepository} from "../../src/storage/postgres-identity-repository.js";
import {
  type ActivityHistoryFixture,
  expectRecoveredActivity,
  populateActivityHistory,
  recoveredRowColumns,
  recoveredRowSchema,
} from "../support/activity-history-fixture.js";
import {
  revertInstallationActivityLogStatements,
  schema17ActionKindSql,
} from "../support/postgres-activity-log.js";

const installationId = "postgres-activity-log-migration";
const schema17ActionKinds = schema17ActionKindSql;
const legacyColumns = `id, project_id, artifact_id, version_id, action, principal_id,
  authorized_by_principal_id, idempotency_key, created_at`;

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

const query = (database: PostgresDatabase, statement: string, parameters: readonly unknown[] = []) =>
  database.run(Effect.gen(function*() {
    const sql = yield* SqlClient;
    return yield* sql.unsafe<object>(statement, parameters);
  }));

/** Reverse migration 0018 so the next open applies it to a populated schema-17 database. */
async function downgradeToSchema17(database: PostgresDatabase): Promise<void> {
  await database.run(Effect.gen(function*() {
    const sql = yield* SqlClient;
    for (const statement of [
      ...revertInstallationActivityLogStatements,
      "DELETE FROM artifact_server_postgres_migrations WHERE migration_id >= 18",
    ]) {
      yield* sql.unsafe(statement);
    }
  }));
}

describe("Postgres activity log migration", () => {
  let control: PostgresDatabase;
  let scratch: string;
  let scratchUrl: Redacted.Redacted;

  beforeEach(async () => {
    // Inspect only: the shared test database must stay unmigrated for the other suites.
    control = await PostgresDatabase.inspect({url: Redacted.make(readDatabaseUrl())});
    scratch = `artifact_activity_log_${randomUUID().replaceAll("-", "")}`;
    await query(control, `CREATE DATABASE ${scratch}`);
    const url = new URL(readDatabaseUrl());
    url.pathname = `/${scratch}`;
    scratchUrl = Redacted.make(url.toString());
  });

  afterEach(async () => {
    await query(control, `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    await control.close();
  });

  test("upgrades a populated schema-17 database, keeps every action and recovers recorded activity", async () => {
    const legacyRowsSql = `SELECT ${legacyColumns} FROM actions
      WHERE installation_id = $1 AND id NOT LIKE 'recovered:%'
        AND action IN (${schema17ActionKinds})
      ORDER BY id`;
    const seeded = await PostgresDatabase.open({url: scratchUrl}, "apply");
    let fixture: ActivityHistoryFixture | undefined;
    let legacyBefore: readonly object[] = [];
    try {
      const artifacts = await PostgresArtifactRepository.open(seeded, installationId);
      fixture = await populateActivityHistory({
        artifacts,
        identity: new PostgresIdentityRepository(seeded, installationId),
        installationId,
      });
      await downgradeToSchema17(seeded);
      legacyBefore = await query(seeded, legacyRowsSql, [installationId]);
    } finally {
      await seeded.close();
    }

    if (fixture === undefined) throw new Error("The fixture was not recorded.");
    const upgraded = await PostgresDatabase.open({url: scratchUrl}, "apply");
    try {
      const rows = z.array(recoveredRowSchema).parse(await query(
        upgraded,
        `SELECT ${recoveredRowColumns} FROM actions WHERE installation_id = $1`,
        [installationId],
      ));
      expectRecoveredActivity(rows, fixture);
      // Every legacy row keeps its id, key, timestamp and attribution.
      expect(legacyBefore.length).toBeGreaterThan(0);
      expect(await query(upgraded, legacyRowsSql, [installationId])).toEqual(legacyBefore);

      const history = await (await PostgresArtifactRepository.open(upgraded, installationId))
        .listArtifactActions({
          artifactId: fixture.artifactId,
          cursor: null,
          limit: 100,
          projectId: defaultProjectId,
        });
      expect(history.items.every((item) => !item.id.startsWith("recovered:"))).toBe(true);

      // Reopening applies nothing and changes nothing.
      const before = await query(upgraded, legacyRowsSql, [installationId]);
      const again = await PostgresDatabase.open({url: scratchUrl}, "apply");
      try {
        expect(await query(again, `SELECT * FROM actions WHERE installation_id = $1 ORDER BY id`, [installationId]))
          .toEqual(await query(upgraded, `SELECT * FROM actions WHERE installation_id = $1 ORDER BY id`, [installationId]));
        expect(await query(again, legacyRowsSql, [installationId])).toEqual(before);
      } finally {
        await again.close();
      }
    } finally {
      await upgraded.close();
    }
  });
});
