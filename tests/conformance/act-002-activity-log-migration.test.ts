import {spawn} from "node:child_process";
import {existsSync, statSync} from "node:fs";
import {copyFile, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultProjectId} from "../../src/core/model.js";
import {sqliteActionsRebuildStatements, sqliteActivityRecoveryStatements} from "../../src/storage/activity-log-schema.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {expectRecoveredActivity, populateActivityHistory} from "../support/activity-history-fixture.js";
import {
  actionColumns,
  downgradeSqliteActionsToLegacy,
  fullActionsDigest,
  insertBulkLegacyActions,
  legacyActionsDigest,
  readSqliteActionRows,
  tableNames,
  withSqliteDatabase,
} from "../support/sqlite-activity-log.js";

const installationId = "act-002-installation";
const childScript = path.resolve(import.meta.dirname, "../support/open-sqlite-artifact-repository.ts");

interface ChildOutcome {
  readonly exitCode: number | null;
  readonly peakWalBytes: number;
  readonly signal: NodeJS.Signals | null;
}

/** Open the repository in a child process; optionally SIGKILL it once its WAL reaches `killAtWalBytes`. */
async function runMigrationChild(
  databasePath: string,
  killAtWalBytes: number | null,
): Promise<ChildOutcome> {
  const child = spawn(process.execPath, ["--import", "tsx", childScript, databasePath], {
    stdio: "ignore",
  });
  const walPath = `${databasePath}-wal`;
  let peakWalBytes = 0;
  const timer = setInterval(() => {
    const size = existsSync(walPath) ? statSync(walPath).size : 0;
    peakWalBytes = Math.max(peakWalBytes, size);
    if (killAtWalBytes !== null && size >= killAtWalBytes) child.kill("SIGKILL");
  }, 1);
  const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once("exit", (code, exitSignal) => resolve([code, exitSignal]));
  });
  clearInterval(timer);
  return {exitCode, peakWalBytes, signal};
}

/** A populated file with the history fixture, downgraded to the schema-17 actions shape. */
async function legacyInstallation(databasePath: string) {
  const artifacts = new SqliteArtifactRepository(databasePath, installationId);
  const identity = new SqliteIdentityRepository(databasePath);
  try {
    return await populateActivityHistory({artifacts, identity, installationId});
  } finally {
    identity.close();
    artifacts.close();
    downgradeSqliteActionsToLegacy(databasePath);
  }
}

describe("ACT-002 activity log migration (SQLite)", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "artifact-act-002-"));
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  test("ACT-002-B a populated SQLite installation keeps every action and recovers recorded activity", async () => {
    const databasePath = path.join(directory, "artifact-server.db");
    const fixture = await legacyInstallation(databasePath);
    // The agent answered before the upgrade; only its dispatch row recorded that.
    withSqliteDatabase(databasePath, (database) => {
      database.prepare(`
        UPDATE agent_dispatches
           SET state = 'addressed', addressed_at = ?, updated_at = ?
         WHERE id = ?
      `).run("2026-09-03T11:00:00.000Z", "2026-09-03T11:00:00.000Z", fixture.dispatchId);
    });
    const legacy = withSqliteDatabase(databasePath, legacyActionsDigest);
    const legacyArtifactIds = withSqliteDatabase(databasePath, (database) =>
      database.prepare("SELECT id FROM actions WHERE artifact_id = ? ORDER BY id")
        .all(fixture.artifactId).map((row) => String(row["id"])));

    const upgraded = new SqliteArtifactRepository(databasePath, installationId);
    try {
      expect(withSqliteDatabase(databasePath, legacyActionsDigest)).toEqual(legacy);
      const rows = readSqliteActionRows(databasePath);
      expectRecoveredActivity(rows, fixture);
      expect(rows.find((row) => row.id === `recovered:dispatch_addressed:${fixture.dispatchId}`))
        .toMatchObject({
          actor_kind: "service",
          actor_name: "Codex",
          created_at: "2026-09-03T11:00:00.000Z",
          project_id: defaultProjectId,
        });

      // The per-artifact history endpoint still returns exactly the legacy rows.
      const history = await upgraded.listArtifactActions({
        artifactId: fixture.artifactId,
        cursor: null,
        limit: 100,
        projectId: defaultProjectId,
      });
      expect(history.items.map((item) => item.id).toSorted()).toEqual(legacyArtifactIds);
    } finally {
      upgraded.close();
    }
  });

  test("ACT-002-F an interrupted or repeated migration cannot duplicate, drop or alter rows, or invent actors", {timeout: 180_000}, async () => {
    const databasePath = path.join(directory, "interrupted.db");
    const fixture = await legacyInstallation(databasePath);
    insertBulkLegacyActions(databasePath, {
      artifactId: fixture.artifactId,
      count: 300_000,
      projectId: defaultProjectId,
      versionId: fixture.versionId,
    });
    const legacy = withSqliteDatabase(databasePath, legacyActionsDigest);
    expect(legacy.count).toBeGreaterThan(300_000);

    // Measure one complete migration on a copy, then kill the real one at 60% of its peak log.
    const measuredPath = path.join(directory, "measured.db");
    await copyFile(databasePath, measuredPath);
    const measured = await runMigrationChild(measuredPath, null);
    expect(measured.exitCode).toBe(0);
    expect(measured.peakWalBytes).toBeGreaterThan(0);
    const killed = await runMigrationChild(databasePath, Math.floor(measured.peakWalBytes * 0.6));
    expect(killed.signal).toBe("SIGKILL");

    // The killed file still holds the complete legacy table and no half-built copy.
    withSqliteDatabase(databasePath, (database) => {
      expect(actionColumns(database)).not.toContain("subject_id");
      expect(tableNames(database)).not.toContain("actions_next");
      expect(tableNames(database)).not.toContain("actions_copy_check");
      expect(legacyActionsDigest(database)).toEqual(legacy);
    });

    // A restart completes the migration and keeps every legacy row byte for byte.
    new SqliteArtifactRepository(databasePath, installationId).close();
    const migrated = withSqliteDatabase(databasePath, (database) => {
      expect(actionColumns(database)).toContain("subject_id");
      expect(legacyActionsDigest(database)).toEqual(legacy);
      expect(database.prepare(`
        SELECT count(*) AS named FROM actions
         WHERE principal_id = 'principal-bulk' AND actor_name IS NOT NULL
      `).get()).toEqual({named: 0});
      return fullActionsDigest(database);
    });

    // A repeated startup changes nothing.
    new SqliteArtifactRepository(databasePath, installationId).close();
    expect(withSqliteDatabase(databasePath, fullActionsDigest)).toEqual(migrated);

    // A migrator that read the legacy shape just before a concurrent one committed must not
    // rebuild the migrated table: the copy check refuses, and nothing changes.
    withSqliteDatabase(databasePath, (database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        expect(() => {
          for (const statement of [
            ...sqliteActionsRebuildStatements({strict: true}),
            ...sqliteActivityRecoveryStatements({identity: true}),
          ]) database.exec(statement);
        }).toThrow(/CHECK constraint failed/u);
      } finally {
        database.exec("ROLLBACK");
      }
    });
    expect(withSqliteDatabase(databasePath, fullActionsDigest)).toEqual(migrated);
  });
});
