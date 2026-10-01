import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";
import {z} from "zod";

import {defaultProjectId} from "../../../src/core/model.js";
import {
  expectRecoveredActivity,
  populateActivityHistory,
  recoveredRowColumns,
  recoveredRowSchema,
} from "../../../tests/support/activity-history-fixture.js";
import {sqliteActionsRebuildStatements, sqliteActivityRecoveryStatements} from "../../../src/storage/activity-log-schema.js";
import {createD1ArtifactRepository} from "../src/d1-artifact-repository.js";
import {createD1IdentityRepository} from "../src/d1-identity-repository.js";
import {migrateD1, requiredD1SchemaVersion} from "../src/d1-migrations.js";

const openLocalD1 = () => getPlatformProxy<{
  ARTIFACT_SERVER_D1_DATABASE: D1Database;
}>({
  configPath: fileURLToPath(new URL("../wrangler.git-store.test.jsonc", import.meta.url)),
  envFiles: [],
  persist: false,
  remoteBindings: false,
});

const schema15ActionKinds = [
  "publish", "restore", "change_access", "change_tags", "delete",
  "comment_create", "comment_reply", "comment_update",
  "comment_resolve", "comment_reopen", "comment_delete",
].map((kind) => `'${kind}'`).join(", ");
const legacyColumns = `id, project_id, artifact_id, version_id, action, principal_id,
  authorized_by_principal_id, idempotency_key, created_at`;

/** Put `actions` back in the schema-15 shape and mark the database as schema 15. */
async function downgradeD1ToSchema15(binding: D1Database): Promise<void> {
  await binding.batch([
    `CREATE TABLE actions_legacy (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      version_id TEXT NOT NULL REFERENCES versions(id),
      action TEXT NOT NULL CHECK (action IN (${schema15ActionKinds})),
      principal_id TEXT NOT NULL,
      authorized_by_principal_id TEXT,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `INSERT INTO actions_legacy (${legacyColumns})
      SELECT ${legacyColumns} FROM actions
       WHERE id NOT LIKE 'recovered:%' AND action IN (${schema15ActionKinds})`,
    "DROP TABLE actions",
    "ALTER TABLE actions_legacy RENAME TO actions",
    `CREATE INDEX actions_artifact_created
      ON actions(project_id, artifact_id, created_at DESC, id DESC)`,
    "UPDATE artifact_server_schema SET version = 15 WHERE component = 'runtime'",
  ].map((statement) => binding.prepare(statement)));
}

const legacyRowsSql = `SELECT ${legacyColumns} FROM actions
  WHERE id NOT LIKE 'recovered:%' AND action IN (${schema15ActionKinds}) ORDER BY id`;

describe("D1 activity log migration", () => {
  it("upgrades a schema-15 database, keeps every action and recovers recorded activity", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-activity-log-migration";
    try {
      await migrateD1(binding, installationId);
      const fixture = await populateActivityHistory({
        artifacts: createD1ArtifactRepository(binding, installationId),
        identity: createD1IdentityRepository(binding),
        installationId,
      });
      await downgradeD1ToSchema15(binding);
      const legacy = (await binding.prepare(legacyRowsSql).all()).results;
      expect(legacy.length).toBeGreaterThan(0);

      await migrateD1(binding, installationId);

      expect((await binding.prepare(legacyRowsSql).all()).results).toEqual(legacy);
      const rows = z.array(recoveredRowSchema).parse(
        (await binding.prepare(`SELECT ${recoveredRowColumns} FROM actions`).all()).results,
      );
      expectRecoveredActivity(rows, fixture);
      expect(await binding.prepare(
        "SELECT version FROM artifact_server_schema WHERE component = 'runtime'",
      ).first<number>("version")).toBe(requiredD1SchemaVersion);

      // A repeated migration changes nothing.
      const before = (await binding.prepare("SELECT * FROM actions ORDER BY id").all()).results;
      await migrateD1(binding, installationId);
      expect((await binding.prepare("SELECT * FROM actions ORDER BY id").all()).results).toEqual(before);

      // An isolate that read the legacy shape before a concurrent one committed must not rebuild
      // the migrated table: the batch is refused and nothing changes.
      await expect(binding.batch([
        ...sqliteActionsRebuildStatements({strict: false}),
        ...sqliteActivityRecoveryStatements({identity: true}),
      ].map((statement) => binding.prepare(statement)))).rejects.toThrow(/CHECK constraint failed/u);
      expect((await binding.prepare("SELECT * FROM actions ORDER BY id").all()).results).toEqual(before);

      const history = await createD1ArtifactRepository(binding, installationId).listArtifactActions({
        artifactId: fixture.artifactId,
        cursor: null,
        limit: 100,
        projectId: defaultProjectId,
      });
      expect(history.items.every((item) => !item.id.startsWith("recovered:"))).toBe(true);
    } finally {
      await proxy.dispose();
    }
  });
});
