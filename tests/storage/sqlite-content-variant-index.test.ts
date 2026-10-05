import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  brotliVariantEncoderId,
  ContentVariantConflict,
  type ContentVariantMapping,
} from "../../src/core/content-variants.js";
import {SystemClock} from "../../src/core/system.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteContentVariantIndex} from "../../src/storage/sqlite-content-variant-index.js";

const sourceSha256 = "a".repeat(64);
const mapping: ContentVariantMapping = {
  coding: "br",
  encoderId: brotliVariantEncoderId,
  sourceSha256,
  variantSha256: "b".repeat(64),
  variantSize: 1234,
};

describe("SQLite content variant index", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "sqlite-variant-index-"));
    databasePath = path.join(directory, "artifact-server.db");
    // The artifact repository owns the compact schema and creates the table.
    new SqliteArtifactRepository(databasePath, "installation-a").close();
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  test("foundation: the SQLite variant index records, finds, and rejects conflicting mappings", async () => {
    const index = new SqliteContentVariantIndex(databasePath, "installation-a", new SystemClock());
    try {
      expect(await index.find(mapping)).toBeNull();
      await index.record(mapping);
      await index.record(mapping);
      expect(await index.find(mapping)).toEqual(mapping);
      await expect(index.record({...mapping, variantSha256: "c".repeat(64)}))
        .rejects.toBeInstanceOf(ContentVariantConflict);
      expect(await index.find({...mapping, encoderId: "br-q11-w24-v2"})).toBeNull();
    } finally {
      index.close();
    }
  });

  test("foundation: SQLite variant mappings survive reopening and stay within their installation", async () => {
    const first = new SqliteContentVariantIndex(databasePath, "installation-a", new SystemClock());
    await first.record(mapping);
    first.close();
    const reopened = new SqliteContentVariantIndex(databasePath, "installation-a", new SystemClock());
    const other = new SqliteContentVariantIndex(databasePath, "installation-b", new SystemClock());
    try {
      expect(await reopened.find(mapping)).toEqual(mapping);
      expect(await other.find(mapping)).toBeNull();
    } finally {
      reopened.close();
      other.close();
    }
  });
});
