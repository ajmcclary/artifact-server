import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";

import {defaultProjectId} from "../../../src/core/model.js";
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

const principalId = "principal-d1-cleanup-claim";
const projectId = defaultProjectId;

const uploadCreatedAt = "2026-09-21T00:00:00.000Z";
const uploadExpiresAt = "2026-09-21T01:00:00.000Z";
const cleanupExpiredBefore = "2026-09-21T01:00:00.000Z";
const cleanupNow = "2026-09-21T01:05:00.000Z";
// A cleanup claim made at or before this instant is abandoned: one settle delay before cleanupNow.
const cleanupStaleClaimBefore = "2026-09-21T01:00:00.000Z";
const liveLease = "2026-09-21T02:05:00.000Z";

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
) {
  return {
    createdAt: uploadCreatedAt,
    expiresAt: uploadExpiresAt,
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

describe("D1 expired staging cleanup claim", () => {
  it("cleanup claim is refused while a preparation lease is live", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-cleanup-fence";
    try {
      await migrateD1(binding, installationId);
      const store = createD1ArtifactRepository(binding, installationId);
      const command = uploadCommand(
        "upl_d1_cleanup_fence",
        manifestFixture("cleanup fence"),
      );
      await store.createStagedUpload(command);
      const claim = await store.claimUploadPreparation(
        command.id,
        cleanupNow,
        liveLease,
      );
      expect(claim).not.toBeNull();

      const claimed = await store.claimExpiredStagedUploadForCleanup(
        command.id,
        cleanupExpiredBefore,
        cleanupNow,
        cleanupStaleClaimBefore,
      );
      expect(claimed).toBe(false);
      const removed = await store.removeExpiredStagedUpload(
        command.id,
        cleanupExpiredBefore,
        cleanupNow,
      );
      expect(removed).toBe(false);
      await expect(store.findStagedUpload(projectId, command.id, principalId))
        .resolves.not.toBeNull();
    } finally {
      await proxy.dispose();
    }
  });

  it("a cleanup claim excludes preparation claims while objects are removed", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-cleanup-exclusion";
    try {
      await migrateD1(binding, installationId);
      const store = createD1ArtifactRepository(binding, installationId);
      const command = uploadCommand(
        "upl_d1_cleanup_excludes",
        manifestFixture("cleanup exclusion"),
      );
      await store.createStagedUpload(command);

      const claimed = await store.claimExpiredStagedUploadForCleanup(
        command.id,
        cleanupExpiredBefore,
        cleanupNow,
        cleanupStaleClaimBefore,
      );
      expect(claimed).toBe(true);

      const racing = await store.claimUploadPreparation(
        command.id,
        cleanupNow,
        liveLease,
      );
      expect(racing).toBeNull();

      const slot = command.files[0];
      if (slot === undefined) throw new Error("The fixture has no file slot.");
      await store.removeExpiredStagedFile(
        command.id,
        slot.storageToken,
        cleanupExpiredBefore,
        cleanupNow,
      );
      const removed = await store.removeExpiredStagedUpload(
        command.id,
        cleanupExpiredBefore,
        cleanupNow,
      );
      expect(removed).toBe(true);
      await expect(store.findStagedUpload(projectId, command.id, principalId))
        .resolves.toBeNull();
    } finally {
      await proxy.dispose();
    }
  });

  it("an interrupted cleanup excludes preparation and other passes until its claim is stale", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-cleanup-retry";
    try {
      await migrateD1(binding, installationId);
      const store = createD1ArtifactRepository(binding, installationId);
      const command = uploadCommand(
        "upl_d1_cleanup_retry",
        manifestFixture("cleanup retry"),
      );
      await store.createStagedUpload(command);

      const claimed = await store.claimExpiredStagedUploadForCleanup(
        command.id,
        cleanupExpiredBefore,
        cleanupNow,
        cleanupStaleClaimBefore,
      );
      expect(claimed).toBe(true);
      // The pass is interrupted here: no rows removed, claim durable.
      const racing = await store.claimUploadPreparation(
        command.id,
        cleanupNow,
        liveLease,
      );
      expect(racing).toBeNull();

      // Another pass cannot take over a claim that is still live.
      const concurrentClaim = await store.claimExpiredStagedUploadForCleanup(
        command.id,
        cleanupExpiredBefore,
        cleanupNow,
        cleanupStaleClaimBefore,
      );
      expect(concurrentClaim).toBe(false);

      // One settle delay after the interrupted claim, a retry takes it over.
      const retryNow = "2026-09-21T01:10:00.000Z";
      const retryClaim = await store.claimExpiredStagedUploadForCleanup(
        command.id,
        cleanupExpiredBefore,
        retryNow,
        cleanupNow,
      );
      expect(retryClaim).toBe(true);
      const removed = await store.removeExpiredStagedUpload(
        command.id,
        cleanupExpiredBefore,
        retryNow,
      );
      expect(removed).toBe(true);
      await expect(store.findStagedUpload(projectId, command.id, principalId))
        .resolves.toBeNull();
    } finally {
      await proxy.dispose();
    }
  });
});
