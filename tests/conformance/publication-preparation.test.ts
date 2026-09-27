import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {mkdtemp, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {DateTime, Effect, Layer, ManagedRuntime, Redacted, Result} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {ApplicationClock} from "../../src/application/application-clock.js";
import type {ApplicationRuntime} from "../../src/application/application-runtime.js";
import {
  PublishArtifactService,
  type PublicationFileSource,
} from "../../src/application/publish-artifact.js";
import type {
  PublicationPreparationBlobs,
  PublicationPreparationStaging,
} from "../../src/application/publication-preparation.js";
import {
  PublicationPreparationService,
} from "../../src/application/publication-preparation.js";
import {StagedUploadService} from "../../src/application/staged-upload.js";
import {
  BlobStorageFailure,
  StagingStorageFailure,
  UploadPreparationLeaseLost,
} from "../../src/core/errors.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import type {
  BlobStore,
  BlobWrite,
  Clock,
  OpenedBlob,
  OpenedBlobRange,
  StoredBlob,
} from "../../src/core/ports.js";
import {maximumDeclaredFiles} from "../../src/core/publishing-limits.js";
import {SystemIdGenerator} from "../../src/core/system.js";
import {createLocalApplicationLayer} from "../../src/local/create-local-application-layer.js";
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
} from "../support/runtime-harness.js";
import {
  createStagedUpload,
  parsePublishResponse,
  requireSuccessfulUploads,
  testSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

describe("publication preparation", () => {
  let controlledClock: ControlledClock;
  let dataDirectory: string;
  let blobs: LocalBlobStore;
  let countingBlobs: CountingBlobStore;
  let repository: SqliteArtifactRepository;
  let identityRepository: SqliteIdentityRepository;
  let runtime: ApplicationRuntime;
  let staging: LocalStagingStore;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-preparation-"));
    controlledClock = new ControlledClock(new Date("2026-08-13T00:00:00.000Z"));
    repository = new SqliteArtifactRepository(
      path.join(dataDirectory, "artifact-server.db"),
    );
    identityRepository = new SqliteIdentityRepository(
      path.join(dataDirectory, "artifact-server.db"),
    );
    staging = new LocalStagingStore(path.join(dataDirectory, "staging"));
    blobs = new LocalBlobStore(path.join(dataDirectory, "blobs"));
    countingBlobs = new CountingBlobStore(blobs);
    runtime = makeRuntime(countingBlobs, {filesPerPass: 1, preparedEntriesPerPass: 1});
    await runtime.context();
  });

  afterEach(async () => {
    await runtime.dispose();
    identityRepository.close();
    repository.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("PUB-019-B: small per-pass budget, several bounded passes, restart, durable per-file progress, no re-installation, and one committed version with exact bytes", async () => {
    expect.hasAssertions();
    const files = [
      fileSlot("a.txt", "alpha"),
      fileSlot("b.txt", "bravo"),
      fileSlot("c.txt", "charlie"),
    ];
    const firstFile = files[0];
    if (firstFile === undefined) throw new Error("The fixture has no entry file.");

    const uploadResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: firstFile.path,
        files,
        principal: testPrincipal("preparation-principal"),
      })
    );
    if (uploadResult.kind === "committed") {
      throw new Error("Fixture upload unexpectedly returned a committed publication.");
    }
    const upload = uploadResult.upload;

    await Promise.all(files.map((file, index) => {
      const slot = upload.files[index];
      if (slot === undefined) throw new Error(`The fixture has no slot at index ${index}.`);
      return runStaged(runtime, (service) => service.uploadFile({
        body: byteStream(file.bytes),
        ownerId: upload.principalId,
        projectId: upload.projectId,
        storageToken: slot.storageToken,
        uploadId: upload.id,
      }));
    }));

    const first = await runPreparation(runtime, (service) =>
      service.prepareUpload({upload})
    );
    expect(first).toEqual({kind: "preparing", installed: 1, total: 3});
    expect(countingBlobs.count).toBe(1);

    // Simulate a process/repository restart: dispose the runtime and reopen
    // the same SQLite database, blob store, and staging with new service
    // instances. The durable per-file progress must resume.
    await runtime.dispose();
    runtime = makeRuntime(countingBlobs, {filesPerPass: 1, preparedEntriesPerPass: 1});
    await runtime.context();

    const second = await runPreparation(runtime, (service) =>
      service.prepareUpload({upload})
    );
    expect(second).toEqual({kind: "preparing", installed: 2, total: 3});
    expect(countingBlobs.count).toBe(2);

    const third = await runPreparation(runtime, (service) =>
      service.prepareUpload({upload})
    );
    expect(third).toEqual({kind: "prepared"});
    expect(countingBlobs.count).toBe(3);

    // No file was installed twice.
    expect(await countFiles(path.join(dataDirectory, "blobs"))).toBe(3);

    const committed = await runPublish(runtime, (service) =>
      service.publishPreparedNew({
        accessSetting: "account_required",
        files: upload.files.map((file) =>
          publicationSource(staging, upload, file)
        ),
        idempotencyKey: "preparation-restart-key-0001",
        manifest: upload.manifest,
        name: "Bounded restart artifact",
        principal: testPrincipal("preparation-principal"),
        projectId: upload.projectId,
        source: {
          kind: "staged_upload",
          principalId: upload.principalId,
          projectId: upload.projectId,
          uploadId: upload.id,
        },
        tags: [],
      })
    );

    expect(committed.artifact.currentVersionId).toBe(committed.version.id);
    expect(committed.version.number).toBe(1);

    const versions = await repository.listArtifactVersions(
      upload.projectId,
      committed.artifact.id,
    );
    expect(versions).toHaveLength(1);

    await Promise.all(files.map(async (file) => {
      const opened = await blobs.open(file.sha256);
      const stored = new Uint8Array(await new Response(opened.body).arrayBuffer());
      expect(stored).toEqual(file.bytes);
    }));
  });

  test("PUB-019-F: a stalled preparation owner loses its lease to a successor and cannot record progress or finalize afterward, and a replaced staged source fails closed", async () => {
    expect.hasAssertions();
    const files = [
      fileSlot("stale-a.txt", "stale-alpha"),
      fileSlot("stale-b.txt", "stale-bravo"),
    ];
    const firstFile = files[0];
    if (firstFile === undefined) throw new Error("The fixture has no entry file.");

    const uploadResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: firstFile.path,
        files,
        principal: testPrincipal("stalled-principal"),
      })
    );
    if (uploadResult.kind === "committed") {
      throw new Error("Fixture upload unexpectedly returned a committed publication.");
    }
    const upload = uploadResult.upload;

    await Promise.all(files.map((file, index) => {
      const slot = upload.files[index];
      if (slot === undefined) throw new Error(`The fixture has no slot at index ${index}.`);
      return runStaged(runtime, (service) => service.uploadFile({
        body: byteStream(file.bytes),
        ownerId: upload.principalId,
        projectId: upload.projectId,
        storageToken: slot.storageToken,
        uploadId: upload.id,
      }));
    }));

    const first = await runPreparation(runtime, (service) =>
      service.prepareUpload({upload})
    );
    expect(first).toEqual({kind: "preparing", installed: 1, total: 2});

    // Advance past the 45-second lease so the original owner is stalled.
    controlledClock.set(
      new Date(controlledClock.now().getTime() + 46_000),
    );

    // A successor claims the preparation and completes it.
    const second = await runPreparation(runtime, (service) =>
      service.prepareUpload({upload})
    );
    expect(second).toEqual({kind: "prepared"});

    // The stale owner's attempts token can no longer record progress.
    await expect(repository.recordStagedFileInstalled(
      upload.id,
      upload.files[0]?.storageToken ?? "",
      1,
      DateTime.formatIso(DateTime.makeUnsafe(controlledClock.now())),
    )).rejects.toThrow(UploadPreparationLeaseLost);

    // The stale owner cannot mark the upload prepared either.
    await expect(repository.markUploadPrepared(
      upload.id,
      1,
      DateTime.formatIso(DateTime.makeUnsafe(controlledClock.now())),
    )).rejects.toThrow(UploadPreparationLeaseLost);

    // A staged source replaced after verification fails closed during the
    // successor's install: no version, no progress for the replaced file.
    const replacedUploadResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: firstFile.path,
        files: [firstFile],
        principal: testPrincipal("replaced-source-principal"),
      })
    );
    if (replacedUploadResult.kind === "committed") {
      throw new Error("Fixture upload unexpectedly returned a committed publication.");
    }
    const replacedUpload = replacedUploadResult.upload;
    const replacedSlot = replacedUpload.files[0];
    if (replacedSlot === undefined) throw new Error("The replaced-source fixture has no slot.");

    await runStaged(runtime, (service) => service.uploadFile({
      body: byteStream(firstFile.bytes),
      ownerId: replacedUpload.principalId,
      projectId: replacedUpload.projectId,
      storageToken: replacedSlot.storageToken,
      uploadId: replacedUpload.id,
    }));

    const stagedPath = staging.stagedFilePath(
      replacedUpload.id,
      replacedSlot.storageToken,
    );
    await writeFile(stagedPath, mutatedCopy(firstFile.bytes));

    const replacedResult = await runtime.runPromise(
      Effect.result(PublicationPreparationService.use((service) =>
        service.prepareUpload({upload: replacedUpload})
      )),
    );
    expect(Result.isFailure(replacedResult)).toBe(true);

    const reopened = await repository.findStagedUpload(
      replacedUpload.projectId,
      replacedUpload.id,
      replacedUpload.principalId,
    );
    expect(reopened?.files[0]?.installedAt).toBeNull();
    const artifacts = await repository.listArtifacts({
      comments: "all",
      cursor: null,
      limit: 10,
      projectId: replacedUpload.projectId,
      sort: "newest",
      tags: [],
    });
    expect(artifacts.items).toHaveLength(0);
  });

  test("PUB-020-B: concurrent finalization of one operation produces exactly one version with replayed committed results, and a lost commit response replays without staging access", async () => {
    expect.hasAssertions();
    const installation = await createTestInstallation();
    let server: RunningTestServer | null = null;
    try {
      server = await startTestServer(installation, {
        clock: controlledClock,
        publicationPreparationConfig: {filesPerPass: 10, preparedEntriesPerPass: 1},
      });
      const entry = testSiteFile("entry", "text/html; charset=utf-8", "index.html");
      const asset = testSiteFile("asset", "text/plain", "asset.txt");
      const key = "concurrent-finalization-key-0001";
      const upload = await createStagedUpload(
        server,
        installation,
        entry.path,
        [entry, asset],
        undefined,
        "static",
        key,
      );
      await requireSuccessfulUploads(
        uploadEveryStagedFile(installation, upload.body, [entry, asset]),
      );

      const target = {
        accessSetting: "public_link" as const,
        kind: "new_artifact" as const,
        name: "Concurrent finalization artifact",
      };

      const commit = () => fetch(upload.body.commitUrl, {
        body: JSON.stringify({target}),
        headers: apiHeaders(installation, key),
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
      const statuses = [first.status, second.status].toSorted(
        (left, right) => left - right,
      );
      expect(statuses).toEqual([200, 201]);

      const winnerResponse = first.status === 201 ? first : second;
      const replayResponse = first.status === 200 ? first : second;
      const winner = parsePublishResponse(await winnerResponse.json());
      const replay = parsePublishResponse(await replayResponse.json());
      expect(replay.replayed).toBe(true);
      expect(replay.version.id).toBe(winner.version.id);

      const versions = await fetch(
        `${server.baseUrl}/api/v1/artifacts/${winner.artifact.id}/versions`,
        {headers: {Authorization: `Bearer ${installation.apiToken}`}},
      );
      expect(versions.status).toBe(200);
      const versionsBody = z.object({
        versions: z.array(z.object({version: z.object({id: z.string()})})),
      }).parse(await versions.json());
      expect(versionsBody.versions).toHaveLength(1);

      // Simulate a lost commit response: the client did not receive the first
      // response and retries with the same idempotency key. The replay returns
      // the already-committed publication without staging access.
      const retry = await fetch(upload.body.commitUrl, {
        body: JSON.stringify({target}),
        headers: apiHeaders(installation, key),
        method: "POST",
      });
      expect(retry.status).toBe(200);
      const retryBody = parsePublishResponse(await retry.json());
      expect(retryBody.replayed).toBe(true);
      expect(retryBody.version.id).toBe(winner.version.id);

      const versionBody = await fetchVersion(server, winner.links.version);
      expect(await versionBody.text()).toBe(new TextDecoder().decode(entry.bytes));
    } finally {
      if (server !== null) await server.stop();
      await removeTestInstallation(installation);
    }
  });

  test("PUB-020-F: blob-store outage mid-preparation and after preparation leave no partial version, and a replaced staged source fails closed", async () => {
    expect.hasAssertions();
    const files = [
      fileSlot("outage-a.txt", "outage-alpha"),
      fileSlot("outage-b.txt", "outage-bravo"),
      fileSlot("outage-c.txt", "outage-charlie"),
    ];
    const firstFile = files[0];
    if (firstFile === undefined) throw new Error("The fixture has no entry file.");

    const failingBlobs = new FailingBlobStore(blobs);
    await runtime.dispose();
    runtime = makeRuntime(failingBlobs, {filesPerPass: 1, preparedEntriesPerPass: 1});
    await runtime.context();

    const uploadResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: firstFile.path,
        files,
        principal: testPrincipal("outage-principal"),
      })
    );
    if (uploadResult.kind === "committed") {
      throw new Error("Fixture upload unexpectedly returned a committed publication.");
    }
    const upload = uploadResult.upload;

    await Promise.all(files.map((file, index) => {
      const slot = upload.files[index];
      if (slot === undefined) throw new Error(`The fixture has no slot at index ${index}.`);
      return runStaged(runtime, (service) => service.uploadFile({
        body: byteStream(file.bytes),
        ownerId: upload.principalId,
        projectId: upload.projectId,
        storageToken: slot.storageToken,
        uploadId: upload.id,
      }));
    }));

    // (a) Mid-preparation outage: install one file in a bounded pass, then fail
    // the next file's blob put. No version is visible and durable progress is
    // bounded.
    const firstPass = await runPreparation(runtime, (service) =>
      service.prepareUpload({upload})
    );
    expect(firstPass).toEqual({kind: "preparing", installed: 1, total: 3});

    failingBlobs.setFailAfter(0);
    const midOutageResult = await runtime.runPromise(
      Effect.result(PublicationPreparationService.use((service) =>
        service.prepareUpload({upload})
      )),
    );
    expect(Result.isFailure(midOutageResult)).toBe(true);

    const afterMidOutage = await repository.listArtifacts({
      comments: "all",
      cursor: null,
      limit: 10,
      projectId: upload.projectId,
      sort: "newest",
      tags: [],
    });
    expect(afterMidOutage.items).toHaveLength(0);

    const midOutageUpload = await repository.findStagedUpload(
      upload.projectId,
      upload.id,
      upload.principalId,
    );
    const installedAfterOutage = midOutageUpload?.files.filter(
      (file) => file.installedAt !== null,
    ).length ?? 0;
    expect(installedAfterOutage).toBeLessThan(3);

    // After the outage clears, advance past the stale lease and resume with the
    // same operation, then commit one exact version.
    failingBlobs.clearFailAfter();
    controlledClock.set(
      new Date(controlledClock.now().getTime() + 46_000),
    );
    const secondPass = await runPreparation(runtime, (service) =>
      service.prepareUpload({upload})
    );
    expect(secondPass).toEqual({kind: "preparing", installed: 2, total: 3});

    const thirdPass = await runPreparation(runtime, (service) =>
      service.prepareUpload({upload})
    );
    expect(thirdPass).toEqual({kind: "prepared"});

    const committed = await runPublish(runtime, (service) =>
      service.publishPreparedNew({
        accessSetting: "account_required",
        files: upload.files.map((file) =>
          publicationSource(staging, upload, file)
        ),
        idempotencyKey: "outage-recovery-key-0001",
        manifest: upload.manifest,
        name: "Outage recovery artifact",
        principal: testPrincipal("outage-principal"),
        projectId: upload.projectId,
        source: {
          kind: "staged_upload",
          principalId: upload.principalId,
          projectId: upload.projectId,
          uploadId: upload.id,
        },
        tags: [],
      })
    );
    expect(committed.version.number).toBe(1);

    // (b) After preparation completes but before finalize: simulate a final
    // commit that discovers an uninstalled file by resetting its installed flag
    // and using a failing blob store. No partial version is visible.
    const secondUploadResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: firstFile.path,
        files,
        principal: testPrincipal("outage-finalize-principal"),
      })
    );
    if (secondUploadResult.kind === "committed") {
      throw new Error("Fixture upload unexpectedly returned a committed publication.");
    }
    const secondUpload = secondUploadResult.upload;

    await Promise.all(files.map((file, index) => {
      const slot = secondUpload.files[index];
      if (slot === undefined) throw new Error(`The fixture has no slot at index ${index}.`);
      return runStaged(runtime, (service) => service.uploadFile({
        body: byteStream(file.bytes),
        ownerId: secondUpload.principalId,
        projectId: secondUpload.projectId,
        storageToken: slot.storageToken,
        uploadId: secondUpload.id,
      }));
    }));

    const secondPassA = await runPreparation(runtime, (service) =>
      service.prepareUpload({upload: secondUpload})
    );
    expect(secondPassA).toEqual({kind: "preparing", installed: 1, total: 3});

    const secondPassB = await runPreparation(runtime, (service) =>
      service.prepareUpload({upload: secondUpload})
    );
    expect(secondPassB).toEqual({kind: "preparing", installed: 2, total: 3});

    const secondPrepared = await runPreparation(runtime, (service) =>
      service.prepareUpload({upload: secondUpload})
    );
    expect(secondPrepared).toEqual({kind: "prepared"});

    // Reset one file's installed flag to force the final commit path to install.
    const raw = new DatabaseSync(path.join(dataDirectory, "artifact-server.db"));
    try {
      raw.exec(`
        UPDATE staged_upload_files
        SET installed_at = NULL
        WHERE upload_id = '${secondUpload.id}' AND path = '${files[0]?.path ?? ""}'
      `);
    } finally {
      raw.close();
    }

    const resetUpload = await repository.findStagedUpload(
      secondUpload.projectId,
      secondUpload.id,
      secondUpload.principalId,
    );
    if (resetUpload === null) {
      throw new Error("The reset fixture upload disappeared.");
    }

    const artifactsBeforeFinalizeOutage = await repository.listArtifacts({
      comments: "all",
      cursor: null,
      limit: 10,
      projectId: secondUpload.projectId,
      sort: "newest",
      tags: [],
    });

    failingBlobs.setFailAfter(0);
    const finalizeOutageResult = await runtime.runPromise(
      Effect.result(PublishArtifactService.use((service) =>
        service.publishPreparedNew({
          accessSetting: "account_required",
          files: resetUpload.files.map((file) =>
            publicationSource(staging, resetUpload, file)
          ),
          idempotencyKey: "outage-finalize-key-0001",
          manifest: resetUpload.manifest,
          name: "Outage finalize artifact",
          principal: testPrincipal("outage-finalize-principal"),
          projectId: resetUpload.projectId,
          source: {
            kind: "staged_upload",
            principalId: resetUpload.principalId,
            projectId: resetUpload.projectId,
            uploadId: resetUpload.id,
          },
          tags: [],
        })
      )),
    );
    expect(Result.isFailure(finalizeOutageResult)).toBe(true);

    const afterFinalizeOutage = await repository.listArtifacts({
      comments: "all",
      cursor: null,
      limit: 10,
      projectId: secondUpload.projectId,
      sort: "newest",
      tags: [],
    });
    expect(afterFinalizeOutage.items).toHaveLength(
      artifactsBeforeFinalizeOutage.items.length,
    );

    // A staged source replaced after verification fails closed as a publish
    // failure, not an infinite retry.
    const replacedFile = fileSlot("replaced.txt", "replaced-original");
    const replacedUploadResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: replacedFile.path,
        files: [replacedFile],
        principal: testPrincipal("outage-replaced-principal"),
      })
    );
    if (replacedUploadResult.kind === "committed") {
      throw new Error("Fixture upload unexpectedly returned a committed publication.");
    }
    const replacedUpload = replacedUploadResult.upload;
    const replacedSlot = replacedUpload.files[0];
    if (replacedSlot === undefined) throw new Error("The replaced fixture has no slot.");

    await runStaged(runtime, (service) => service.uploadFile({
      body: byteStream(replacedFile.bytes),
      ownerId: replacedUpload.principalId,
      projectId: replacedUpload.projectId,
      storageToken: replacedSlot.storageToken,
      uploadId: replacedUpload.id,
    }));

    await writeFile(
      staging.stagedFilePath(replacedUpload.id, replacedSlot.storageToken),
      mutatedCopy(replacedFile.bytes),
    );

    const artifactsBeforeReplaced = await repository.listArtifacts({
      comments: "all",
      cursor: null,
      limit: 10,
      projectId: replacedUpload.projectId,
      sort: "newest",
      tags: [],
    });

    failingBlobs.clearFailAfter();
    const replacedResult = await runtime.runPromise(
      Effect.result(StagedUploadService.use((service) =>
        service.commitUpload({
          idempotencyKey: "outage-replaced-key-0001",
          principal: testPrincipal("outage-replaced-principal"),
          projectId: replacedUpload.projectId,
          target: {
            accessSetting: "account_required",
            kind: "new_artifact",
            name: "Replaced source artifact",
          },
          uploadId: replacedUpload.id,
        })
      )),
    );
    expect(Result.isFailure(replacedResult)).toBe(true);

    const afterReplaced = await repository.listArtifacts({
      comments: "all",
      cursor: null,
      limit: 10,
      projectId: replacedUpload.projectId,
      sort: "newest",
      tags: [],
    });
    expect(afterReplaced.items).toHaveLength(
      artifactsBeforeReplaced.items.length,
    );
    const replacedBlobPath = path.join(
      dataDirectory,
      "blobs",
      replacedFile.sha256.slice(0, 2),
      replacedFile.sha256,
    );
    await expect(
      import("node:fs/promises").then(({stat}) => stat(replacedBlobPath)),
    ).rejects.toMatchObject({code: "ENOENT"});
  });

  test("foundation: an owned preparation lease causes a retryable lease-lost failure", async () => {
    expect.hasAssertions();
    const file = fileSlot("leased.txt", "lease-lost");
    const uploadResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: file.path,
        files: [file],
        principal: testPrincipal("lease-principal"),
      })
    );
    if (uploadResult.kind === "committed") {
      throw new Error("Fixture upload unexpectedly returned a committed publication.");
    }
    const upload = uploadResult.upload;
    const slot = upload.files[0];
    if (slot === undefined) throw new Error("The lease fixture has no file slot.");

    await runStaged(runtime, (service) => service.uploadFile({
      body: byteStream(file.bytes),
      ownerId: upload.principalId,
      projectId: upload.projectId,
      storageToken: slot.storageToken,
      uploadId: upload.id,
    }));

    await repository.claimUploadPreparation(
      upload.id,
      new Date(controlledClock.now().getTime() + 1_000).toISOString(),
      new Date(controlledClock.now().getTime() + 60_000).toISOString(),
    );

    const result = await runtime.runPromise(
      Effect.result(PublicationPreparationService.use((service) =>
        service.prepareUpload({upload})
      )),
    );
    const actualTag = Result.match(result, {
      onFailure: (failure) => failure._tag,
      onSuccess: () => "UnexpectedSuccess",
    });
    expect(actualTag).toBe("UploadPreparationLeaseLost");
  });

  function makeRuntime(
    blobStore: BlobStore,
    config: {filesPerPass: number; preparedEntriesPerPass?: number},
  ): ApplicationRuntime {
    const clock: ApplicationClock = {
      now: Effect.sync(() => DateTime.makeUnsafe(controlledClock.now())),
    };
    const preparationConfig = {
      preparedEntriesPerPass: maximumDeclaredFiles,
      ...config,
    };
    const baseLayer = createLocalApplicationLayer({
      apiToken: Redacted.make("test-api-token"),
      blobs: blobStore,
      bootstrapAdministratorEmail: "admin@example.test",
      clock: controlledClock,
      dispatches: repository,
      externalApiBearerVerifier: null,
      externalMcpBearerVerifier: null,
      externalMcpOAuthVerifier: null,
      ids: new SystemIdGenerator(),
      identityRepository,
      installationId: "test-installation",
      interactiveIdentityProvider: null,
      localBootstrapCredential: null,
      protectBootstrapAdministrator: false,
      repository,
      staging,
      publicationPreparationConfig: preparationConfig,
    });
    const preparationBlobs: PublicationPreparationBlobs = {
      put: (write) =>
        Effect.tryPromise({
          try: (fiberSignal) => blobStore.put({...write, signal: fiberSignal}),
          catch: (cause) => new BlobStorageFailure({cause, operation: "put"}),
        }),
    };
    const preparationStaging: PublicationPreparationStaging = {
      open: (uploadId, storageToken) =>
        Effect.tryPromise({
          try: () => staging.open(uploadId, storageToken),
          catch: (cause) => new StagingStorageFailure({cause, operation: "open"}),
        }),
    };
    const boundedPreparationLayer = PublicationPreparationService.layer({
      blobs: preparationBlobs,
      clock,
      config: preparationConfig,
      repository,
      staging: preparationStaging,
    });
    return ManagedRuntime.make(
      Layer.merge(baseLayer, boundedPreparationLayer),
    );
  }
});

