import {createHash, randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultProjectId} from "../../src/core/model.js";
import {UploadPreparationLeaseLost} from "../../src/core/upload-preparation.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";

const principalId = "principal-preparation";
const projectId = defaultProjectId;

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

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

function stagedUploadCommand(
  id: string,
  manifest: ReturnType<typeof manifestFixture>,
  principal: string = principalId,
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
    principalId: principal,
    projectId,
  };
}

describe("Postgres staged upload preparation", () => {
  let database: PostgresDatabase;
  let repository: PostgresArtifactRepository;
  let installationId: string;
  const scratchDatabases: string[] = [];

  beforeEach(async () => {
    database = await PostgresDatabase.open(
      {url: Redacted.make(readDatabaseUrl())},
      "apply",
    );
    installationId = `test-staged-preparation-${randomUUID()}`;
    repository = await PostgresArtifactRepository.open(database, installationId);
  });

  afterEach(async () => {
    await Promise.all(scratchDatabases.splice(0).map((scratch) =>
      database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
      }))
    ));
    await database.close();
  });

  test("claim succeeds on an open upload", async () => {
    const manifest = manifestFixture("open upload");
    const command = stagedUploadCommand("upl_claim_open", manifest);
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
    const command = stagedUploadCommand("upl_double_claim", manifest);
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
    const command = stagedUploadCommand("upl_expired_claim", manifest);
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
    const command = stagedUploadCommand("upl_stale_fence", manifest);
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
    const command = stagedUploadCommand("upl_committed", manifest);
    await repository.createStagedUpload(command);

    const versionId = "ver_preparation_committed";
    const artifactId = "art_preparation_committed";
    await database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO artifacts (
        installation_id, id, name, search_name, access_setting,
        current_version_id, created_at, deleted_at
      ) VALUES (
        ${installationId}, ${artifactId}, ${"Committed"}, ${"committed"},
        ${"account_required"}, NULL, ${"2026-09-21T00:00:00.000Z"}, NULL
      )`;
      yield* sql`INSERT INTO versions (
        installation_id, id, project_id, artifact_id, number,
        manifest_digest, entry_path, routing_mode, content_token,
        publisher_principal_id, created_at
      ) VALUES (
        ${installationId}, ${versionId}, ${projectId}, ${artifactId}, 1,
        ${manifest.digest}, ${manifest.entryPath}, ${manifest.routingMode},
        ${"token-committed"}, ${principalId}, ${"2026-09-21T00:00:00.000Z"}
      )`;
      yield* sql`UPDATE staged_uploads
        SET status = 'committed', committed_version_id = ${versionId}
        WHERE installation_id = ${installationId} AND id = ${command.id}`;
    }));

    const claim = await repository.claimUploadPreparation(
      command.id,
      "2026-09-21T00:00:00.000Z",
      "2026-09-21T00:00:45.000Z",
    );
    expect(claim).toBeNull();
  });

  test("release resets a claimed upload so it can be reclaimed", async () => {
    const manifest = manifestFixture("release and reclaim");
    const command = stagedUploadCommand("upl_release_reclaim", manifest);
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
    const command = stagedUploadCommand("upl_stale_release", manifest);
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
    const command = stagedUploadCommand("upl_release_noop", manifest);
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

  test("a pre-0015 database upgrades and preserves staged uploads", async () => {
    const scratch = `artifact_staged_prep_${randomUUID().replaceAll("-", "")}`;
    scratchDatabases.push(scratch);
    await database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));

    const scratchUrl = new URL(readDatabaseUrl());
    scratchUrl.pathname = `/${scratch}`;
    const legacyUrl = Redacted.make(scratchUrl.toString());

    const legacy = await PostgresDatabase.inspect({url: legacyUrl});
    try {
      const manifest = manifestFixture("legacy upload");
      await legacy.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* sql.unsafe(`CREATE TABLE artifact_installations (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL
        )`);
        yield* sql.unsafe(`CREATE TABLE projects (
          installation_id TEXT NOT NULL,
          id TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          archived_at TEXT,
          PRIMARY KEY (installation_id, id)
        )`);
        yield* sql.unsafe(`CREATE TABLE artifacts (
          installation_id TEXT NOT NULL,
          id TEXT NOT NULL,
          PRIMARY KEY (installation_id, id)
        )`);
        yield* sql.unsafe(`CREATE TABLE staged_uploads (
          installation_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          id TEXT NOT NULL,
          principal_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'committed')),
          manifest_digest TEXT NOT NULL,
          entry_path TEXT NOT NULL,
          routing_mode TEXT NOT NULL CHECK (routing_mode IN ('static', 'spa')),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          committed_version_id TEXT,
          idempotency_key TEXT,
          PRIMARY KEY (installation_id, id),
          FOREIGN KEY (installation_id, project_id)
            REFERENCES projects(installation_id, id),
          CHECK (
            (status = 'open' AND committed_version_id IS NULL)
            OR (status = 'committed' AND committed_version_id IS NOT NULL)
          )
        )`);
        yield* sql.unsafe(`CREATE TABLE staged_upload_files (
          installation_id TEXT NOT NULL,
          upload_id TEXT NOT NULL,
          storage_token TEXT NOT NULL,
          path TEXT NOT NULL,
          size BIGINT NOT NULL CHECK (size >= 0),
          media_type TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          disposition TEXT NOT NULL CHECK (disposition IN ('inline', 'attachment')),
          uploaded_at TEXT,
          PRIMARY KEY (installation_id, upload_id, path),
          UNIQUE (installation_id, storage_token),
          FOREIGN KEY (installation_id, upload_id)
            REFERENCES staged_uploads(installation_id, id)
        )`);
        yield* sql.unsafe(`CREATE TABLE artifact_server_postgres_migrations (
          migration_id INTEGER PRIMARY KEY,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          name TEXT NOT NULL
        )`);
        const applied = [
          "initial_shared_schema",
          "project_scoped_artifacts",
          "spa_routing",
          "comment_threads",
          "login_attempt_nonce",
          "agent_dispatch",
          "git_history_provider_identity",
          "project_git_history_setting",
          "git_history_mirror",
          "agent_capabilities",
          "artifact_search_name",
          "git_history_reconciliation_index",
          "staged_upload_idempotency",
          "artifact_comment_revision",
        ] as const;
        for (const [index, name] of applied.entries()) {
          yield* sql`INSERT INTO artifact_server_postgres_migrations (
            migration_id, name
          ) VALUES (${index + 1}, ${name})`;
        }
        yield* sql`INSERT INTO artifact_installations (id, created_at)
          VALUES (${installationId}, ${"2026-09-21T00:00:00.000Z"})`;
        yield* sql`INSERT INTO projects (
          installation_id, id, name, created_at, archived_at
        ) VALUES (
          ${installationId}, ${projectId}, ${"Default"},
          ${"2026-09-21T00:00:00.000Z"}, NULL
        )`;
        yield* sql`INSERT INTO staged_uploads (
          installation_id, project_id, id, principal_id, status,
          manifest_digest, entry_path, routing_mode, created_at, expires_at,
          committed_version_id, idempotency_key
        ) VALUES (
          ${installationId}, ${projectId}, ${"upl_legacy"}, ${principalId},
          ${"open"}, ${manifest.digest}, ${manifest.entryPath},
          ${manifest.routingMode}, ${"2026-09-21T00:00:00.000Z"},
          ${"2026-09-21T01:00:00.000Z"}, NULL, ${"idem-legacy"}
        )`;
        const entry = manifest.entries[0];
        if (entry === undefined) throw new Error("The fixture has one file.");
        yield* sql`INSERT INTO staged_upload_files (
          installation_id, upload_id, storage_token, path, size, media_type,
          sha256, disposition, uploaded_at
        ) VALUES (
          ${installationId}, ${"upl_legacy"}, ${"token-legacy"}, ${entry.path},
          ${entry.size}, ${entry.mediaType}, ${entry.sha256}, ${"inline"}, NULL
        )`;
      }));
    } finally {
      await legacy.close();
    }

    const upgraded = await PostgresDatabase.open({url: legacyUrl}, "apply");
    try {
      const upgradedRepository = await PostgresArtifactRepository.open(
        upgraded,
        installationId,
      );
      const legacyUpload = await upgradedRepository.findStagedUpload(
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

      const claim = await upgradedRepository.claimUploadPreparation(
        "upl_legacy",
        "2026-09-21T00:00:00.000Z",
        "2026-09-21T00:00:45.000Z",
      );
      expect(claim?.attempts).toBe(1);
    } finally {
      await upgraded.close();
    }
  });
});
