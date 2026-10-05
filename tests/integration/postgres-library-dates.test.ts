import {createHash, randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultProjectId} from "../../src/core/model.js";
import type {PublicationSource} from "../../src/core/ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";

const principalId = "principal-library-dates";
const projectId = defaultProjectId;
const artifactId = "art_pg_library_dates";
const author = {authorizedByPrincipalId: null, displayName: "Reviewer", principalId, principalKind: "service"} as const;

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
    ? repository.commitNewArtifact({...common, accessSetting: "account_required", artifactId, name: "Library dates", tags: []})
    : repository.commitVersion({...common, artifactId, expectedCurrentVersionId});
}

describe("Postgres library dates", () => {
  const scratch = `artifact_library_dates_${randomUUID().replaceAll("-", "")}`;
  let maintenance: PostgresDatabase;
  let database: PostgresDatabase;
  let installationId: string;
  let repository: PostgresArtifactRepository;

  beforeEach(async () => {
    maintenance = await PostgresDatabase.inspect({url: Redacted.make(readDatabaseUrl())});
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));
    const scratchUrl = new URL(readDatabaseUrl());
    scratchUrl.pathname = `/${scratch}`;
    database = await PostgresDatabase.open({url: Redacted.make(scratchUrl.toString())}, "apply");
    installationId = `test-library-dates-${randomUUID()}`;
    repository = await PostgresArtifactRepository.open(database, installationId);
  });

  afterEach(async () => {
    await database.close();
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }));
    await maintenance.close();
  });

  test("foundation: Postgres page dates follow creation, change, re-add, and comments within one installation", async () => {
    const t1 = "2026-10-01T00:00:00.000Z";
    const t2 = "2026-10-02T00:00:00.000Z";
    const t3 = "2026-10-03T00:00:00.000Z";
    await commitPages(repository, "ver_one", new Map([["a.html", "a1"], ["b.html", "b1"], ["c.html", "c1"]]), t1, null);
    await commitPages(repository, "ver_two", new Map([["a.html", "a1"], ["b.html", "b2"]]), t2, "ver_one");
    await commitPages(repository, "ver_three", new Map([["a.html", "a1"], ["b.html", "b2"], ["c.html", "c1"]]), t3, "ver_two");
    await repository.createThread({
      anchor: null,
      artifactId,
      author,
      body: "On a.",
      createdAt: "2026-10-04T00:00:00.000Z",
      id: "thr_library_dates",
      idempotencyKey: "library-dates-thread",
      installationId,
      path: "a.html",
      projectId,
      versionId: "ver_one",
    });
    const replyAt = "2026-10-05T00:00:00.000Z";
    await repository.createReply({
      artifactId,
      author,
      body: "Reply.",
      createdAt: replyAt,
      id: "rpl_library_dates",
      idempotencyKey: "library-dates-reply",
      projectId,
      threadId: "thr_library_dates",
    });

    const request = [{artifactId, currentVersionNumber: 3, paths: ["a.html", "b.html", "c.html"]}];
    const byPath = new Map((await repository.libraryPageDates(request)).map((row) => [row.path, row]));
    expect(byPath.get("a.html")).toMatchObject({changedAt: t1, commentedAt: replyAt, createdAt: t1});
    expect(byPath.get("b.html")).toMatchObject({changedAt: t2, commentedAt: null, createdAt: t1});
    expect(byPath.get("c.html")).toMatchObject({changedAt: t3, commentedAt: null, createdAt: t1});

    const otherInstallation = await PostgresArtifactRepository.open(database, `test-library-dates-other-${randomUUID()}`);
    expect(await otherInstallation.libraryPageDates(request)).toEqual([]);
  });
});
