import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultProjectId} from "../../src/core/model.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

const previousSchemaVersion = 13;
const principalId = "principal-idempotency";
const projectId = defaultProjectId;

function manifestFixture(name: string) {
  const bytes = new TextEncoder().encode(name);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return createManifest({
    entryPath: "index.html",
    files: [{
      mediaType: "text/html",
      path: "index.html",
      sha256,
      size: bytes.byteLength,
    }],
    routingMode: "static",
  });
}

describe("SQLite staged upload idempotency key", () => {
  let dataDirectory: string;
  let repository: SqliteArtifactRepository;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-staged-idempotency-"),
    );
    repository = new SqliteArtifactRepository(
      path.join(dataDirectory, "artifact-server.db"),
    );
  });

  afterEach(async () => {
    repository.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("a key-bound upload is found by idempotency key", async () => {
    const manifest = manifestFixture("key-bound upload");
    const created = await repository.createStagedUpload({
      createdAt: "2026-09-21T00:00:00.000Z",
      expiresAt: "2026-09-21T01:00:00.000Z",
      files: manifest.entries.map((entry) => ({
        entry,
        storageToken: `token-key-bound-${entry.sha256}`,
      })),
      id: "upl_key_bound",
      idempotencyKey: "idem-key-bound",
      manifest,
      principalId,
      projectId,
    });

    expect(created.idempotencyKey).toBe("idem-key-bound");

    const found = await repository.findStagedUploadByIdempotencyKey(
      projectId,
      principalId,
      "idem-key-bound",
    );
    expect(found).toMatchObject({
      id: "upl_key_bound",
      idempotencyKey: "idem-key-bound",
      status: "open",
    });
  });

  test("another principal cannot see or block a key-bound upload", async () => {
    const manifest = manifestFixture("cross-principal isolation");
    await repository.createStagedUpload({
      createdAt: "2026-09-21T00:00:00.000Z",
      expiresAt: "2026-09-21T01:00:00.000Z",
      files: manifest.entries.map((entry) => ({
        entry,
        storageToken: `token-isolation-${entry.sha256}`,
      })),
      id: "upl_isolation",
      idempotencyKey: "idem-isolation",
      manifest,
      principalId,
      projectId,
    });

    await expect(repository.findStagedUploadByIdempotencyKey(
      projectId,
      "principal-other",
      "idem-isolation",
    )).resolves.toBeNull();

    const other = await repository.createStagedUpload({
      createdAt: "2026-09-21T00:00:00.000Z",
      expiresAt: "2026-09-21T01:00:00.000Z",
      files: manifest.entries.map((entry) => ({
        entry,
        storageToken: `token-isolation-other-${entry.sha256}`,
      })),
      id: "upl_isolation_other",
      idempotencyKey: "idem-isolation",
      manifest,
      principalId: "principal-other",
      projectId,
    });
    expect(other.id).toBe("upl_isolation_other");
  });

  test("a second upload with the same key fails with a uniqueness violation", async () => {
    const manifest = manifestFixture("duplicate key");
    await repository.createStagedUpload({
      createdAt: "2026-09-21T00:00:00.000Z",
      expiresAt: "2026-09-21T01:00:00.000Z",
      files: manifest.entries.map((entry) => ({
        entry,
        storageToken: `token-first-${entry.sha256}`,
      })),
      id: "upl_first_duplicate",
      idempotencyKey: "idem-duplicate",
      manifest,
      principalId,
      projectId,
    });

    const duplicate = repository.createStagedUpload({
      createdAt: "2026-09-21T00:00:00.000Z",
      expiresAt: "2026-09-21T01:00:00.000Z",
      files: manifest.entries.map((entry) => ({
        entry,
        storageToken: `token-second-${entry.sha256}`,
      })),
      id: "upl_second_duplicate",
      idempotencyKey: "idem-duplicate",
      manifest,
      principalId,
      projectId,
    });

    await expect(duplicate).rejects.toThrow(/unique|constraint/i);
  });

  test("null-key uploads coexist and do not conflict", async () => {
    const manifest = manifestFixture("null key coexistence");
    const first = await repository.createStagedUpload({
      createdAt: "2026-09-21T00:00:00.000Z",
      expiresAt: "2026-09-21T01:00:00.000Z",
      files: manifest.entries.map((entry) => ({
        entry,
        storageToken: `token-null-a-${entry.sha256}`,
      })),
      id: "upl_null_a",
      idempotencyKey: null,
      manifest,
      principalId,
      projectId,
    });
    const second = await repository.createStagedUpload({
      createdAt: "2026-09-21T00:00:00.000Z",
      expiresAt: "2026-09-21T01:00:00.000Z",
      files: manifest.entries.map((entry) => ({
        entry,
        storageToken: `token-null-b-${entry.sha256}`,
      })),
      id: "upl_null_b",
      idempotencyKey: null,
      manifest,
      principalId,
      projectId,
    });

    expect(first.idempotencyKey).toBeNull();
    expect(second.idempotencyKey).toBeNull();
    expect(first.id).not.toBe(second.id);
  });

  test("a previous-schema database upgrades and preserves staged uploads", async () => {
    const databasePath = path.join(dataDirectory, "legacy-artifact-server.db");
    repository.close();

    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          installation_id TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          archived_at TEXT
        ) STRICT;
        INSERT INTO projects (id, installation_id, name, created_at, archived_at)
          VALUES ('${defaultProjectId}', 'legacy-installation', 'Default', '2026-01-01T00:00:00.000Z', NULL);
        CREATE TABLE staged_uploads (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          principal_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'committed')),
          manifest_digest TEXT NOT NULL,
          entry_path TEXT NOT NULL,
          routing_mode TEXT NOT NULL CHECK (routing_mode IN ('static', 'spa')),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          committed_version_id TEXT,
          CHECK (
            (status = 'open' AND committed_version_id IS NULL)
            OR (status = 'committed' AND committed_version_id IS NOT NULL)
          )
        ) STRICT;
        CREATE TABLE staged_upload_files (
          upload_id TEXT NOT NULL REFERENCES staged_uploads(id),
          storage_token TEXT NOT NULL UNIQUE,
          path TEXT NOT NULL,
          size INTEGER NOT NULL CHECK (size >= 0),
          media_type TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          disposition TEXT NOT NULL CHECK (disposition IN ('inline', 'attachment')),
          uploaded_at TEXT,
          PRIMARY KEY (upload_id, path)
        ) STRICT;
        PRAGMA user_version = ${previousSchemaVersion};
      `);
      const manifest = manifestFixture("legacy upload");
      legacy.prepare(`
        INSERT INTO staged_uploads (
          id, project_id, principal_id, status, manifest_digest, entry_path,
          routing_mode, created_at, expires_at, committed_version_id
        ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, NULL)
      `).run(
        "upl_legacy",
        defaultProjectId,
        principalId,
        manifest.digest,
        manifest.entryPath,
        manifest.routingMode,
        "2026-09-21T00:00:00.000Z",
        "2026-09-21T01:00:00.000Z",
      );
      legacy.prepare(`
        INSERT INTO staged_upload_files (
          upload_id, storage_token, path, size, media_type, sha256, disposition, uploaded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        "upl_legacy",
        "token-legacy",
        "index.html",
        manifest.entries[0]?.size ?? 0,
        manifest.entries[0]?.mediaType ?? "text/html",
        manifest.entries[0]?.sha256 ?? "",
        "inline",
      );
    } finally {
      legacy.close();
    }

    repository = new SqliteArtifactRepository(databasePath);
    const legacyUpload = await repository.findStagedUpload(
      projectId,
      "upl_legacy",
      principalId,
    );
    expect(legacyUpload).toMatchObject({
      id: "upl_legacy",
      idempotencyKey: null,
      status: "open",
    });

    const manifest = manifestFixture("post-upgrade upload");
    const upgraded = await repository.createStagedUpload({
      createdAt: "2026-09-21T00:00:00.000Z",
      expiresAt: "2026-09-21T01:00:00.000Z",
      files: manifest.entries.map((entry) => ({
        entry,
        storageToken: `token-upgraded-${entry.sha256}`,
      })),
      id: "upl_upgraded",
      idempotencyKey: "idem-upgraded",
      manifest,
      principalId,
      projectId,
    });
    expect(upgraded.idempotencyKey).toBe("idem-upgraded");
    await expect(repository.findStagedUploadByIdempotencyKey(
      projectId,
      principalId,
      "idem-upgraded",
    )).resolves.toMatchObject({id: "upl_upgraded"});
  });
});
