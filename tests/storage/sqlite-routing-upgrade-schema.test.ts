import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

const schemaObjectSchema = z.array(z.object({
  name: z.string(),
  sql: z.string(),
  tableName: z.string(),
  type: z.enum(["index", "trigger"]),
}));

/** The earliest local schema, before routing modes, projects, or publishers. */
const earlyLocalSchema = `
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    access_setting TEXT NOT NULL CHECK (access_setting IN ('account_required', 'public_link')),
    current_version_id TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  ) STRICT;

  CREATE TABLE versions (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    number INTEGER NOT NULL CHECK (number > 0),
    manifest_digest TEXT NOT NULL,
    entry_path TEXT NOT NULL,
    routing_mode TEXT NOT NULL CHECK (routing_mode = 'static'),
    content_token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    UNIQUE (artifact_id, number)
  ) STRICT;

  CREATE TABLE idempotency_records (
    idempotency_key TEXT PRIMARY KEY,
    input_digest TEXT NOT NULL,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    version_id TEXT NOT NULL REFERENCES versions(id),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE actions (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    version_id TEXT NOT NULL REFERENCES versions(id),
    action TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
`;

function readTriggersAndIndexes(databasePath: string) {
  const database = new DatabaseSync(databasePath, {readOnly: true});
  try {
    const rows = database.prepare(
      `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
       WHERE type IN ('index', 'trigger') AND sql IS NOT NULL
       ORDER BY type, name`,
    ).all();
    return schemaObjectSchema.parse(rows).map((row) => ({
      name: row.name,
      sql: row.sql.replaceAll(/\s+/gu, " ").trim(),
      tableName: row.tableName,
      type: row.type,
    }));
  } finally {
    database.close();
  }
}

describe("SQLite routing-mode upgrade", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "artifact-routing-upgrade-"));
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  test("PRJ-004 regression: the first process after a routing-mode upgrade keeps every project guard trigger and index", () => {
    const freshPath = path.join(directory, "fresh.db");
    new SqliteArtifactRepository(freshPath).close();

    const legacyPath = path.join(directory, "legacy.db");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(earlyLocalSchema);
    legacy.close();
    // Exactly one open: the guards must exist without a second startup.
    new SqliteArtifactRepository(legacyPath).close();

    const fresh = readTriggersAndIndexes(freshPath);
    const upgraded = readTriggersAndIndexes(legacyPath);
    expect(fresh.length).toBeGreaterThan(0);
    expect(upgraded.map(({name, type}) => `${type}:${name}`))
      .toEqual(fresh.map(({name, type}) => `${type}:${name}`));
    expect(upgraded).toEqual(fresh);
  });
});
