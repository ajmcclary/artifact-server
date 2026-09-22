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

const principalId = "principal-d1-idempotency";
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

describe("D1 staged upload idempotency key", () => {
  it("finds a key-bound upload by idempotency key", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    try {
      await migrateD1(binding, "d1-staged-idempotency-test");
      const manifest = manifestFixture("d1 key-bound upload");
      const store = createD1ArtifactRepository(binding, "d1-staged-idempotency-test");
      const created = await store.createStagedUpload({
        createdAt: "2026-09-21T00:00:00.000Z",
        expiresAt: "2026-09-21T01:00:00.000Z",
        files: manifest.entries.map((entry) => ({
          entry,
          storageToken: `token-d1-key-bound-${entry.sha256}`,
        })),
        id: "upl_d1_key_bound",
        idempotencyKey: "idem-d1-key-bound",
        manifest,
        principalId,
        projectId,
      });

      expect(created.idempotencyKey).toBe("idem-d1-key-bound");

      const found = await store.findStagedUploadByIdempotencyKey(
        projectId,
        principalId,
        "idem-d1-key-bound",
      );
      expect(found).toMatchObject({
        id: "upl_d1_key_bound",
        idempotencyKey: "idem-d1-key-bound",
        status: "open",
      });
    } finally {
      await proxy.dispose();
    }
  });

  it("rejects a second upload with the same idempotency key", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    try {
      await migrateD1(binding, "d1-staged-idempotency-test");
      const manifest = manifestFixture("d1 duplicate key");
      const store = createD1ArtifactRepository(binding, "d1-staged-idempotency-test");
      await store.createStagedUpload({
        createdAt: "2026-09-21T00:00:00.000Z",
        expiresAt: "2026-09-21T01:00:00.000Z",
        files: manifest.entries.map((entry) => ({
          entry,
          storageToken: `token-d1-first-${entry.sha256}`,
        })),
        id: "upl_d1_first_duplicate",
        idempotencyKey: "idem-d1-duplicate",
        manifest,
        principalId,
        projectId,
      });

      const duplicate = store.createStagedUpload({
        createdAt: "2026-09-21T00:00:00.000Z",
        expiresAt: "2026-09-21T01:00:00.000Z",
        files: manifest.entries.map((entry) => ({
          entry,
          storageToken: `token-d1-second-${entry.sha256}`,
        })),
        id: "upl_d1_second_duplicate",
        idempotencyKey: "idem-d1-duplicate",
        manifest,
        principalId,
        projectId,
      });

      await expect(duplicate).rejects.toThrow(/unique|constraint/i);
    } finally {
      await proxy.dispose();
    }
  });

  it("lets null-key uploads coexist", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    try {
      await migrateD1(binding, "d1-staged-idempotency-test");
      const manifest = manifestFixture("d1 null key coexistence");
      const store = createD1ArtifactRepository(binding, "d1-staged-idempotency-test");
      const first = await store.createStagedUpload({
        createdAt: "2026-09-21T00:00:00.000Z",
        expiresAt: "2026-09-21T01:00:00.000Z",
        files: manifest.entries.map((entry) => ({
          entry,
          storageToken: `token-d1-null-a-${entry.sha256}`,
        })),
        id: "upl_d1_null_a",
        idempotencyKey: null,
        manifest,
        principalId,
        projectId,
      });
      const second = await store.createStagedUpload({
        createdAt: "2026-09-21T00:00:00.000Z",
        expiresAt: "2026-09-21T01:00:00.000Z",
        files: manifest.entries.map((entry) => ({
          entry,
          storageToken: `token-d1-null-b-${entry.sha256}`,
        })),
        id: "upl_d1_null_b",
        idempotencyKey: null,
        manifest,
        principalId,
        projectId,
      });

      expect(first.idempotencyKey).toBeNull();
      expect(second.idempotencyKey).toBeNull();
      expect(first.id).not.toBe(second.id);
    } finally {
      await proxy.dispose();
    }
  });
});
