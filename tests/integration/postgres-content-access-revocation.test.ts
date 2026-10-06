import {createHash, randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultProjectId} from "../../src/core/model.js";
import type {PublicationSource} from "../../src/core/ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";

const principalId = "principal-content-revocation";
const projectId = defaultProjectId;
const artifactId = "art_pg_content_revocation";

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

/** One version's pages, each path mapped to its body text. */
function manifestFor(pages: ReadonlyMap<string, string>) {
  return createManifest({
    entryPath: "a.html",
    files: [...pages].map(([filePath, body]) => {
      const bytes = new TextEncoder().encode(body);
      return {
        mediaType: "text/html",
        path: filePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      };
    }),
    routingMode: "static",
  });
}

async function stageUpload(
  repository: PostgresArtifactRepository,
  manifest: ReturnType<typeof manifestFor>,
  uploadId: string,
  createdAt: string,
): Promise<PublicationSource> {
  const command = {
    createdAt,
    expiresAt: "2026-12-31T00:00:00.000Z",
    files: manifest.entries.map((entry) => ({entry, storageToken: `token-${uploadId}-${entry.sha256}`})),
    id: uploadId,
    idempotencyKey: null,
    manifest,
    principalId,
    projectId,
  };
  await repository.createStagedUpload(command);
  await Promise.all(command.files.map((file) =>
    repository.markStagedFileUploaded(projectId, uploadId, principalId, file.storageToken, createdAt),
  ));
  const leaseExpiresAt = new Date(Date.parse(createdAt) + 10 * 60 * 1_000).toISOString();
  await repository.claimUploadPreparation(uploadId, createdAt, leaseExpiresAt);
  await Promise.all(command.files.map((file) =>
    repository.recordStagedFileInstalled(uploadId, file.storageToken, 1, createdAt),
  ));
  await repository.writePreparedManifestEntries(uploadId, 1, manifest.entries);
  await repository.markUploadPrepared(uploadId, 1, createdAt);
  return {kind: "staged_upload", principalId, projectId, uploadId};
}

async function commitPages(
  repository: PostgresArtifactRepository,
  versionId: string,
  pages: ReadonlyMap<string, string>,
  createdAt: string,
  expectedCurrentVersionId: string | null,
) {
  const manifest = manifestFor(pages);
  const uploadId = `upl_${versionId}`;
  const source = await stageUpload(repository, manifest, uploadId, createdAt);
  const common = {
    actor: {displayName: "Test publisher", kind: "service"},
    authorizedByPrincipalId: null,
    contentToken: `content-${uploadId}`,
    createdAt,
    idempotencyKey: `publish-${uploadId}`,
    inputDigest: `digest-${uploadId}`,
    manifest,
    principalId,
    projectId,
    source,
    versionId,
  } as const;
  return expectedCurrentVersionId === null
    ? repository.commitNewArtifact({...common, accessSetting: "account_required", artifactId, name: "Content revocation", tags: []})
    : repository.commitVersion({...common, artifactId, expectedCurrentVersionId});
}

describe("Postgres content access revocation", () => {
  const scratch = `artifact_content_revocation_${randomUUID().replaceAll("-", "")}`;
  let maintenance: PostgresDatabase;
  let database: PostgresDatabase;

  beforeEach(async () => {
    maintenance = await PostgresDatabase.inspect({url: Redacted.make(readDatabaseUrl())});
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));
    const scratchUrl = new URL(readDatabaseUrl());
    scratchUrl.pathname = `/${scratch}`;
    database = await PostgresDatabase.open({url: Redacted.make(scratchUrl.toString())}, "apply");
  });

  afterEach(async () => {
    await database.close();
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }));
    await maintenance.close();
  });

  test("foundation: Postgres revocation ends only the named principals' leases within one installation", async () => {
    const now = "2026-10-01T00:00:00.000Z";
    const lease = (repository: PostgresArtifactRepository, tokenDigest: string, leasePrincipal: string) =>
      repository.createPreviewLease({
        artifactId,
        contentToken: "content-upl_ver_one",
        createdAt: now,
        expiresAt: "2026-10-02T00:00:00.000Z",
        principalId: leasePrincipal,
        projectId,
        tokenDigest,
        versionId: "ver_one",
      });
    const repository = await PostgresArtifactRepository.open(database, `test-revocation-${randomUUID()}`);
    const other = await PostgresArtifactRepository.open(database, `test-revocation-other-${randomUUID()}`);
    await commitPages(repository, "ver_one", new Map([["a.html", "a1"]]), now, null);
    await commitPages(other, "ver_one", new Map([["a.html", "a1"]]), now, null);
    await lease(repository, "digest-a1", "p-a");
    await lease(repository, "digest-a2", "p-a");
    await lease(repository, "digest-b", "p-b");
    await lease(other, "digest-other-a", "p-a");

    await repository.revokeContentSessions(["p-a"]);
    expect(await repository.findPreviewLease("digest-a1", now)).toBeNull();
    expect(await repository.findPreviewLease("digest-a2", now)).toBeNull();
    expect(await repository.findPreviewLease("digest-b", now)).not.toBeNull();
    expect(await other.findPreviewLease("digest-other-a", now)).not.toBeNull();
    await repository.revokeContentSessions([]);
    expect(await repository.findPreviewLease("digest-b", now)).not.toBeNull();
  });
});
