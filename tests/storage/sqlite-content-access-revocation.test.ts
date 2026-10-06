import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

describe("SQLite content access revocation", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("foundation: SQLite revocation ends only the named principals' leases", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Revocation store</title>",
      idempotencyKey: "sqlite-revocation-store",
      name: "Revocation store",
    });
    const repository = new SqliteArtifactRepository(path.join(installation.dataDirectory, "artifact-server.db"), "local");
    try {
      const now = "2026-10-05T12:00:00.000Z";
      const lease = (tokenDigest: string, principalId: string) => repository.createPreviewLease({
        artifactId: published.body.artifact.id,
        contentToken: new URL(published.body.links.version).hostname.split(".")[0] ?? "",
        createdAt: now,
        expiresAt: "2026-10-06T00:00:00.000Z",
        principalId,
        projectId: published.body.artifact.projectId,
        tokenDigest,
        versionId: published.body.version.id,
      });
      await lease("digest-a1", "p-a");
      await lease("digest-a2", "p-a");
      await lease("digest-b", "p-b");

      await repository.revokeContentSessions(["p-a"]);
      expect(await repository.findPreviewLease("digest-a1", now)).toBeNull();
      expect(await repository.findPreviewLease("digest-a2", now)).toBeNull();
      expect(await repository.findPreviewLease("digest-b", now)).not.toBeNull();
      await repository.revokeContentSessions([]);
      expect(await repository.findPreviewLease("digest-b", now)).not.toBeNull();
    } finally {
      repository.close();
    }
  });
});
