import {createHash, randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultProjectId} from "../../src/core/model.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";

const principalId = "principal-idempotency";
const projectId = defaultProjectId;

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Expected an Error rejection.", {cause: error});
  }
  throw new Error("Expected the operation to reject.");
}

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
  idempotencyKey: string | null,
  manifest: ReturnType<typeof manifestFixture>,
  principal: string = principalId,
) {
  return {
    createdAt: "2026-09-21T00:00:00.000Z",
    expiresAt: "2026-09-21T01:00:00.000Z",
    files: manifest.entries.map((entry) => ({
      entry,
      storageToken: `token-${id}-${entry.sha256}`,
    })),
    id,
    idempotencyKey,
    manifest,
    principalId: principal,
    projectId,
  };
}

describe("Postgres staged upload idempotency key", () => {
  let database: PostgresDatabase;
  let repository: PostgresArtifactRepository;
  let installationId: string;
  const scratchDatabases: string[] = [];

  beforeEach(async () => {
    database = await PostgresDatabase.open(
      {url: Redacted.make(readDatabaseUrl())},
      "apply",
    );
    installationId = `test-staged-idempotency-${randomUUID()}`;
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

  test("a key-bound upload is found by idempotency key", async () => {
    const manifest = manifestFixture("key-bound upload");
    const created = await repository.createStagedUpload(
      stagedUploadCommand("upl_key_bound", "idem-key-bound", manifest),
    );

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
    await repository.createStagedUpload(
      stagedUploadCommand("upl_isolation", "idem-isolation", manifest),
    );

    await expect(repository.findStagedUploadByIdempotencyKey(
      projectId,
      "principal-other",
      "idem-isolation",
    )).resolves.toBeNull();

    const other = await repository.createStagedUpload(
      stagedUploadCommand(
        "upl_isolation_other",
        "idem-isolation",
        manifest,
        "principal-other",
      ),
    );
    expect(other.id).toBe("upl_isolation_other");
  });

  test("a second upload with the same key fails with a uniqueness violation", async () => {
    const manifest = manifestFixture("duplicate key");
    await repository.createStagedUpload(
      stagedUploadCommand("upl_first_duplicate", "idem-duplicate", manifest),
    );

    const duplicate = await captureRejection(repository.createStagedUpload(
      stagedUploadCommand("upl_second_duplicate", "idem-duplicate", manifest),
    ));

    expect(duplicate).toMatchObject({
      _tag: "SqlError",
      cause: {_tag: expect.stringMatching(/UniqueViolation|ConstraintError/)},
    });
  });

  test("null-key uploads coexist and do not conflict", async () => {
    const manifest = manifestFixture("null key coexistence");
    const first = await repository.createStagedUpload(
      stagedUploadCommand("upl_null_a", null, manifest),
    );
    const second = await repository.createStagedUpload(
      stagedUploadCommand("upl_null_b", null, manifest),
    );

    expect(first.idempotencyKey).toBeNull();
    expect(second.idempotencyKey).toBeNull();
    expect(first.id).not.toBe(second.id);
  });

  test("a pre-0013 database upgrades and preserves staged uploads", async () => {
    const scratch = `artifact_staged_idem_${randomUUID().replaceAll("-", "")}`;
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
          committed_version_id
        ) VALUES (
          ${installationId}, ${projectId}, ${"upl_legacy"}, ${principalId},
          ${"open"}, ${manifest.digest}, ${manifest.entryPath},
          ${manifest.routingMode}, ${"2026-09-21T00:00:00.000Z"},
          ${"2026-09-21T01:00:00.000Z"}, NULL
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
        idempotencyKey: null,
        status: "open",
      });

      const manifest = manifestFixture("post-upgrade upload");
      const created = await upgradedRepository.createStagedUpload(
        stagedUploadCommand("upl_upgraded", "idem-upgraded", manifest),
      );
      expect(created.idempotencyKey).toBe("idem-upgraded");
      await expect(upgradedRepository.findStagedUploadByIdempotencyKey(
        projectId,
        principalId,
        "idem-upgraded",
      )).resolves.toMatchObject({id: "upl_upgraded"});

      const duplicate = await captureRejection(upgradedRepository.createStagedUpload(
        stagedUploadCommand("upl_upgraded_duplicate", "idem-upgraded", manifest),
      ));
      expect(duplicate).toMatchObject({
        _tag: "SqlError",
        cause: {_tag: expect.stringMatching(/UniqueViolation|ConstraintError/)},
      });
    } finally {
      await upgraded.close();
    }
  });
});
