import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultProjectId} from "../../src/core/model.js";
import type {PublicationSource} from "../../src/core/ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

const principalId = "principal-version-pagination";
const projectId = defaultProjectId;
const artifactId = "art_paged_versions";

function makeManifest(body: string) {
  return createManifest({
    entryPath: "index.html",
    files: ["a.css", "index.html", "z.js", "\uE000.txt", "\u{1F600}.txt"].map((filePath) => {
      const bytes = new TextEncoder().encode(`${body}-${filePath}`);
      return {
        mediaType: filePath.endsWith(".html") ? "text/html" : "text/plain",
        path: filePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      };
    }),
    routingMode: "static",
  });
}

async function stageUpload(
  repository: SqliteArtifactRepository,
  manifest: ReturnType<typeof makeManifest>,
  uploadId: string,
  createdAt: string,
): Promise<PublicationSource> {
  const files = manifest.entries.map((entry, index) => ({
    entry,
    storageToken: `${uploadId}-file-${index}`,
  }));
  await repository.createStagedUpload({
    createdAt,
    expiresAt: "2026-12-31T00:00:00.000Z",
    files,
    id: uploadId,
    idempotencyKey: null,
    manifest,
    principalId,
    projectId,
  });
  await Promise.all(files.map((file) => repository.markStagedFileUploaded(
    projectId,
    uploadId,
    principalId,
    file.storageToken,
    createdAt,
  )));
  const leaseExpiresAt = new Date(Date.parse(createdAt) + 10 * 60 * 1_000).toISOString();
  await repository.claimUploadPreparation(uploadId, createdAt, leaseExpiresAt);
  const attempts = 1;
  await Promise.all(files.map((file) =>
    repository.recordStagedFileInstalled(uploadId, file.storageToken, attempts, createdAt),
  ));
  await repository.writePreparedManifestEntries(uploadId, attempts, manifest.entries);
  await repository.markUploadPrepared(uploadId, attempts, createdAt);
  return {
    kind: "staged_upload",
    principalId,
    projectId,
    uploadId,
  };
}

async function commitVersion(
  repository: SqliteArtifactRepository,
  uploadId: string,
  versionId: string,
  createdAt: string,
  expectedCurrentVersionId: string | null,
) {
  const manifest = makeManifest(`version-${uploadId}`);
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
      name: "Paged versions",
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

describe("sqlite version pagination", () => {
  let databasePath: string;
  let dataDirectory: string;
  let repository: SqliteArtifactRepository;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-version-pagination-"));
    databasePath = path.join(dataDirectory, "artifact-server.db");
    repository = new SqliteArtifactRepository(databasePath);
  });

  afterEach(async () => {
    repository.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("listArtifactVersionsPage returns newest first with no duplicates or omissions", async () => {
    expect.hasAssertions();
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

  test("listArtifactVersionsPage returns an empty page for a missing artifact", async () => {
    expect.hasAssertions();
    const page = await repository.listArtifactVersionsPage(
      projectId,
      "art_missing",
      null,
      1,
    );
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  test("listManifestEntriesPage reads one exact version in bounded path order", async () => {
    const committed = await commitVersion(
      repository,
      "upl_manifest",
      "ver_manifest",
      "2026-09-20T00:00:00.000Z",
      null,
    );
    const metadata = await repository.findVersionMetadata(
      projectId, artifactId, committed.version.id,
    );
    expect(metadata?.manifestDigest).toBe(committed.version.manifestDigest);
    const first = await repository.listManifestEntriesPage(
      projectId, artifactId, committed.version.id, null, 2,
    );
    expect(first.entries.map((entry) => entry.path)).toEqual(["a.css", "index.html"]);
    expect(first.nextCursor).toBe("index.html");
    const second = await repository.listManifestEntriesPage(
      projectId, artifactId, committed.version.id, first.nextCursor, 2,
    );
    expect(second.entries.map((entry) => entry.path)).toEqual(["z.js", "\uE000.txt"]);
    expect(second.nextCursor).toBe("\uE000.txt");
    const third = await repository.listManifestEntriesPage(
      projectId, artifactId, committed.version.id, second.nextCursor, 2,
    );
    expect(third.entries.map((entry) => entry.path)).toEqual(["\u{1F600}.txt"]);
    expect(third.nextCursor).toBeNull();
    const foreign = await repository.listManifestEntriesPage(
      projectId, "art_other", committed.version.id, null, 2,
    );
    expect(foreign.entries).toEqual([]);
  });
});
