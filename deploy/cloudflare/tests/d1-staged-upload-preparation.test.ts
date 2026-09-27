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

const principalId = "principal-d1-preparation";
const projectId = defaultProjectId;

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
    principalId,
    projectId,
  };
}

describe("D1 staged upload preparation", () => {
  it("claim storm has exactly one winner", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-prep-claim-storm";
    try {
      await migrateD1(binding, installationId);
      const storeA = createD1ArtifactRepository(binding, installationId);
      const storeB = createD1ArtifactRepository(binding, installationId);

      const manifest = manifestFixture("claim storm");
      const command = uploadCommand("upl_claim_storm", manifest);
      await storeA.createStagedUpload(command);

      const now = "2026-09-21T00:00:00.000Z";
      const lease = "2026-09-21T00:00:45.000Z";
      const [a, b] = await Promise.all([
        storeA.claimUploadPreparation(command.id, now, lease),
        storeB.claimUploadPreparation(command.id, now, lease),
      ]);

      const winner = a ?? b;
      expect(winner).not.toBeNull();
      expect(a === null || b === null).toBe(true);

      const upload = await storeA.findStagedUpload(projectId, command.id, principalId);
      expect(upload?.preparationAttempts).toBe(1);
    } finally {
      await proxy.dispose();
    }
  });

  it("expired lease is reclaimed and stale owner is fenced", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-prep-takeover";
    try {
      await migrateD1(binding, installationId);
      const storeA = createD1ArtifactRepository(binding, installationId);
      const storeB = createD1ArtifactRepository(binding, installationId);

      const manifest = manifestFixture("takeover");
      const command = uploadCommand("upl_takeover", manifest);
      await storeA.createStagedUpload(command);

      const firstNow = "2026-09-21T00:00:00.000Z";
      const firstLease = "2026-09-21T00:00:45.000Z";
      const first = await storeA.claimUploadPreparation(
        command.id,
        firstNow,
        firstLease,
      );
      expect(first?.attempts).toBe(1);

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

      await expect(storeA.recordStagedFileInstalled(
        command.id,
        command.files[0]?.storageToken ?? "",
        1,
        takeoverNow,
      )).rejects.toThrow(UploadPreparationLeaseLost);

      await expect(storeA.markUploadPrepared(
        command.id,
        1,
        takeoverNow,
      )).rejects.toThrow(UploadPreparationLeaseLost);

      const renewed = await storeB.renewUploadPreparation(
        command.id,
        2,
        takeoverNow,
        "2026-09-21T00:02:30.000Z",
      );
      expect(renewed).toBe(true);
    } finally {
      await proxy.dispose();
    }
  });

  it("release resets a claimed upload so it can be reclaimed", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-release-reclaim";
    try {
      await migrateD1(binding, installationId);
      const store = createD1ArtifactRepository(binding, installationId);

      const manifest = manifestFixture("release and reclaim");
      const command = uploadCommand("upl_release_reclaim", manifest);
      await store.createStagedUpload(command);

      const first = await store.claimUploadPreparation(
        command.id,
        "2026-09-21T00:00:00.000Z",
        "2026-09-21T00:00:45.000Z",
      );
      expect(first?.attempts).toBe(1);

      await store.releaseUploadPreparation(command.id, 1);

      const released = await store.findStagedUpload(projectId, command.id, principalId);
      expect(released).toMatchObject({
        preparationAttempts: 1,
        preparationLeaseExpiresAt: null,
        preparationState: "none",
      });

      const second = await store.claimUploadPreparation(
        command.id,
        "2026-09-21T00:00:10.000Z",
        "2026-09-21T00:00:55.000Z",
      );
      expect(second).toMatchObject({
        attempts: 2,
        preparationState: "claimed",
        uploadId: command.id,
      });
    } finally {
      await proxy.dispose();
    }
  });

  it("release with stale attempts leaves the lease intact", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-stale-release";
    try {
      await migrateD1(binding, installationId);
      const store = createD1ArtifactRepository(binding, installationId);

      const manifest = manifestFixture("stale release");
      const command = uploadCommand("upl_stale_release", manifest);
      await store.createStagedUpload(command);

      const lease = "2026-09-21T00:00:45.000Z";
      await store.claimUploadPreparation(
        command.id,
        "2026-09-21T00:00:00.000Z",
        lease,
      );

      await store.releaseUploadPreparation(command.id, 99);

      const upload = await store.findStagedUpload(projectId, command.id, principalId);
      expect(upload).toMatchObject({
        preparationAttempts: 1,
        preparationLeaseExpiresAt: lease,
        preparationState: "claimed",
      });
    } finally {
      await proxy.dispose();
    }
  });

  it("release on prepared or none upload does nothing", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-release-noop";
    try {
      await migrateD1(binding, installationId);
      const store = createD1ArtifactRepository(binding, installationId);

      const manifest = manifestFixture("release no-op");
      const command = uploadCommand("upl_release_noop", manifest);
      await store.createStagedUpload(command);

      await store.releaseUploadPreparation(command.id, 0);
      const untouched = await store.findStagedUpload(projectId, command.id, principalId);
      expect(untouched?.preparationState).toBe("none");

      const claim = await store.claimUploadPreparation(
        command.id,
        "2026-09-21T00:00:00.000Z",
        "2026-09-21T00:00:45.000Z",
      );
      await store.markUploadPrepared(
        command.id,
        claim?.attempts ?? 1,
        "2026-09-21T00:00:30.000Z",
      );

      await store.releaseUploadPreparation(command.id, claim?.attempts ?? 1);
      const prepared = await store.findStagedUpload(projectId, command.id, principalId);
      expect(prepared?.preparationState).toBe("prepared");
    } finally {
      await proxy.dispose();
    }
  });

  it("schema-13 migration applies in place over schema-12", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-prep-schema-upgrade";
    try {
      await migrateD1(binding, installationId);
      const store = createD1ArtifactRepository(binding, installationId);

      const manifest = manifestFixture("schema upgrade");
      const command = uploadCommand("upl_schema_upgrade", manifest);
      const created = await store.createStagedUpload(command);
      expect(created.preparationState).toBe("none");
      expect(created.preparationAttempts).toBe(0);

      const row = await binding.prepare(`
        SELECT preparation_state AS preparationState,
          preparation_attempts AS preparationAttempts,
          installed_at AS installedAt
        FROM staged_uploads
        JOIN staged_upload_files ON staged_upload_files.upload_id = staged_uploads.id
        WHERE staged_uploads.id = ?
      `).bind(command.id).first<{preparationState: string; preparationAttempts: number; installedAt: unknown}>();
      expect(row).toMatchObject({
        installedAt: null,
        preparationAttempts: 0,
        preparationState: "none",
      });
    } finally {
      await proxy.dispose();
    }
  });
});
