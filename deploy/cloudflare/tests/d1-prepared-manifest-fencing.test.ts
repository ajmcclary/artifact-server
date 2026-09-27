import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";

import {defaultProjectId} from "../../../src/core/model.js";
import {UploadPreparationLeaseLost} from "../../../src/core/upload-preparation.js";
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

const principalId = "principal-d1-prepared-manifest";
const projectId = defaultProjectId;

function makeManifest(name: string) {
  const files = ["a.txt", "b.txt", "c.txt"].map((filePath, index) => {
    const bytes = new TextEncoder().encode(`${name}-${index}`);
    return {
      mediaType: "text/plain",
      path: filePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
  });
  return createManifest({
    entryPath: "a.txt",
    files,
    routingMode: "static",
  });
}

function uploadCommand(
  id: string,
  manifest: ReturnType<typeof makeManifest>,
  expiresAt = "2026-09-21T02:00:00.000Z",
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

describe("D1 prepared manifest entry fencing", () => {
  it("bounded slice writes are idempotent, stale owners lose the fence, and a fresh instance resumes", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-prepared-manifest-fencing";
    try {
      await migrateD1(binding, installationId);
      const storeA = createD1ArtifactRepository(binding, installationId);
      const storeB = createD1ArtifactRepository(binding, installationId);

      const manifest = makeManifest("fencing");
      const command = uploadCommand("upl_prepared_fence", manifest);
      await storeA.createStagedUpload(command);

      const firstNow = "2026-09-21T00:00:00.000Z";
      const firstLease = "2026-09-21T00:00:45.000Z";
      const first = await storeA.claimUploadPreparation(
        command.id,
        firstNow,
        firstLease,
      );
      expect(first?.attempts).toBe(1);

      await storeA.writePreparedManifestEntries(
        command.id,
        1,
        manifest.entries.slice(0, 1),
      );
      expect(await storeA.countPreparedManifestEntries(command.id)).toBe(1);

      const takeoverNow = "2026-09-21T00:01:00.000Z";
      const takeoverLease = "2026-09-21T00:01:45.000Z";
      const second = await storeB.claimUploadPreparation(
        command.id,
        takeoverNow,
        takeoverLease,
      );
      expect(second).toMatchObject({
        attempts: 2,
        preparationState: "claimed",
        uploadId: command.id,
      });

      await storeB.writePreparedManifestEntries(
        command.id,
        2,
        manifest.entries,
      );
      expect(await storeB.countPreparedManifestEntries(command.id)).toBe(3);

      const rows = await binding.prepare(`
        SELECT path, size, media_type, sha256, disposition
        FROM prepared_manifest_entries
        WHERE upload_id = ?
        ORDER BY path
      `).bind(command.id).all<{
        path: string;
        size: number;
        media_type: string;
        sha256: string;
        disposition: string;
      }>();
      const stored = rows.results.map((row) => ({
        disposition: row.disposition,
        mediaType: row.media_type,
        path: row.path,
        sha256: row.sha256,
        size: row.size,
      }));
      expect(stored).toEqual(manifest.entries.toSorted(
        (left, right) => left.path.localeCompare(right.path),
      ));

      await expect(storeA.writePreparedManifestEntries(
        command.id,
        1,
        manifest.entries.slice(1, 2),
      )).rejects.toThrow(UploadPreparationLeaseLost);

      expect(await storeB.countPreparedManifestEntries(command.id)).toBe(3);

      const restartManifest = makeManifest("restart");
      const restartCommand = uploadCommand("upl_prepared_restart", restartManifest);
      await storeA.createStagedUpload(restartCommand);

      const restartNow = "2026-09-21T02:00:00.000Z";
      const restartLease = "2026-09-21T02:00:45.000Z";
      const restartClaim = await storeA.claimUploadPreparation(
        restartCommand.id,
        restartNow,
        restartLease,
      );
      expect(restartClaim?.attempts).toBe(1);

      await storeA.writePreparedManifestEntries(
        restartCommand.id,
        1,
        restartManifest.entries.slice(0, 1),
      );
      expect(await storeA.countPreparedManifestEntries(restartCommand.id)).toBe(1);

      const resumeNow = "2026-09-21T02:01:00.000Z";
      const resumeLease = "2026-09-21T02:01:45.000Z";
      const storeC = createD1ArtifactRepository(binding, installationId);
      const resumed = await storeC.claimUploadPreparation(
        restartCommand.id,
        resumeNow,
        resumeLease,
      );
      expect(resumed?.attempts).toBe(2);

      const preparedCount = await storeC.countPreparedManifestEntries(restartCommand.id);
      expect(preparedCount).toBe(1);

      await storeC.writePreparedManifestEntries(
        restartCommand.id,
        2,
        restartManifest.entries.slice(preparedCount),
      );
      expect(await storeC.countPreparedManifestEntries(restartCommand.id)).toBe(3);
    } finally {
      await proxy.dispose();
    }
  });
});
