import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";

import {defaultProjectId} from "../../../src/core/model.js";
import type {PublicationSource} from "../../../src/core/ports.js";
import {createManifest} from "../../../src/manifest/create-manifest.js";
import {createD1ArtifactRepository} from "../src/d1-artifact-repository.js";
import {migrateD1} from "../src/d1-migrations.js";

const openLocalD1 = () => getPlatformProxy<{
  ARTIFACT_SERVER_D1_DATABASE: D1Database;
}>({
  configPath: fileURLToPath(new URL("../wrangler.git-store.test.jsonc", import.meta.url)),
  envFiles: [],
  persist: false,
  remoteBindings: false,
});

const principalId = "principal-d1-version-pagination";
const projectId = defaultProjectId;
const artifactId = "art_d1_paged_versions";

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

function uploadCommand(
  id: string,
  manifest: ReturnType<typeof makeManifest>,
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
  store: ReturnType<typeof createD1ArtifactRepository>,
  binding: D1Database,
  manifest: ReturnType<typeof makeManifest>,
  uploadId: string,
  createdAt: string,
): Promise<PublicationSource> {
  const command = uploadCommand(uploadId, manifest, createdAt);
  await store.createStagedUpload(command);
  await Promise.all(command.files.map((file) =>
    store.markStagedFileUploaded(projectId, uploadId, principalId, file.storageToken, createdAt),
  ));
  const leaseExpiresAt = new Date(Date.parse(createdAt) + 10 * 60 * 1_000).toISOString();
  await store.claimUploadPreparation(uploadId, createdAt, leaseExpiresAt);
  const attempts = 1;
  await Promise.all(command.files.map((file) =>
    store.recordStagedFileInstalled(uploadId, file.storageToken, attempts, createdAt),
  ));
  await store.writePreparedManifestEntries(uploadId, attempts, manifest.entries);
  await store.markUploadPrepared(uploadId, attempts, createdAt);
  return {kind: "staged_upload", principalId, projectId, uploadId};
}

async function commitVersion(
  store: ReturnType<typeof createD1ArtifactRepository>,
  binding: D1Database,
  uploadId: string,
  versionId: string,
  createdAt: string,
  expectedCurrentVersionId: string | null,
) {
  const manifest = makeManifest(`version-${uploadId}`);
  const source = await stageUpload(store, binding, manifest, uploadId, createdAt);
  const contentToken = `content-${uploadId}`;
  const inputDigest = `digest-${uploadId}`;
  if (expectedCurrentVersionId === null) {
    return store.commitNewArtifact({
      accessSetting: "account_required",
      artifactId,
      authorizedByPrincipalId: null,
      contentToken,
      createdAt,
      idempotencyKey: `publish-${uploadId}`,
      inputDigest,
      manifest,
      name: "D1 paged versions",
      principalId,
      projectId,
      source,
      tags: [],
      versionId,
    });
  }
  return store.commitVersion({
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

describe("D1 version pagination", () => {
  it("listArtifactVersionsPage returns newest first with no duplicates or omissions", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-version-pagination";
    try {
      await migrateD1(binding, installationId);
      const store = createD1ArtifactRepository(binding, installationId);

      const first = await commitVersion(store, binding, "upl_v1", "ver_v1", "2026-09-20T00:00:00.000Z", null);
      const second = await commitVersion(store, binding, "upl_v2", "ver_v2", "2026-09-20T00:01:00.000Z", first.version.id);
      const third = await commitVersion(store, binding, "upl_v3", "ver_v3", "2026-09-20T00:02:00.000Z", second.version.id);
      const expectedIds = [third.version.id, second.version.id, first.version.id];

      const page1 = await store.listArtifactVersionsPage(projectId, artifactId, null, 1);
      expect(page1.items.map((version) => version.id)).toEqual([expectedIds[0]]);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await store.listArtifactVersionsPage(projectId, artifactId, page1.nextCursor, 1);
      expect(page2.items.map((version) => version.id)).toEqual([expectedIds[1]]);
      expect(page2.nextCursor).not.toBeNull();

      const page3 = await store.listArtifactVersionsPage(projectId, artifactId, page2.nextCursor, 1);
      expect(page3.items.map((version) => version.id)).toEqual([expectedIds[2]]);
      expect(page3.nextCursor).toBeNull();

      const allPageIds = [
        ...page1.items.map((version) => version.id),
        ...page2.items.map((version) => version.id),
        ...page3.items.map((version) => version.id),
      ];
      expect(allPageIds).toEqual(expectedIds);
      expect(new Set(allPageIds).size).toBe(3);

      const emptyPage = await store.listArtifactVersionsPage(
        projectId,
        artifactId,
        {createdAt: "2026-09-19T00:00:00.000Z", id: "zzzzzzzz"},
        1,
      );
      expect(emptyPage.items).toHaveLength(0);
      expect(emptyPage.nextCursor).toBeNull();
    } finally {
      await proxy.dispose();
    }
  });

  it("listManifestEntriesPage reads one exact version in bounded path order", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-manifest-pagination";
    try {
      await migrateD1(binding, installationId);
      const store = createD1ArtifactRepository(binding, installationId);
      const committed = await commitVersion(
        store, binding, "upl_manifest", "ver_manifest", "2026-09-20T00:00:00.000Z", null,
      );
      const metadata = await store.findVersionMetadata(
        projectId, artifactId, committed.version.id,
      );
      expect(metadata?.manifestDigest).toBe(committed.version.manifestDigest);
      const first = await store.listManifestEntriesPage(
        projectId, artifactId, committed.version.id, null, 2,
      );
      expect(first.entries.map((entry) => entry.path)).toEqual(["a.css", "index.html"]);
      expect(first.nextCursor).toBe("index.html");
      const second = await store.listManifestEntriesPage(
        projectId, artifactId, committed.version.id, first.nextCursor, 2,
      );
      expect(second.entries.map((entry) => entry.path)).toEqual(["z.js", "\uE000.txt"]);
      expect(second.nextCursor).toBe("\uE000.txt");
      const third = await store.listManifestEntriesPage(
        projectId, artifactId, committed.version.id, second.nextCursor, 2,
      );
      expect(third.entries.map((entry) => entry.path)).toEqual(["\u{1F600}.txt"]);
      expect(third.nextCursor).toBeNull();
      const foreign = await store.listManifestEntriesPage(
        projectId, "art_other", committed.version.id, null, 2,
      );
      expect(foreign.entries).toEqual([]);
    } finally {
      await proxy.dispose();
    }
  });
});