interface FileSlot {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

function fileSlot(filePath: string, content: string): FileSlot {
  const bytes = new TextEncoder().encode(content);
  return {
    bytes,
    mediaType: "text/plain",
    path: filePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

function mutatedCopy(bytes: Uint8Array): Uint8Array {
  const mutated = bytes.slice();
  const last = mutated.byteLength - 1;
  mutated[last] = ((mutated[last] ?? 0) + 1) % 256;
  return mutated;
}

function publicationSource(
  stagingStore: LocalStagingStore,
  upload: {readonly id: string},
  file: {
    readonly entry: {readonly path: string; readonly sha256: string; readonly size: number};
    readonly installedAt: string | null;
    readonly storageToken: string;
  },
): PublicationFileSource {
  return {
    installed: file.installedAt !== null,
    open: Effect.fn("PublicationPreparationService.openStagedFile")(
      function*(): Effect.fn.Return<ReadableStream<Uint8Array>, StagingStorageFailure> {
        const opened = yield* Effect.tryPromise({
          try: () => stagingStore.open(upload.id, file.storageToken),
          catch: (cause) => new StagingStorageFailure({cause, operation: "open"}),
        });
        if (opened.size !== file.entry.size) {
          yield* Effect.tryPromise({
            try: () => opened.body.cancel(),
            catch: (cause) => new StagingStorageFailure({cause, operation: "open"}),
          });
          return yield* new StagingStorageFailure({
            cause: new Error("A verified staged file changed before publication."),
            operation: "open",
          });
        }
        return opened.body;
      },
    ),
    path: file.entry.path,
    sha256: file.entry.sha256,
    size: file.entry.size,
    staged: {
      storageToken: file.storageToken,
      uploadId: upload.id,
    },
  };
}

function testPrincipal(
  id: string,
  installationId = "test-installation",
): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities: [
      principalCapabilities.createArtifact,
      principalCapabilities.issueContentSession,
      principalCapabilities.publishAnyArtifact,
    ],
    displayName: "Publication preparation fixture",
    id,
    installationId,
    kind: principalKinds.service,
    membershipRole: membershipRoles.member,
  };
}

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

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function runStaged<A, E>(
  runtime: ApplicationRuntime,
  operation: (
    service: StagedUploadService["Service"],
  ) => Effect.Effect<A, E>,
): Promise<A> {
  return runtime.runPromise(StagedUploadService.use(operation));
}

function runPreparation<A, E>(
  runtime: ApplicationRuntime,
  operation: (
    service: PublicationPreparationService["Service"],
  ) => Effect.Effect<A, E>,
): Promise<A> {
  return runtime.runPromise(PublicationPreparationService.use(operation));
}

function runPublish<A, E>(
  runtime: ApplicationRuntime,
  operation: (
    service: PublishArtifactService["Service"],
  ) => Effect.Effect<A, E>,
): Promise<A> {
  return runtime.runPromise(PublishArtifactService.use(operation));
}

class CountingBlobStore implements BlobStore {
  readonly #inner: LocalBlobStore;
  #count = 0;

