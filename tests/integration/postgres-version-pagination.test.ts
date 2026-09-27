import {createHash, randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultProjectId} from "../../src/core/model.js";
import type {PublicationSource} from "../../src/core/ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";

const principalId = "principal-version-pagination";
const projectId = defaultProjectId;
const artifactId = "art_pg_paged_versions";

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
  createdAt: string,
) {
  return {
    createdAt,
    expiresAt: "2026-12-31T00:00:00.000Z",
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

async function stageUpload(
  repository: PostgresArtifactRepository,
  manifest: ReturnType<typeof manifestFixture>,
  uploadId: string,
  createdAt: string,
): Promise<PublicationSource> {
  const command = stagedUploadCommand(uploadId, manifest, createdAt);
  await repository.createStagedUpload(command);
  await Promise.all(command.files.map((file) =>
    repository.markStagedFileUploaded(projectId, uploadId, principalId, file.storageToken, createdAt),
  ));
  const leaseExpiresAt = new Date(Date.parse(createdAt) + 10 * 60 * 1_000).toISOString();
  await repository.claimUploadPreparation(uploadId, createdAt, leaseExpiresAt);
  const attempts = 1;
  await Promise.all(command.files.map((file) =>
    repository.recordStagedFileInstalled(uploadId, file.storageToken, attempts, createdAt),
  ));
  await repository.writePreparedManifestEntries(uploadId, attempts, manifest.entries);
  await repository.markUploadPrepared(uploadId, attempts, createdAt);
  return {kind: "staged_upload", principalId, projectId, uploadId};
}

async function commitVersion(
  repository: PostgresArtifactRepository,
  uploadId: string,
  versionId: string,
  createdAt: string,
  expectedCurrentVersionId: string | null,
) {
  const manifest = manifestFixture(`version-${uploadId}`);
  const source = await stageUpload(repository, manifest, uploadId, createdAt);
  const contentToken = `content-${uploadId}`;
  const inputDigest = `digest-${uploadId}`;
  if (expectedCurrentVersionId === null) {
    return repository.commitNewArtifact({
      accessSetting: "account_required",
      artifactId,
      authorizedByPrincipalId: null,
      contentToken,
      createdAt,
      idempotencyKey: `publish-${uploadId}`,
      inputDigest,
      manifest,
      name: "Postgres paged versions",
      principalId,
      projectId,
      source,
      tags: [],
      versionId,
    });
  }
  return repository.commitVersion({
    artifactId,
    authorizedByPrincipalId: null,
    contentToken,
    createdAt,
    expectedCurrentVersionId,
    idempotencyKey: `publish-${uploadId}`,
    inputDigest,
    manifest,
    principalId,
    projectId,
    source,
    versionId,
  });
}

describe("Postgres version pagination", () => {
  const scratch = `artifact_version_pagination_${randomUUID().replaceAll("-", "")}`;
  let maintenance: PostgresDatabase;
  let database: PostgresDatabase;
  let repository: PostgresArtifactRepository;

  beforeEach(async () => {
    maintenance = await PostgresDatabase.inspect({
      url: Redacted.make(readDatabaseUrl()),
    });
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));
    const scratchUrl = new URL(readDatabaseUrl());
    scratchUrl.pathname = `/${scratch}`;
    database = await PostgresDatabase.open(
      {url: Redacted.make(scratchUrl.toString())},
      "apply",
    );
    repository = await PostgresArtifactRepository.open(
      database,
      `test-version-pagination-${randomUUID()}`,
    );
  });

  afterEach(async () => {
    await database.close();
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }));
    await maintenance.close();
  });

  test("listArtifactVersionsPage returns newest first with no duplicates or omissions", async () => {
    const first = await commitVersion(
      repository,
      "upl_v1",
      "ver_v1",
      "2026-09-20T00:00:00.000Z",
      null,
    );
    const second = await commitVersion(
      repository,
      "upl_v2",
      "ver_v2",
      "2026-09-20T00:01:00.000Z",
      first.version.id,
    );
    const third = await commitVersion(
      repository,
      "upl_v3",
      "ver_v3",
      "2026-09-20T00:02:00.000Z",
      second.version.id,
    );
    const expectedIds = [third.version.id, second.version.id, first.version.id];

    const page1 = await repository.listArtifactVersionsPage(
      projectId,
      artifactId,
      null,
      1,
    );
    expect(page1.items.map((version) => version.id)).toEqual([expectedIds[0]]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await repository.listArtifactVersionsPage(
      projectId,
      artifactId,
      page1.nextCursor,
      1,
    );
    expect(page2.items.map((version) => version.id)).toEqual([expectedIds[1]]);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await repository.listArtifactVersionsPage(
      projectId,
      artifactId,
      page2.nextCursor,
      1,
    );
    expect(page3.items.map((version) => version.id)).toEqual([expectedIds[2]]);
    expect(page3.nextCursor).toBeNull();

    const allPageIds = [
      ...page1.items.map((version) => version.id),
      ...page2.items.map((version) => version.id),
      ...page3.items.map((version) => version.id),
    ];
    expect(allPageIds).toEqual(expectedIds);
    expect(new Set(allPageIds).size).toBe(3);

    const emptyPage = await repository.listArtifactVersionsPage(
      projectId,
      artifactId,
      {createdAt: "2026-09-19T00:00:00.000Z", id: "zzzzzzzz"},
      1,
    );
    expect(emptyPage.items).toHaveLength(0);
    expect(emptyPage.nextCursor).toBeNull();
  });
});
