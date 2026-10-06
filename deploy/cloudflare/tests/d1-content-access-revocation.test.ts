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

const principalId = "principal-d1-content-revocation";
const projectId = defaultProjectId;
const artifactId = "art_d1_content_revocation";

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
  store: ReturnType<typeof createD1ArtifactRepository>,
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
  await store.createStagedUpload(command);
  await Promise.all(command.files.map((file) =>
    store.markStagedFileUploaded(projectId, uploadId, principalId, file.storageToken, createdAt),
  ));
  const leaseExpiresAt = new Date(Date.parse(createdAt) + 10 * 60 * 1_000).toISOString();
  await store.claimUploadPreparation(uploadId, createdAt, leaseExpiresAt);
  await Promise.all(command.files.map((file) =>
    store.recordStagedFileInstalled(uploadId, file.storageToken, 1, createdAt),
  ));
  await store.writePreparedManifestEntries(uploadId, 1, manifest.entries);
  await store.markUploadPrepared(uploadId, 1, createdAt);
  return {kind: "staged_upload", principalId, projectId, uploadId};
}

async function commitPages(
  store: ReturnType<typeof createD1ArtifactRepository>,
  versionId: string,
  pages: ReadonlyMap<string, string>,
  createdAt: string,
  expectedCurrentVersionId: string | null,
) {
  const manifest = manifestFor(pages);
  const uploadId = `upl_${versionId}`;
  const source = await stageUpload(store, manifest, uploadId, createdAt);
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
    ? store.commitNewArtifact({...common, accessSetting: "account_required", artifactId, name: "D1 content revocation", tags: []})
    : store.commitVersion({...common, artifactId, expectedCurrentVersionId});
}

describe("D1 content access revocation", () => {
  it("foundation: D1 revocation ends only the named principals' leases", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-content-revocation";
    try {
      await migrateD1(binding, installationId);
      const store = createD1ArtifactRepository(binding, installationId);
      const now = "2026-10-01T00:00:00.000Z";
      await commitPages(store, "ver_one", new Map([["a.html", "a1"]]), now, null);
      const lease = (tokenDigest: string, leasePrincipal: string) => store.createPreviewLease({
        artifactId,
        contentToken: "content-upl_ver_one",
        createdAt: now,
        expiresAt: "2026-10-02T00:00:00.000Z",
        principalId: leasePrincipal,
        projectId,
        tokenDigest,
        versionId: "ver_one",
      });
      await lease("digest-a1", "p-a");
      await lease("digest-a2", "p-a");
      await lease("digest-b", "p-b");

      await store.revokeContentSessions(["p-a"]);
      expect(await store.findPreviewLease("digest-a1", now)).toBeNull();
      expect(await store.findPreviewLease("digest-a2", now)).toBeNull();
      expect(await store.findPreviewLease("digest-b", now)).not.toBeNull();
      await store.revokeContentSessions([]);
      expect(await store.findPreviewLease("digest-b", now)).not.toBeNull();
    } finally {
      await proxy.dispose();
    }
  });
});
