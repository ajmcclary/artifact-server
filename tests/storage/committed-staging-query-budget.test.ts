import {DatabaseSync} from "node:sqlite";
import {expect, test} from "vitest";
import {committedStagingCleanupRepository} from "../../src/storage/committed-staging-cleanup.js";

test("foundation: committed staging selection caps file rows and preserves unfinished progress", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE staged_uploads (id TEXT PRIMARY KEY, status TEXT, expires_at TEXT,
        staging_cleaned_at TEXT, cleanup_claimed_at TEXT);
      CREATE TABLE staged_upload_files (upload_id TEXT, storage_token TEXT,
        sha256 TEXT, size INTEGER, staging_cleaned_at TEXT);
      INSERT INTO staged_uploads VALUES ('upload', 'committed', '2026-01-01', NULL, NULL);
    `);
    const insert = database.prepare("INSERT INTO staged_upload_files VALUES ('upload', ?, 'digest', 1, NULL)");
    for (let index = 0; index < 1_100; index++) insert.run(String(index).padStart(4, "0"));
    const repository = committedStagingCleanupRepository(async (statement, values) =>
      database.prepare(statement).all(...values));
    const now = "2026-01-02";
    expect(await repository.claim("upload", now, now, "2026-01-01")).toBe(true);
    const selected = await repository.list(now, 100);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.files).toHaveLength(1_024);
    for (const file of selected[0]?.files ?? []) {
      // eslint-disable-next-line no-await-in-loop -- exercise durable progress in deletion order
      await repository.markFileRemoved("upload", file.storageToken, now, now);
    }
    expect(await repository.complete("upload", now, now)).toBe(false);
    const remaining = await repository.list(now, 100);
    expect(remaining[0]?.files).toHaveLength(76);
    for (const file of remaining[0]?.files ?? []) {
      // eslint-disable-next-line no-await-in-loop -- finish the remaining persisted slots
      await repository.markFileRemoved("upload", file.storageToken, now, now);
    }
    expect(await repository.complete("upload", now, now)).toBe(true);
    expect(await repository.list(now, 100)).toEqual([]);
  } finally {
    database.close();
  }
});
