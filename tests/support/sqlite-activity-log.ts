import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";

import {z} from "zod";

import {artifactHistoryActionKinds} from "../../src/core/model.js";

const legacyColumns = `id, project_id, artifact_id, version_id, action, principal_id,
  authorized_by_principal_id, idempotency_key, created_at`;
const historyKindSql = artifactHistoryActionKinds.map((kind) => `'${kind}'`).join(", ");

/** Open one SQLite file, run `read`, and always close the connection. */
export function withSqliteDatabase<Result>(
  databasePath: string,
  read: (database: DatabaseSync) => Result,
): Result {
  const database = new DatabaseSync(databasePath, {timeout: 5_000});
  try {
    return read(database);
  } finally {
    database.close();
  }
}

/**
 * Rebuild `actions` in the exact schema-17 shape, keeping only rows a
 * schema-17 file could hold, so a test can upgrade a realistic legacy file.
 */
export function downgradeSqliteActionsToLegacy(databasePath: string): void {
  withSqliteDatabase(databasePath, (database) => {
    database.exec("PRAGMA foreign_keys = OFF;");
    database.exec(`
      BEGIN IMMEDIATE;
      DROP TRIGGER IF EXISTS actions_project_insert;
      DROP TRIGGER IF EXISTS actions_project_update;
      CREATE TABLE actions_legacy (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        action TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        authorized_by_principal_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO actions_legacy (${legacyColumns})
        SELECT ${legacyColumns} FROM actions
         WHERE id NOT LIKE 'recovered:%' AND action IN (${historyKindSql});
      DROP TABLE actions;
      ALTER TABLE actions_legacy RENAME TO actions;
      CREATE INDEX actions_artifact_created
        ON actions (project_id, artifact_id, created_at DESC, id DESC);
      CREATE TRIGGER actions_project_insert
      BEFORE INSERT ON actions
      WHEN NOT EXISTS (
        SELECT 1 FROM artifacts
        WHERE id = NEW.artifact_id AND project_id = NEW.project_id
      ) OR NOT EXISTS (
        SELECT 1 FROM versions
        WHERE id = NEW.version_id AND project_id = NEW.project_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'action project mismatch');
      END;
      CREATE TRIGGER actions_project_update
      BEFORE UPDATE OF project_id ON actions
      WHEN NEW.project_id <> OLD.project_id
      BEGIN
        SELECT RAISE(ABORT, 'action project cannot change');
      END;
      COMMIT;
    `);
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA user_version = 17;");
  });
}

/** Append `count` legacy `change_tags` rows to one published artifact. */
export function insertBulkLegacyActions(
  databasePath: string,
  target: {
    readonly artifactId: string;
    readonly count: number;
    readonly projectId: string;
    readonly versionId: string;
  },
): void {
  withSqliteDatabase(databasePath, (database) => {
    database.prepare(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO actions (${legacyColumns})
      SELECT printf('act_bulk_%08d', i), ?, ?, ?, 'change_tags', 'principal-bulk', NULL,
        printf('bulk-%08d', i),
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01T00:00:00Z', '+' || i || ' seconds')
      FROM n
    `).run(target.count, target.projectId, target.artifactId, target.versionId);
  });
}

const legacyRowSchema = z.object({
  action: z.string(),
  artifact_id: z.string().nullable(),
  authorized_by_principal_id: z.string().nullable(),
  created_at: z.string(),
  id: z.string(),
  idempotency_key: z.string(),
  principal_id: z.string().nullable(),
  project_id: z.string().nullable(),
  version_id: z.string().nullable(),
});

/** Count and order-independent digest of the legacy columns of a migration's input rows. */
export interface ActionsDigest {
  readonly count: number;
  readonly digest: string;
}

function digestRows(rows: readonly unknown[]): ActionsDigest {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
  return {count: rows.length, digest: hash.digest("hex")};
}

/** Digest of every non-recovered row a schema-17 file could hold. */
export function legacyActionsDigest(database: DatabaseSync): ActionsDigest {
  return digestRows(z.array(legacyRowSchema).parse(database.prepare(`
    SELECT ${legacyColumns} FROM actions
     WHERE id NOT LIKE 'recovered:%' AND action IN (${historyKindSql})
     ORDER BY id
  `).all()));
}

/** Digest of every column of every row, to prove a repeated startup changes nothing. */
export function fullActionsDigest(database: DatabaseSync): ActionsDigest {
  return digestRows(database.prepare("SELECT * FROM actions ORDER BY id").all());
}

/** Names of the columns `actions` currently has. */
export function actionColumns(database: DatabaseSync): readonly string[] {
  return z.array(z.object({name: z.string()}))
    .parse(database.prepare("PRAGMA table_info(actions)").all())
    .map((column) => column.name);
}

/** Names of every table in the file. */
export function tableNames(database: DatabaseSync): readonly string[] {
  return z.array(z.object({name: z.string()}))
    .parse(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all())
    .map((table) => table.name);
}
