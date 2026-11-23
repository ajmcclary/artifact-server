import {chmod, writeFile} from "node:fs/promises";
import {join} from "node:path";

import {Effect} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import type {BlobStore, OpenedBlob} from "../../src/core/ports.js";
import {
  defaultGitHistoryFileCopyBytes,
  defaultGitHistoryVersionCopyBytes,
  fixedGitHistoryCapabilityReader,
} from "../../src/git-history/git-history-capability.js";
import {
  type GitHistoryCommitRequest,
  type GitHistoryJob,
  GitHistoryRemoteIncomplete,
  makeGitHistoryMirrorWorker,
  startGitHistoryMirrorWorker,
} from "../../src/git-history/git-history-mirror.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {RecordingGitHistoryProvider} from "../support/git-history-provider.js";
import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const capability = {
  limits: {
    fileCopyBytes: defaultGitHistoryFileCopyBytes,
    logicalCopiedBytes: 0,
    logicalReservedBytes: 0,
    storageBudgetBytes: null,
    versionCopyBytes: defaultGitHistoryVersionCopyBytes,
  },
  provider: "cloudflare-artifacts",
  providerState: "available",
} as const;

/** The real SQLite store, failing its first claims the way a database outage would. */
class FlakyClaimStore extends SqliteArtifactRepository {
  claimCalls = 0;
  failingClaims = 2;

  override async claimGitHistoryJob(now: string, leaseExpiresAt: string) {
    this.claimCalls += 1;
    if (this.claimCalls <= this.failingClaims) {
      throw new Error("database is locked");
    }
    return super.claimGitHistoryJob(now, leaseExpiresAt);
  }
}

/** The real SQLite store, recording every release the worker asks for. */
class ReleaseRecordingStore extends SqliteArtifactRepository {
  readonly releases: string[] = [];

  override async releaseGitHistoryJob(job: GitHistoryJob, classification: string, availableAt: string) {
    this.releases.push(classification);
    return super.releaseGitHistoryJob(job, classification, availableAt);
  }
}

/** The real disk blob store, observing whether a reader cancels its source. */
class CancelObservingBlobStore implements BlobStore {
  canceled = 0;
  readonly #inner: LocalBlobStore;

  constructor(inner: LocalBlobStore) {
    this.#inner = inner;
  }

  inspect(sha256: string) {
    return this.#inner.inspect(sha256);
  }

  async open(sha256: string): Promise<OpenedBlob> {
    const opened = await this.#inner.open(sha256);
    const reader = opened.body.getReader();
    return {
      ...opened,
      body: new ReadableStream<Uint8Array>({
        cancel: async (reason) => {
          this.canceled += 1;
          await reader.cancel(reason);
        },
        pull: async (controller) => {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
      }),
    };
  }

  openRange(...parameters: Parameters<BlobStore["openRange"]>) {
    return this.#inner.openRange(...parameters);
  }

  put(...parameters: Parameters<BlobStore["put"]>) {
    return this.#inner.put(...parameters);
  }
}

describe("Git history mirror worker recovery", () => {
  let installation: TestInstallation;

  beforeEach(async () => {
    installation = await createTestInstallation();
  });

  afterEach(async () => {
    await removeTestInstallation(installation);
  });

  async function publishAndEnable(content: string) {
    const server = await startTestServer(installation);
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content,
      idempotencyKey: `git-history-recovery-${content}`,
      projectId: "prj_default",
    });
    await server.stop();
    expect(published.response.status).toBe(201);
    const setup = new SqliteArtifactRepository(
      `${installation.dataDirectory}/artifact-server.db`,
      "local",
    );
    try {
      await setup.storeProjectGitHistorySetting({
        enabled: true,
        limits: capability.limits,
        projectId: "prj_default",
        updatedAt: new Date().toISOString(),
        updatedByPrincipalId: "test-recovery-operator",
      });
    } finally {
      setup.close();
    }
    return published.body;
  }

  test("GIT-008 recovery regression: transient claim failures do not end the background drain", async () => {
    const published = await publishAndEnable("transient claim failure");
    const store = new FlakyClaimStore(
      `${installation.dataDirectory}/artifact-server.db`,
      "local",
    );
    const provider = new RecordingGitHistoryProvider();
    const worker = await startGitHistoryMirrorWorker({
      blobs: new LocalBlobStore(join(installation.dataDirectory, "blobs")),
      capability: fixedGitHistoryCapabilityReader(capability),
      installationId: "local",
      provider,
      store,
    });
    try {
      await expect.poll(
        () => provider.commits.get(published.artifact.id)?.size ?? 0,
        {interval: 100, timeout: 15_000},
      ).toBe(1);
      expect(store.claimCalls).toBeGreaterThan(store.failingClaims);
      expect(await store.findGitHistoryMapping(
        "prj_default",
        published.artifact.id,
        published.version.id,
      )).not.toBeNull();
    } finally {
      await worker.close();
      store.close();
    }
  }, 25_000);