  constructor(inner: LocalBlobStore) {
    this.#inner = inner;
  }

  get count(): number {
    return this.#count;
  }

  inspect(sha256: string): Promise<StoredBlob> {
    return this.#inner.inspect(sha256);
  }

  open(sha256: string): Promise<OpenedBlob> {
    return this.#inner.open(sha256);
  }

  openRange(sha256: string, range: {readonly endInclusive: number; readonly start: number}): Promise<OpenedBlobRange> {
    return this.#inner.openRange(sha256, range);
  }

  async put(write: BlobWrite): Promise<StoredBlob> {
    this.#count += 1;
    return this.#inner.put(write);
  }
}

class FailingBlobStore implements BlobStore {
  readonly #inner: LocalBlobStore;
  #failAfter: number | null = null;
  #count = 0;

  constructor(inner: LocalBlobStore) {
    this.#inner = inner;
  }

  setFailAfter(value: number): void {
    this.#failAfter = value;
    this.#count = 0;
  }

  clearFailAfter(): void {
    this.#failAfter = null;
    this.#count = 0;
  }

  inspect(sha256: string): Promise<StoredBlob> {
    return this.#inner.inspect(sha256);
  }

  open(sha256: string): Promise<OpenedBlob> {
    return this.#inner.open(sha256);
  }

  openRange(sha256: string, range: {readonly endInclusive: number; readonly start: number}): Promise<OpenedBlobRange> {
    return this.#inner.openRange(sha256, range);
  }

  async put(write: BlobWrite): Promise<StoredBlob> {
    if (this.#failAfter !== null) {
      if (this.#count >= this.#failAfter) {
        throw new Error("Simulated blob-store outage.");
      }
      this.#count += 1;
    }
    return this.#inner.put(write);
  }
}

async function countFiles(directory: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, {withFileTypes: true});
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  const counts = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) {
      return countFiles(path.join(directory, entry.name));
    }
    return entry.isFile() ? 1 : 0;
  }));
  return counts.reduce((total, count) => total + count, 0);
}
