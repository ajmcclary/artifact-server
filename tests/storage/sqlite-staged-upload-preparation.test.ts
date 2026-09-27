import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultProjectId} from "../../src/core/model.js";
import {UploadPreparationLeaseLost} from "../../src/core/upload-preparation.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

const previousSchemaVersion = 15;
const principalId = "principal-preparation";
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

function uploadCommand(
  id: string,
  manifest: ReturnType<typeof manifestFixture>,
  expiresAt = "2026-09-21T01:00:00.000Z",
) {
  return {
    createdAt: "2026-09-21T00:00:00.000Z",
    expiresAt,
    files: manifest.entries.map((entry) => ({
      entry,
      storageToken: `token-${id}-${entry.sha256}`,
    })),
    id,
    idempotencyKey: null,
    manifest,
    principalId,
    projectId,
  };
}

describe("SQLite staged upload preparation", () => {
  let dataDirectory: string;
  let repository: SqliteArtifactRepository;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-staged-preparation-"),
    );
    repository = new SqliteArtifactRepository(
      path.join(dataDirectory, "artifact-server.db"),
    );
  });

  afterEach(async () => {
    repository.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("claim succeeds on an open upload", async () => {
    const manifest = manifestFixture("open upload");
    const command = uploadCommand("upl_claim_open", manifest);
    await repository.createStagedUpload(command);

    const lease = "2026-09-21T00:00:45.000Z";
    const claim = await repository.claimUploadPreparation(
      command.id,
      "2026-09-21T00:00:00.000Z",
      lease,
    );
    expect(claim).toMatchObject({
      attempts: 1,
      leaseExpiresAt: lease,
      preparationState: "claimed",
      uploadId: command.id,
    });

    const upload = await repository.findStagedUpload(projectId, command.id, principalId);
    expect(upload).toMatchObject({
      preparationAttempts: 1,
      preparationLeaseExpiresAt: lease,
      preparationState: "claimed",
    });
  });

  test("double claim fails while the lease is live", async () => {
    const manifest = manifestFixture("double claim");
    const command = uploadCommand("upl_double_claim", manifest);
    await repository.createStagedUpload(command);

    const first = await repository.claimUploadPreparation(
      command.id,
      "2026-09-21T00:00:00.000Z",
      "2026-09-21T00:00:45.000Z",
    );
    expect(first).not.toBeNull();

    const second = await repository.claimUploadPreparation(
      command.id,
      "2026-09-21T00:00:10.000Z",
      "2026-09-21T00:00:55.000Z",
    );
    expect(second).toBeNull();
  });

  test("expired claim is reclaimed with attempts incremented", async () => {
    const manifest = manifestFixture("expired claim");
    const command = uploadCommand("upl_expired_claim", manifest);
    await repository.createStagedUpload(command);

    const first = await repository.claimUploadPreparation(
      command.id,
      "2026-09-21T00:00:00.000Z",
      "2026-09-21T00:00:45.000Z",
    );
    expect(first?.attempts).toBe(1);

    const reclaimed = await repository.claimUploadPreparation(
      command.id,
      "2026-09-21T00:01:00.000Z",
      "2026-09-21T00:01:45.000Z",
    );
    expect(reclaimed).toMatchObject({
      attempts: 2,
      preparationState: "claimed",
      uploadId: command.id,
    });
  });

  test("stale attempts cannot record progress or mark prepared", async () => {
    const manifest = manifestFixture("stale fencing");
    const command = uploadCommand("upl_stale_fence", manifest);
    await repository.createStagedUpload(command);

    const first = await repository.claimUploadPreparation(
      command.id,
      "2026-09-21T00:00:00.000Z",
      "2026-09-21T00:00:45.000Z",
    );
    expect(first?.attempts).toBe(1);

    const reclaimerNow = "2026-09-21T00:01:00.000Z";
    const reclaimed = await repository.claimUploadPreparation(
      command.id,
      reclaimerNow,
      "2026-09-21T00:01:45.000Z",
    );
    expect(reclaimed?.attempts).toBe(2);

    await expect(repository.recordStagedFileInstalled(
      command.id,
      command.files[0]?.storageToken ?? "",
      1,
      reclaimerNow,
    )).rejects.toThrow(UploadPreparationLeaseLost);

    await expect(repository.markUploadPrepared(
      command.id,
      1,
      reclaimerNow,
    )).rejects.toThrow(UploadPreparationLeaseLost);
  });

  test("committed upload cannot be claimed", async () => {
    const manifest = manifestFixture("committed upload");
    const command = uploadCommand("upl_committed", manifest);
    await repository.createStagedUpload(command);

    const versionId = "ver_preparation_committed";
    const artifactId = "art_preparation_committed";
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    const raw = new DatabaseSync(databasePath);
    try {
      raw.exec(`
        INSERT INTO artifacts (id, project_id, name, search_name, access_setting, current_version_id, created_at, deleted_at)
        VALUES ('${artifactId}', '${projectId}', 'Committed', 'committed', 'account_required', NULL, '2026-09-21T00:00:00.000Z', NULL);
        INSERT INTO versions (id, project_id, artifact_id, number, manifest_digest, entry_path, routing_mode, content_token, publisher_principal_id, created_at)
        VALUES ('${versionId}', '${projectId}', '${artifactId}', 1, '${manifest.digest}', '${manifest.entryPath}', '${manifest.routingMode}', 'token-committed', '${principalId}', '2026-09-21T00:00:00.000Z');
        UPDATE staged_uploads SET status = 'committed', committed_version_id = '${versionId}'
        WHERE id = '${command.id}';
      `);
    } finally {
      raw.close();
    }

    const claim = await repository.claimUploadPreparation(
      command.id,
      "2026-09-21T00:00:00.000Z",
      "2026-09-21T00:00:45.000Z",
    );
    expect(claim).toBeNull();
  });

  test("release resets a claimed upload so it can be reclaimed", async () => {
    const manifest = manifestFixture("release and reclaim");
    const command = uploadCommand("upl_release_reclaim", manifest);
    await repository.createStagedUpload(command);

    const first = await repository.claimUploadPreparation(
      command.id,
      "2026-09-21T00:00:00.000Z",
      "2026-09-21T00:00:45.000Z",
    );
    expect(first?.attempts).toBe(1);

    await repository.releaseUploadPreparation(command.id, 1);

    const released = await repository.findStagedUpload(projectId, command.id, principalId);
    expect(released).toMatchObject({
      preparationAttempts: 1,
      preparationLeaseExpiresAt: null,
      preparationState: "none",
    });

    const second = await repository.claimUploadPreparation(
      command.id,
      "2026-09-21T00:00:10.000Z",
      "2026-09-21T00:00:55.000Z",
    );
    expect(second).toMatchObject({
      attempts: 2,
      preparationState: "claimed",
      uploadId: command.id,
    });
  });

  test("release with stale attempts leaves the lease intact", async () => {
    const manifest = manifestFixture("stale release");
    const command = uploadCommand("upl_stale_release", manifest);
    await repository.createStagedUpload(command);

    const lease = "2026-09-21T00:00:45.000Z";
    await repository.claimUploadPreparation(
      command.id,
      "2026-09-21T00:00:00.000Z",
      lease,
    );

    await repository.releaseUploadPreparation(command.id, 99);

    const upload = await repository.findStagedUpload(projectId, command.id, principalId);
    expect(upload).toMatchObject({
      preparationAttempts: 1,
      preparationLeaseExpiresAt: lease,
      preparationState: "claimed",
    });
  });

  test("release on prepared or none upload does nothing", async () => {
    const manifest = manifestFixture("release no-op");
    const command = uploadCommand("upl_release_noop", manifest);
    await repository.createStagedUpload(command);

    await repository.releaseUploadPreparation(command.id, 0);
    const untouched = await repository.findStagedUpload(projectId, command.id, principalId);
    expect(untouched?.preparationState).toBe("none");

    const claim = await repository.claimUploadPreparation(
      command.id,
      "2026-09-21T00:00:00.000Z",
      "2026-09-21T00:00:45.000Z",
    );
    await repository.markUploadPrepared(
      command.id,
      claim?.attempts ?? 1,
      "2026-09-21T00:00:30.000Z",
    );

    await repository.releaseUploadPreparation(command.id, claim?.attempts ?? 1);
    const prepared = await repository.findStagedUpload(projectId, command.id, principalId);
    expect(prepared?.preparationState).toBe("prepared");
  });

  test("in-place schema upgrade preserves rows and defaults new columns", async () => {
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
          idempotency_key TEXT,
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
          routing_mode, created_at, expires_at, committed_version_id, idempotency_key
        ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, NULL, ?)
      `).run(
        "upl_legacy",
        defaultProjectId,
        principalId,
        manifest.digest,
        manifest.entryPath,
        manifest.routingMode,
        "2026-09-21T00:00:00.000Z",
        "2026-09-21T01:00:00.000Z",
        "idem-legacy",
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
      idempotencyKey: "idem-legacy",
      preparationAttempts: 0,
      preparationState: "none",
      status: "open",
    });

    const claim = await repository.claimUploadPreparation(
      "upl_legacy",
      "2026-09-21T00:00:00.000Z",
      "2026-09-21T00:00:45.000Z",
    );
    expect(claim?.attempts).toBe(1);
  });
});
