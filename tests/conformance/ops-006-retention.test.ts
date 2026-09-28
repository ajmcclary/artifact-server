import {createHash} from "node:crypto";
import {cp, mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {ManagedRuntime, Redacted} from "effect";
import {describe, expect, test} from "vitest";
import {z} from "zod";

import {ExpiredStagingCleanupService} from "../../src/application/expired-staging-cleanup.js";
import type {Clock} from "../../src/core/ports.js";
import {SystemIdGenerator} from "../../src/core/system.js";
import {createLocalApplicationLayer} from "../../src/local/create-local-application-layer.js";
import {defaultStagingCleanupPolicy} from "../../src/lifecycle/staging-cleanup.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {
  apiHeaders,
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  parsePublishResponse,
  requireSuccessfulUploads,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

const artifactPageSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({
      currentVersionId: z.string(),
      id: z.string(),
    }),
  })),
});

class ControlledClock implements Clock {
  #current: Date;

  constructor(initial: Date) {
    this.#current = initial;
  }

  now(): Date {
    return new Date(this.#current);
  }

  set(current: Date): void {
    this.#current = current;
  }
}

describe("OPS-006 retention", () => {
  test("OPS-006-B: publish, race, restore, restart, and wait beyond staging expiry — every committed byte remains", async () => {
    const controlledClock = new ControlledClock(
      new Date("2026-09-28T00:00:00.000Z"),
    );
    const originalInstallation = await createTestInstallation();
    let server = await startTestServer(originalInstallation, {
      clock: controlledClock,
    });
    let restoredInstallation: TestInstallation | undefined;
    let cleanupRuntime: ManagedRuntime.ManagedRuntime<
      ExpiredStagingCleanupService,
      never
    > | undefined;

    try {
      const artifactAFiles = [
        file("a/index.html", "text/html; charset=utf-8", "<h1>A</h1>"),
        file("a/readme.txt", "text/plain; charset=utf-8", "Artifact A readme"),
      ];
      const artifactBFiles = [
        file("b/index.html", "text/html; charset=utf-8", "<h1>B</h1>"),
      ];

      const uploadA = await createStagedUpload(
        server,
        originalInstallation,
        "a/index.html",
        artifactAFiles,
      );
      await requireSuccessfulUploads(
        uploadEveryStagedFile(originalInstallation, uploadA.body, artifactAFiles),
      );

      const raceTarget = {
        accessSetting: "public_link" as const,
        kind: "new_artifact" as const,
        name: "Artifact A",
      };
      const raceKey = "ops-006-race-commit-artifact-a";
      const commit = (): Promise<Response> =>
        fetch(uploadA.body.commitUrl, {
          body: JSON.stringify({target: raceTarget}),
          headers: apiHeaders(originalInstallation, raceKey),
          method: "POST",
        });
      const pollToFinalized = (response: Response): Promise<Response> => {
        if (response.status !== 202) return Promise.resolve(response);
        return new Promise<Response>((resolve) => setTimeout(resolve, 25))
          .then(commit)
          .then(pollToFinalized);
      };

      const [first, second] = await Promise.all([
        commit().then(pollToFinalized),
        commit().then(pollToFinalized),
      ]);
      expect(
        [first.status, second.status].toSorted((left, right) => left - right),
      ).toEqual([200, 201]);

      const winnerResponse = first.status === 201 ? first : second;
      const replayResponse = first.status === 200 ? first : second;
      const winnerA = parsePublishResponse(await winnerResponse.json());
      const replayA = parsePublishResponse(await replayResponse.json());
      expect(replayA.replayed).toBe(true);
      expect(replayA.version.id).toBe(winnerA.version.id);

      const uploadB = await createStagedUpload(
        server,
        originalInstallation,
        "b/index.html",
        artifactBFiles,
      );
      await requireSuccessfulUploads(
        uploadEveryStagedFile(originalInstallation, uploadB.body, artifactBFiles),
      );
      const committedB = await commitStagedUpload(
        originalInstallation,
        uploadB.body,
        "ops-006-commit-artifact-b",
        {
          accessSetting: "public_link",
          kind: "new_artifact",
          name: "Artifact B",
        },
      );
      expect(committedB.response.status).toBe(201);

      const abandonedFiles = [
        file("abandoned/left.html", "text/html; charset=utf-8", "left behind"),
      ];
      const abandoned = await createStagedUpload(
        server,
        originalInstallation,
        "abandoned/left.html",
        abandonedFiles,
      );
      await requireSuccessfulUploads(
        uploadEveryStagedFile(
          originalInstallation,
          abandoned.body,
          abandonedFiles,
        ),
      );
      const abandonedUploadId = abandoned.body.uploadId;
      const abandonedProjectId = new URL(abandoned.body.commitUrl).searchParams.get(
        "projectId",
      );

      await expectArtifactVersions(
        server,
        originalInstallation,
        new Set([winnerA.version.id, committedB.body.version.id]),
      );
      await verifyCommittedBytes(server, winnerA.links.version, artifactAFiles);
      await verifyCommittedBytes(
        server,
        committedB.body.links.version,
        artifactBFiles,
      );

      await server.stop();
      const restoredDataDirectory = await mkdtemp(
        path.join(tmpdir(), "artifact-server-restored-"),
      );
      await cp(originalInstallation.dataDirectory, restoredDataDirectory, {
        force: true,
        recursive: true,
      });
      restoredInstallation = {
        ...originalInstallation,
        dataDirectory: restoredDataDirectory,
      };
      server = await startTestServer(restoredInstallation, {
        clock: controlledClock,
      });

      await verifyCommittedBytes(server, winnerA.links.version, artifactAFiles);
      await verifyCommittedBytes(
        server,
        committedB.body.links.version,
        artifactBFiles,
      );
      await expectArtifactVersions(
        server,
        restoredInstallation,
        new Set([winnerA.version.id, committedB.body.version.id]),
      );

      await server.stop();
      server = await startTestServer(restoredInstallation, {
        clock: controlledClock,
      });
      await verifyCommittedBytes(server, winnerA.links.version, artifactAFiles);
      await verifyCommittedBytes(
        server,
        committedB.body.links.version,
        artifactBFiles,
      );

      controlledClock.set(
        new Date(
          controlledClock.now().getTime() +
            60 * 60 * 1_000 +
            5 * 60 * 1_000 +
            1_000,
        ),
      );

      await server.stop();
      const cleanup = makeCleanupRuntime(
        restoredInstallation,
        controlledClock,
      );
      cleanupRuntime = cleanup.runtime;
      const report = await cleanup.runtime.runPromise(
        ExpiredStagingCleanupService.use((service) =>
          service.runPass({limit: 10})
        ),
      );
      expect(report.deleted).toBeGreaterThanOrEqual(1);
      await cleanup.runtime.dispose();
      cleanup.identityRepository.close();
      cleanup.repository.close();
      cleanupRuntime = undefined;

      server = await startTestServer(restoredInstallation, {
        clock: controlledClock,
      });
      await verifyCommittedBytes(server, winnerA.links.version, artifactAFiles);
      await verifyCommittedBytes(
        server,
        committedB.body.links.version,
        artifactBFiles,
      );
      await expectArtifactVersions(
        server,
        restoredInstallation,
        new Set([winnerA.version.id, committedB.body.version.id]),
      );

      if (abandonedProjectId === null) {
        throw new Error("The abandoned upload plan has no project id.");
      }
      const abandonedCommitUrl = new URL(
        `/api/v1/uploads/${abandonedUploadId}/commit?projectId=${encodeURIComponent(
          abandonedProjectId,
        )}`,
        server.baseUrl,
      ).toString();
      const abandonedCommit = await fetch(abandonedCommitUrl, {
        body: JSON.stringify({
          target: {
            accessSetting: "public_link",
            kind: "new_artifact",
            name: "Abandoned artifact",
          },
        }),
        headers: apiHeaders(restoredInstallation, "ops-006-abandoned-retry"),
        method: "POST",
      });
      expect(abandonedCommit.status).toBe(404);
    } finally {
      if (cleanupRuntime !== undefined) {
        await cleanupRuntime.dispose().catch(() => {});
      }
      await server.stop().catch(() => {});
      await removeTestInstallation(originalInstallation).catch(() => {});
      if (restoredInstallation !== undefined) {
        await removeTestInstallation(restoredInstallation).catch(() => {});
      }
    }
  });
});

function file(
  filePath: string,
  mediaType: string,
  content: string,
): TestSiteFile {
  return {
    bytes: new TextEncoder().encode(content),
    mediaType,
    path: filePath,
  };
}

async function verifyCommittedBytes(
  server: RunningTestServer,
  versionUrl: string,
  files: readonly TestSiteFile[],
): Promise<void> {
  await Promise.all(files.map(async (siteFile) => {
    const fileUrl = new URL(
      `/${siteFile.path}`,
      versionUrl,
    ).toString();
    const response = await fetchVersion(server, fileUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(siteFile.mediaType);
    expect(response.headers.get("etag")).toBe(
      `"${createHash("sha256").update(siteFile.bytes).digest("hex")}"`,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      siteFile.bytes,
    );
  }));
}

async function expectArtifactVersions(
  server: RunningTestServer,
  installation: TestInstallation,
  expectedVersionIds: ReadonlySet<string>,
): Promise<void> {
  const response = await fetch(`${server.baseUrl}/api/v1/artifacts?limit=100`, {
    headers: {
      Authorization: `Bearer ${installation.apiToken}`,
    },
  });
  expect(response.status).toBe(200);
  const page = artifactPageSchema.parse(await response.json());
  const currentVersionIds = page.artifacts.map(
    ({artifact}) => artifact.currentVersionId,
  );
  expect(currentVersionIds).toHaveLength(expectedVersionIds.size);
  for (const versionId of currentVersionIds) {
    expect(expectedVersionIds.has(versionId)).toBe(true);
  }
}

function makeCleanupRuntime(
  installation: TestInstallation,
  clock: ControlledClock,
) {
  const databasePath = path.join(installation.dataDirectory, "artifact-server.db");
  const installationId = "local";
  const repository = new SqliteArtifactRepository(databasePath, installationId);
  const identityRepository = new SqliteIdentityRepository(databasePath);
  const staging = new LocalStagingStore(
    path.join(installation.dataDirectory, "staging"),
  );
  const blobs = new LocalBlobStore(
    path.join(installation.dataDirectory, "blobs"),
  );
  const applicationLayer = createLocalApplicationLayer({
    apiToken: Redacted.make(installation.apiToken),
    blobs,
    bootstrapAdministratorEmail: "admin@example.test",
    clock,
    dispatches: repository,
    externalApiBearerVerifier: null,
    externalMcpBearerVerifier: null,
    externalMcpOAuthVerifier: null,
    ids: new SystemIdGenerator(),
    identityRepository,
    installationId,
    interactiveIdentityProvider: null,
    localBootstrapCredential: null,
    protectBootstrapAdministrator: false,
    repository,
    staging,
    stagingCleanupPolicy: defaultStagingCleanupPolicy,
  });
  const runtime = ManagedRuntime.make(applicationLayer);
  return {identityRepository, repository, runtime};
}
