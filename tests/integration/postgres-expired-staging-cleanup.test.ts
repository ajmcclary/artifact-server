import {createHash, randomUUID} from "node:crypto";

import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultProjectId} from "../../src/core/model.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";

const principalId = "principal-cleanup-claim";
const projectId = defaultProjectId;

const uploadCreatedAt = "2026-09-21T00:00:00.000Z";
const uploadExpiresAt = "2026-09-21T01:00:00.000Z";
const cleanupExpiredBefore = "2026-09-21T01:00:00.000Z";
const cleanupNow = "2026-09-21T01:05:00.000Z";
const liveLease = "2026-09-21T02:05:00.000Z";

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

describe("Postgres expired staging cleanup claim", () => {
  let database: PostgresDatabase;
  let repository: PostgresArtifactRepository;

  beforeEach(async () => {
    database = await PostgresDatabase.open(
      {url: Redacted.make(readDatabaseUrl())},
      "apply",
    );
    repository = await PostgresArtifactRepository.open(
      database,
      `test-cleanup-claim-${randomUUID()}`,
    );
  });

  afterEach(async () => {
    await database.close();
  });

  test("cleanup claim is refused while a preparation lease is live", async () => {
    const command = stagedUploadCommand(
      `upl_cleanup_fence_${randomUUID()}`,
      manifestFixture("cleanup fence"),
    );
    await repository.createStagedUpload(command);
    const claim = await repository.claimUploadPreparation(
      command.id,
      cleanupNow,
      liveLease,
    );
    expect(claim).not.toBeNull();

    const claimed = await repository.claimExpiredStagedUploadForCleanup(
      command.id,
      cleanupExpiredBefore,
      cleanupNow,
    );
    expect(claimed).toBe(false);
    const removed = await repository.removeExpiredStagedUpload(
      command.id,
      cleanupExpiredBefore,
      cleanupNow,
    );
    expect(removed).toBe(false);
    await expect(repository.findStagedUpload(projectId, command.id, principalId))
      .resolves.not.toBeNull();
  });

  test("a cleanup claim excludes preparation claims while objects are removed", async () => {
    const command = stagedUploadCommand(
      `upl_cleanup_excludes_${randomUUID()}`,
      manifestFixture("cleanup exclusion"),
    );
    await repository.createStagedUpload(command);

    const claimed = await repository.claimExpiredStagedUploadForCleanup(
      command.id,
      cleanupExpiredBefore,
      cleanupNow,
    );
    expect(claimed).toBe(true);

    const racing = await repository.claimUploadPreparation(
      command.id,
      cleanupNow,
      liveLease,
    );
    expect(racing).toBeNull();

    const slot = command.files[0];
    if (slot === undefined) throw new Error("The fixture has no file slot.");
    await repository.removeExpiredStagedFile(
      command.id,
      slot.storageToken,
      cleanupExpiredBefore,
      cleanupNow,
    );
    const removed = await repository.removeExpiredStagedUpload(
      command.id,
      cleanupExpiredBefore,
      cleanupNow,
    );
    expect(removed).toBe(true);
    await expect(repository.findStagedUpload(projectId, command.id, principalId))
      .resolves.toBeNull();
  });

  test("an interrupted cleanup keeps excluding preparation and a retry finishes", async () => {
    const command = stagedUploadCommand(
      `upl_cleanup_retry_${randomUUID()}`,
      manifestFixture("cleanup retry"),
    );
    await repository.createStagedUpload(command);

    const claimed = await repository.claimExpiredStagedUploadForCleanup(
      command.id,
      cleanupExpiredBefore,
      cleanupNow,
    );
    expect(claimed).toBe(true);
    // The pass is interrupted here: no rows removed, claim durable.
    const racing = await repository.claimUploadPreparation(
      command.id,
      cleanupNow,
      liveLease,
    );
    expect(racing).toBeNull();

    const retryNow = "2026-09-21T01:10:00.000Z";
    const retryClaim = await repository.claimExpiredStagedUploadForCleanup(
      command.id,
      cleanupExpiredBefore,
      retryNow,
    );
    expect(retryClaim).toBe(true);
    const removed = await repository.removeExpiredStagedUpload(
      command.id,
      cleanupExpiredBefore,
      retryNow,
    );
    expect(removed).toBe(true);
    await expect(repository.findStagedUpload(projectId, command.id, principalId))
      .resolves.toBeNull();
  });
});