  test("GIT-008 lost-lease regression: an ownership check lost inside the provider waits out the lease", async () => {
    const published = await publishAndEnable("lost inside provider");
    const databasePath = `${installation.dataDirectory}/artifact-server.db`;
    const store = new ReleaseRecordingStore(databasePath, "local");
    const contender = new SqliteArtifactRepository(databasePath, "local");
    class ReclaimedDuringCommit extends RecordingGitHistoryProvider {
      override async commitVersion(request: GitHistoryCommitRequest) {
        const future = Date.now() + 60_000;
        const successor = await contender.claimGitHistoryJob(
          new Date(future).toISOString(),
          new Date(future + 45_000).toISOString(),
        );
        expect(successor).toMatchObject({attempts: 2, versionId: published.version.id});
        return super.commitVersion(request);
      }
    }
    try {
      const worker = makeGitHistoryMirrorWorker({
        blobs: new LocalBlobStore(join(installation.dataDirectory, "blobs")),
        capability: fixedGitHistoryCapabilityReader(capability),
        installationId: "local",
        provider: new ReclaimedDuringCommit(),
        store,
      });
      await expect(Effect.runPromise(worker.runPass()))
        .resolves.toEqual({claimed: true, outcome: "retry"});
      // A lost lease is never classified as a provider failure and released.
      expect(store.releases).toEqual([]);
    } finally {
      contender.close();
      store.close();
    }
  });

  test("GIT-008 stalled-remote regression: an incomplete remote response is released as a retryable provider failure", async () => {
    const published = await publishAndEnable("stalled remote");
    const store = new ReleaseRecordingStore(
      `${installation.dataDirectory}/artifact-server.db`,
      "local",
    );
    class StalledLookup extends RecordingGitHistoryProvider {
      override async lookupCommit(): Promise<never> {
        throw new GitHistoryRemoteIncomplete("git_remote_deadline_exceeded");
      }
    }
    const provider = new StalledLookup();
    try {
      const worker = makeGitHistoryMirrorWorker({
        blobs: new LocalBlobStore(join(installation.dataDirectory, "blobs")),
        capability: fixedGitHistoryCapabilityReader(capability),
        installationId: "local",
        provider,
        store,
      });
      await expect(Effect.runPromise(worker.runPass()))
        .resolves.toEqual({claimed: true, outcome: "retry"});
      expect(store.releases).toEqual(["provider_response_incomplete"]);
      // A partial remote view never falls through to a fresh commit.
      expect(provider.commitCalls).toBe(0);
      expect(await store.findGitHistoryMapping(
        "prj_default",
        published.artifact.id,
        published.version.id,
      )).toBeNull();
    } finally {
      store.close();
    }
  });

  test("GIT-004 regression: a stored blob longer than its manifest entry cancels the read and retries", async () => {
    const published = await publishAndEnable("corrupted at rest");
    const store = new ReleaseRecordingStore(
      `${installation.dataDirectory}/artifact-server.db`,
      "local",
    );
    const local = new LocalBlobStore(join(installation.dataDirectory, "blobs"));
    const blobs = new CancelObservingBlobStore(local);
    const provider = new RecordingGitHistoryProvider();
    try {
      const version = await store.findVersionRecord(
        "prj_default",
        published.artifact.id,
        published.version.id,
      );
      const entry = version?.manifest.entries[0];
      if (entry === undefined) throw new Error("The published version has no entry.");
      const blobPath = local.blobPath(entry.sha256);
      await chmod(blobPath, 0o600);
      await writeFile(blobPath, new Uint8Array(entry.size + 4096).fill(0x61));

      const worker = makeGitHistoryMirrorWorker({
        blobs,
        capability: fixedGitHistoryCapabilityReader(capability),
        installationId: "local",
        provider,
        store,
      });
      await expect(Effect.runPromise(worker.runPass()))
        .resolves.toEqual({claimed: true, outcome: "retry"});
      expect(blobs.canceled).toBe(1);
      expect(store.releases).toEqual(["provider_or_storage_failure"]);
      expect(provider.commitCalls).toBe(0);
    } finally {
      store.close();
    }
  });
});
