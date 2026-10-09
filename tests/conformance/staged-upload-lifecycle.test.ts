import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Effect, ManagedRuntime, Redacted, Result} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import type {ApplicationRuntime} from "../../src/application/application-runtime.js";
import {StagedUploadService} from "../../src/application/staged-upload.js";
import {ExpiredStagingCleanupService} from
  "../../src/application/expired-staging-cleanup.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import type {Clock, ExpiredStagedUpload, StagingStore} from "../../src/core/ports.js";
import {SystemIdGenerator} from "../../src/core/system.js";
import {createLocalApplicationLayer} from "../../src/local/create-local-application-layer.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";

describe("staged upload lifecycle", () => {
  let clock: ControlledClock;
  let dataDirectory: string;
  let databasePath: string;
  let blobs: LocalBlobStore;
  let repository: SqliteArtifactRepository;
  let identityRepository: SqliteIdentityRepository;
  let runtime: ApplicationRuntime;
  let staging: LocalStagingStore;

  const createRuntime = (overrides?: {
    repository?: SqliteArtifactRepository;
    staging?: StagingStore;
  }): ApplicationRuntime =>
    ManagedRuntime.make(createLocalApplicationLayer({
      apiToken: Redacted.make("test-api-token"),
      blobs,
      bootstrapAdministratorEmail: "admin@example.test",
      clock,
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
      repository: overrides?.repository ?? repository,
      staging: overrides?.staging ?? staging,
    }));

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-upload-lifecycle-"));
    clock = new ControlledClock(new Date("2026-08-13T00:00:00.000Z"));
    databasePath = path.join(dataDirectory, "artifact-server.db");
    blobs = new LocalBlobStore(path.join(dataDirectory, "blobs"));
    repository = new SqliteArtifactRepository(databasePath);
    identityRepository = new SqliteIdentityRepository(databasePath);
    staging = new LocalStagingStore(path.join(dataDirectory, "staging"));
    runtime = createRuntime();
    await runtime.context();
  });

  afterEach(async () => {
    await runtime.dispose();
    identityRepository.close();
    repository.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("PUB-001-F: another principal or installation cannot use a staged upload", async () => {
    expect.hasAssertions();
    const bytes = new TextEncoder().encode("isolated upload");
    const file = {
      mediaType: "text/plain",
      path: "proof.txt",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
    const uploadResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: file.path,
        files: [file],
        principal: testPrincipal("principal-a"),
      })
    );
    if (uploadResult.kind === "committed") {
      throw new Error("Fixture upload unexpectedly returned a committed publication.");
    }
    const upload = uploadResult.upload;
    const slot = upload.files[0];
    if (slot === undefined) throw new Error("The principal fixture has no file slot.");

    await expectStagedFailure(runtime, "UploadNotFound", (service) =>
      service.uploadFile({
        body: byteStream(bytes),
        ownerId: "principal-b",
        projectId: upload.projectId,
        storageToken: slot.storageToken,
        uploadId: upload.id,
      })
    );
    await expectStagedFailure(runtime, "UploadNotFound", (service) =>
      service.commitUpload({
        idempotencyKey: "other-principal-cannot-commit",
        principal: testPrincipal("principal-b"),
        target: {
          accessSetting: "public_link",
          kind: "new_artifact",
          name: "Must not commit",
        },
        uploadId: upload.id,
      })
    );

    const foreignRepository = new SqliteArtifactRepository(
      path.join(dataDirectory, "foreign-installation.db"),
    );
    const foreignIdentityRepository = new SqliteIdentityRepository(
      path.join(dataDirectory, "foreign-installation.db"),
    );
    try {
      const foreignRuntime: ApplicationRuntime = ManagedRuntime.make(
        createLocalApplicationLayer({
          apiToken: Redacted.make("foreign-api-token"),
          blobs: new LocalBlobStore(path.join(dataDirectory, "foreign-blobs")),
          bootstrapAdministratorEmail: "foreign-admin@example.test",
          clock,
          dispatches: foreignRepository,
          externalApiBearerVerifier: null,
          externalMcpBearerVerifier: null,
          externalMcpOAuthVerifier: null,
          ids: new SystemIdGenerator(),
          identityRepository: foreignIdentityRepository,
          installationId: "foreign-installation",
          interactiveIdentityProvider: null,
          localBootstrapCredential: null,
          protectBootstrapAdministrator: false,
          repository: foreignRepository,
          staging: new LocalStagingStore(path.join(dataDirectory, "foreign-staging")),
        }),
      );
      await foreignRuntime.context();
      try {
        await expectStagedFailure(
          foreignRuntime,
          "UploadNotFound",
          (service) => service.uploadFile({
            body: byteStream(bytes),
            ownerId: upload.principalId,
            projectId: upload.projectId,
            storageToken: slot.storageToken,
            uploadId: upload.id,
          }),
        );
        await expectStagedFailure(
          foreignRuntime,
          "UploadNotFound",
          (service) => service.commitUpload({
            idempotencyKey: "foreign-installation-cannot-commit",
            principal: testPrincipal(
              upload.principalId,
              "foreign-installation",
            ),
            target: {
              accessSetting: "public_link",
              kind: "new_artifact",
              name: "Must not commit",
            },
            uploadId: upload.id,
          }),
        );
      } finally {
        await foreignRuntime.dispose();
      }
    } finally {
      foreignIdentityRepository.close();
      foreignRepository.close();
    }
  });

  test("expiry closes only uncommitted staging while committed retries remain stable", async () => {
    expect.hasAssertions();
    const bytes = new TextEncoder().encode("staged lifecycle proof");
    const file = {
      mediaType: "text/plain",
      path: "proof.txt",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
    const expiredResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: file.path,
        files: [file],
        principal: testPrincipal("principal-a"),
      })
    );
    if (expiredResult.kind === "committed") {
      throw new Error("Fixture upload unexpectedly returned a committed publication.");
    }
    const expired = expiredResult.upload;
    const expiredSlot = expired.files[0];
    if (expiredSlot === undefined) throw new Error("The expiry fixture has no file slot.");
    clock.set(new Date(expired.expiresAt));

    await expectStagedFailure(runtime, "UploadExpired", (service) =>
      service.uploadFile({
        body: byteStream(bytes),
        ownerId: expired.principalId,
        projectId: expired.projectId,
        storageToken: expiredSlot.storageToken,
        uploadId: expired.id,
      })
    );
    await expectStagedFailure(runtime, "UploadExpired", (service) =>
      service.commitUpload({
        idempotencyKey: "expired-upload-cannot-commit",
        principal: testPrincipal(expired.principalId),
        target: {
          accessSetting: "public_link",
          kind: "new_artifact",
          name: "Expired upload",
        },
        uploadId: expired.id,
      })
    );

    clock.set(new Date("2026-08-13T02:00:00.000Z"));
    const liveResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: file.path,
        files: [file],
        principal: testPrincipal("principal-a"),
      })
    );
    if (liveResult.kind === "committed") {
      throw new Error("Fixture upload unexpectedly returned a committed publication.");
    }
    const live = liveResult.upload;
    const liveSlot = live.files[0];
    if (liveSlot === undefined) throw new Error("The commit fixture has no file slot.");
    await runStaged(runtime, (service) => service.uploadFile({
      body: byteStream(bytes),
      ownerId: live.principalId,
      projectId: "prj_default",
      storageToken: liveSlot.storageToken,
      uploadId: live.id,
    }));
    const target = {
      accessSetting: "public_link" as const,
      kind: "new_artifact" as const,
      name: "Committed upload",
    };
    const committedResult = await runStaged(runtime, (service) => service.commitUpload({
      idempotencyKey: "committed-upload-stable-retry",
      principal: testPrincipal(live.principalId),
      target,
      uploadId: live.id,
    }));
    if (committedResult.kind !== "committed") {
      throw new Error(`Expected committed result, got ${committedResult.kind}.`);
    }
    const committed = committedResult.publication;

    clock.set(new Date(live.expiresAt));
    await rm(path.join(dataDirectory, "staging", live.id), {
      force: true,
      recursive: true,
    });
    const replayResult = await runStaged(runtime, (service) => service.commitUpload({
      idempotencyKey: "committed-upload-stable-retry",
      principal: testPrincipal(live.principalId),
      target,
      uploadId: live.id,
    }));
    if (replayResult.kind !== "committed") {
      throw new Error(`Expected committed replay, got ${replayResult.kind}.`);
    }
    const replay = replayResult.publication;
    expect(replay.replayed).toBe(true);
    expect(replay.version.id).toBe(committed.version.id);

    await expectStagedFailure(runtime, "UploadClosed", (service) =>
      service.commitUpload({
        idempotencyKey: "committed-upload-new-command",
        principal: testPrincipal(live.principalId),
        target,
        uploadId: live.id,
      })
    );
  });

  test("PUB-009-B OPS-006-F: cleanup is bounded, waits for settle, tolerates concurrent passes, and preserves committed work", async () => {
    const bytes = new TextEncoder().encode("cleanup lifecycle proof");
    const file = {
      mediaType: "text/plain",
      path: "proof.txt",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
    const expiredResult = await runStaged(runtime, (service) => service.createUpload({
      entryPath: file.path,
      files: [file],
      principal: testPrincipal("cleanup-principal"),
    }));
    if (expiredResult.kind === "committed") {
      throw new Error("Fixture upload unexpectedly returned a committed publication.");
    }
    const expired = expiredResult.upload;
    const expiredFile = expired.files[0];
    if (expiredFile === undefined) throw new Error("The cleanup fixture has no file.");
    await runStaged(runtime, (service) => service.uploadFile({
      body: byteStream(bytes),
      ownerId: expired.principalId,
      projectId: "prj_default",
      storageToken: expiredFile.storageToken,
      uploadId: expired.id,
    }));

    const committedUploadResult = await runStaged(runtime, (service) => service.createUpload({
      entryPath: file.path,
      files: [file],
      principal: testPrincipal("cleanup-principal"),
    }));
    if (committedUploadResult.kind === "committed") {
      throw new Error("Fixture upload unexpectedly returned a committed publication.");
    }
    const committedUpload = committedUploadResult.upload;
    const committedFile = committedUpload.files[0];
    if (committedFile === undefined) {
      throw new Error("The committed cleanup fixture has no file.");
    }
    await runStaged(runtime, (service) => service.uploadFile({
      body: byteStream(bytes),
      ownerId: committedUpload.principalId,
      projectId: "prj_default",
      storageToken: committedFile.storageToken,
      uploadId: committedUpload.id,
    }));
    await runStaged(runtime, (service) => service.commitUpload({
      idempotencyKey: "cleanup-preserves-committed-work",
      principal: testPrincipal(committedUpload.principalId),
      target: {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Committed cleanup control",
      },
      uploadId: committedUpload.id,
    }));

    clock.set(new Date(new Date(expired.expiresAt).getTime() + 5 * 60 * 1_000 - 1));
    const tooEarly = await runCleanup(runtime, 100);
    expect(tooEarly).toEqual({
      alreadyAbsent: 0,
      budgetExhausted: false,
      claimRejected: 0,
      deleted: 0,
      failed: 0,
      remaining: 0,
      selected: 0,
    });
    const beforeCleanup = await staging.open(expired.id, expiredFile.storageToken);
    expect(beforeCleanup.size).toBe(bytes.byteLength);
    await beforeCleanup.body.cancel();

    clock.set(new Date(new Date(expired.expiresAt).getTime() + 5 * 60 * 1_000));
    const concurrent = await Promise.all([
      runCleanup(runtime, 100),
      runCleanup(runtime, 100),
    ]);
    expect(concurrent.reduce((sum, report) => sum + report.deleted, 0)).toBe(1);
    expect(concurrent.reduce((sum, report) => sum + report.failed, 0)).toBe(0);
    // A live claim is exclusive, so the losing pass never touches the objects
    // the winner is removing.
    expect(concurrent.reduce((sum, report) => sum + report.claimRejected, 0)).toBe(1);
    expect(concurrent.reduce((sum, report) => sum + report.alreadyAbsent, 0)).toBe(0);
    await expect(repository.findStagedUpload(
      expired.projectId,
      expired.id,
      expired.principalId,
    )).resolves.toBeNull();
    await expect(staging.open(expired.id, expiredFile.storageToken)).rejects
      .toThrow(/ENOENT|no such file/u);

    await expect(repository.findStagedUpload(
      committedUpload.projectId,
      committedUpload.id,
      committedUpload.principalId,
    )).resolves.toMatchObject({status: "committed"});
    const committedBytes = await staging.open(
      committedUpload.id,
      committedFile.storageToken,
    );
    expect(committedBytes.size).toBe(bytes.byteLength);
    await committedBytes.body.cancel();
    const immutableBlob = await blobs.open(file.sha256);
    expect(new Uint8Array(await new Response(immutableBlob.body).arrayBuffer()))
      .toEqual(bytes);
  });

  test("foundation: an interrupted local write cannot reappear after cleanup", async () => {
    const declaredBytes = new Uint8Array(1024 * 1024);
    const controller = new AbortController();
    const incoming = new TransformStream<Uint8Array, Uint8Array>();
    const writer = incoming.writable.getWriter();
    const uploadId = "upl_00000000-0000-4000-8000-000000000001";
    const storageToken = "a".repeat(36);
    const write = staging.put({
      body: incoming.readable,
      sha256: createHash("sha256").update(declaredBytes).digest("hex"),
      signal: controller.signal,
      size: declaredBytes.byteLength,
      storageToken,
      uploadId,
    });
    await writer.write(declaredBytes.subarray(0, 64 * 1024));
    controller.abort(new Error("staging deadline reached"));
    await writer.abort(controller.signal.reason).catch(() => undefined);
    await expect(write).rejects.toThrow(/deadline|abort/u);

    await staging.remove(uploadId, storageToken);
    await expect(staging.open(uploadId, storageToken)).rejects
      .toThrow(/ENOENT|no such file/u);
  });

  test("cleanup skips an expired upload with an unexpired preparation lease", async () => {
    expect.hasAssertions();
    const bytes = new TextEncoder().encode("leased cleanup proof");
    const file = {
      mediaType: "text/plain",
      path: "leased.txt",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
    const uploadResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: file.path,
        files: [file],
        principal: testPrincipal("leased-cleanup-principal"),
      })
    );
    if (uploadResult.kind === "committed") {
      throw new Error("Fixture upload unexpectedly returned a committed publication.");
    }
    const upload = uploadResult.upload;
    const slot = upload.files[0];
    if (slot === undefined) throw new Error("The lease fixture has no file slot.");
    await runStaged(runtime, (service) => service.uploadFile({
      body: byteStream(bytes),
      ownerId: upload.principalId,
      projectId: upload.projectId,
      storageToken: slot.storageToken,
      uploadId: upload.id,
    }));

    const leaseUntil = new Date(
      new Date(upload.expiresAt).getTime() + 60 * 60 * 1_000,
    );
    const claim = await repository.claimUploadPreparation(
      upload.id,
      clock.now().toISOString(),
      leaseUntil.toISOString(),
    );
    if (claim === null) throw new Error("Failed to claim upload for lease test.");

    clock.set(new Date(new Date(upload.expiresAt).getTime() + 5 * 60 * 1_000));
    const report = await runCleanup(runtime, 100);
    expect(report).toMatchObject({
      budgetExhausted: false,
      deleted: 0,
      failed: 0,
      selected: 0,
    });
    const stillThere = await repository.findStagedUpload(
      upload.projectId,
      upload.id,
      upload.principalId,
    );
    expect(stillThere).not.toBeNull();
    const staged = await staging.open(upload.id, slot.storageToken);
    expect(staged.size).toBe(bytes.byteLength);
    await staged.body.cancel();
  });

  test("cleanup delete-time fence refuses an upload whose lease is claimed after selection", async () => {
    expect.hasAssertions();
    const bytes = new TextEncoder().encode("fence cleanup proof");
    const file = {
      mediaType: "text/plain",
      path: "fenced.txt",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
    const uploadResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: file.path,
        files: [file],
        principal: testPrincipal("fence-cleanup-principal"),
      })
    );
    if (uploadResult.kind === "committed") {
      throw new Error("Fixture upload unexpectedly returned a committed publication.");
    }
    const upload = uploadResult.upload;
    const slot = upload.files[0];
    if (slot === undefined) throw new Error("The fence fixture has no file slot.");
    await runStaged(runtime, (service) => service.uploadFile({
      body: byteStream(bytes),
      ownerId: upload.principalId,
      projectId: upload.projectId,
      storageToken: slot.storageToken,
      uploadId: upload.id,
    }));

    clock.set(new Date(new Date(upload.expiresAt).getTime() + 5 * 60 * 1_000));
    const cleanupTime = clock.now().toISOString();
    const expiredBefore = new Date(
      new Date(upload.expiresAt).getTime() + 5 * 60 * 1_000,
    ).toISOString();
    const selected = await repository.listExpiredStagedUploads(
      expiredBefore,
      cleanupTime,
      100,
    );
    expect(selected).toHaveLength(1);

    const leaseUntil = new Date(
      new Date(upload.expiresAt).getTime() + 60 * 60 * 1_000,
    );
    const claim = await repository.claimUploadPreparation(
      upload.id,
      cleanupTime,
      leaseUntil.toISOString(),
    );
    if (claim === null) throw new Error("Failed to claim upload for fence test.");

    const removed = await repository.removeExpiredStagedUpload(
      upload.id,
      expiredBefore,
      cleanupTime,
    );
    expect(removed).toBe(false);
    const stillThere = await repository.findStagedUpload(
      upload.projectId,
      upload.id,
      upload.principalId,
    );
    expect(stillThere).not.toBeNull();
  });

  test("PUB-009-F: a preparation claim racing cleanup object removal is refused", async () => {
    expect.hasAssertions();
    const bytes = new TextEncoder().encode("racing cleanup proof");
    const file = {
      mediaType: "text/plain",
      path: "racing.txt",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
    const uploadResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: file.path,
        files: [file],
        principal: testPrincipal("racing-cleanup-principal"),
      })
    );
    if (uploadResult.kind === "committed") {
      throw new Error("Fixture upload unexpectedly returned a committed publication.");
    }
    const upload = uploadResult.upload;
    const slot = upload.files[0];
    if (slot === undefined) throw new Error("The race fixture has no file slot.");
    await runStaged(runtime, (service) => service.uploadFile({
      body: byteStream(bytes),
      ownerId: upload.principalId,
      projectId: upload.projectId,
      storageToken: slot.storageToken,
      uploadId: upload.id,
    }));

    clock.set(new Date(new Date(upload.expiresAt).getTime() + 5 * 60 * 1_000));
    const claimAttempts: Array<unknown> = [];
    const racingStaging: StagingStore = {
      open: (uploadId, storageToken) => staging.open(uploadId, storageToken),
      put: (write) => staging.put(write),
      remove: async (uploadId, storageToken) => {
        // The hostile claim lands at the exact moment cleanup removes the
        // object; cleanup must already hold its own claim, refusing this one.
        claimAttempts.push(await repository.claimUploadPreparation(
          uploadId,
          clock.now().toISOString(),
          new Date(clock.now().getTime() + 60 * 60 * 1_000).toISOString(),
        ));
        await staging.remove(uploadId, storageToken);
      },
    };
    const racingRuntime = createRuntime({staging: racingStaging});
    try {
      const report = await runCleanup(racingRuntime, 100);
      expect(report).toMatchObject({
        claimRejected: 0,
        deleted: 1,
        failed: 0,
        selected: 1,
      });
    } finally {
      await racingRuntime.dispose();
    }
    expect(claimAttempts).toEqual([null]);
    await expect(repository.findStagedUpload(
      upload.projectId,
      upload.id,
      upload.principalId,
    )).resolves.toBeNull();
    await expect(staging.open(upload.id, slot.storageToken)).rejects
      .toThrow(/ENOENT|no such file/u);
  });

  test("cleanup skips an upload claimed between selection and removal", async () => {
    expect.hasAssertions();
    const bytes = new TextEncoder().encode("selection race proof");
    const file = {
      mediaType: "text/plain",
      path: "selection-race.txt",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
    const uploadResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: file.path,
        files: [file],
        principal: testPrincipal("selection-race-principal"),
      })
    );
    if (uploadResult.kind === "committed") {
      throw new Error("Fixture upload unexpectedly returned a committed publication.");
    }
    const upload = uploadResult.upload;
    const slot = upload.files[0];
    if (slot === undefined) throw new Error("The selection fixture has no file slot.");
    await runStaged(runtime, (service) => service.uploadFile({
      body: byteStream(bytes),
      ownerId: upload.principalId,
      projectId: upload.projectId,
      storageToken: slot.storageToken,
      uploadId: upload.id,
    }));

    clock.set(new Date(new Date(upload.expiresAt).getTime() + 5 * 60 * 1_000));
    const leaseUntil = new Date(clock.now().getTime() + 60 * 60 * 1_000).toISOString();
    // A second connection to the same database claims the upload after cleanup
    // selects it but before cleanup claims it; cleanup must leave the upload
    // untouched.
    const racingRepository = new class extends SqliteArtifactRepository {
      override async listExpiredStagedUploads(
        expiredBefore: string,
        now: string,
        limit: number,
      ): Promise<readonly ExpiredStagedUpload[]> {
        const selected = await super.listExpiredStagedUploads(
          expiredBefore,
          now,
          limit,
        );
        await this.claimUploadPreparation(upload.id, now, leaseUntil);
        return selected;
      }
    }(databasePath);
    const racingRuntime = createRuntime({repository: racingRepository});
    try {
      const report = await runCleanup(racingRuntime, 100);
      expect(report).toMatchObject({
        claimRejected: 1,
        deleted: 0,
        failed: 0,
        selected: 1,
      });
    } finally {
      await racingRuntime.dispose();
      racingRepository.close();
    }
    const stillThere = await repository.findStagedUpload(
      upload.projectId,
      upload.id,
      upload.principalId,
    );
    expect(stillThere).not.toBeNull();
    const staged = await staging.open(upload.id, slot.storageToken);
    expect(staged.size).toBe(bytes.byteLength);
    await staged.body.cancel();
  });

  test("an interrupted cleanup pass keeps excluding preparation and a retry finishes", async () => {
    expect.hasAssertions();
    const files = ["interrupted-a.txt", "interrupted-b.txt"].map((name) => {
      const bytes = new TextEncoder().encode(name);
      return {
        mediaType: "text/plain",
        path: name,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      };
    });
    const firstFile = files[0];
    if (firstFile === undefined) throw new Error("The interruption fixture has no file.");
    const uploadResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: firstFile.path,
        files,
        principal: testPrincipal("interrupted-cleanup-principal"),
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
        body: byteStream(new TextEncoder().encode(file.path)),
        ownerId: upload.principalId,
        projectId: upload.projectId,
        storageToken: slot.storageToken,
        uploadId: upload.id,
      }));
    }));

    clock.set(new Date(new Date(upload.expiresAt).getTime() + 5 * 60 * 1_000));
    let crashArmed = true;
    const crashingStaging: StagingStore = {
      open: (uploadId, storageToken) => staging.open(uploadId, storageToken),
      put: (write) => staging.put(write),
      remove: async (uploadId, storageToken) => {
        if (crashArmed) {
          crashArmed = false;
          throw new Error("Simulated cleanup crash after the cleanup claim.");
        }
        await staging.remove(uploadId, storageToken);
      },
    };
    const crashingRuntime = createRuntime({staging: crashingStaging});
    try {
      const first = await runCleanup(crashingRuntime, 100);
      expect(first).toMatchObject({deleted: 0, failed: 1, selected: 1});
    } finally {
      await crashingRuntime.dispose();
    }

    const claim = await repository.claimUploadPreparation(
      upload.id,
      clock.now().toISOString(),
      new Date(clock.now().getTime() + 60 * 60 * 1_000).toISOString(),
    );
    expect(claim).toBeNull();

    const retry = await runCleanup(runtime, 100);
    expect(retry).toMatchObject({deleted: 1, failed: 0, selected: 1});
    await expect(repository.findStagedUpload(
      upload.projectId,
      upload.id,
      upload.principalId,
    )).resolves.toBeNull();
    await Promise.all(upload.files.map((slot) =>
      expect(staging.open(upload.id, slot.storageToken)).rejects
        .toThrow(/ENOENT|no such file/u),
    ));
  });

  test("cleanup reclaims a large expired upload over budget-bounded passes", async () => {
    expect.hasAssertions();
    const fileCount = 10;
    const files = Array.from({length: fileCount}, (_, index) => {
      const bytes = new TextEncoder().encode(`bounded-${index}.txt`);
      return {
        mediaType: "text/plain",
        path: `bounded-${index}.txt`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      };
    });
    const firstFile = files[0];
    if (firstFile === undefined) throw new Error("The fixture has no file.");

    const uploadResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: firstFile.path,
        files,
        principal: testPrincipal("bounded-cleanup-principal"),
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
        body: byteStream(new TextEncoder().encode(file.path)),
        ownerId: upload.principalId,
        projectId: upload.projectId,
        storageToken: slot.storageToken,
        uploadId: upload.id,
      }));
    }));

    clock.set(new Date(new Date(upload.expiresAt).getTime() + 5 * 60 * 1_000));
    let passes = 0;
    while (passes < 20) {
      passes += 1;
      // Sequential passes are the behavior under test: each pass must see
      // the durable progress left by the previous one.
      // eslint-disable-next-line no-await-in-loop
      const report = await runCleanup(runtime, 100, {maxFiles: 3});
      if (!report.budgetExhausted) break;
      expect(report.selected).toBe(1);
    }

    await expect(repository.findStagedUpload(
      upload.projectId,
      upload.id,
      upload.principalId,
    )).resolves.toBeNull();
    await Promise.all(upload.files.map(async (slot) =>
      expect(staging.open(upload.id, slot.storageToken)).rejects
        .toThrow(/ENOENT|no such file/u),
    ));
  });

  test("cleanup reports budget exhaustion honestly and resumes after interruption", async () => {
    expect.hasAssertions();
    const files = Array.from({length: 5}, (_, index) => {
      const bytes = new TextEncoder().encode(`resume-${index}.txt`);
      return {
        mediaType: "text/plain",
        path: `resume-${index}.txt`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      };
    });
    const firstFile = files[0];
    if (firstFile === undefined) throw new Error("The resume fixture has no file.");

    const uploadResult = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: firstFile.path,
        files,
        principal: testPrincipal("resume-cleanup-principal"),
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
        body: byteStream(new TextEncoder().encode(file.path)),
        ownerId: upload.principalId,
        projectId: upload.projectId,
        storageToken: slot.storageToken,
        uploadId: upload.id,
      }));
    }));

    clock.set(new Date(new Date(upload.expiresAt).getTime() + 5 * 60 * 1_000));
    const first = await runCleanup(runtime, 100, {maxFiles: 2});
    expect(first).toMatchObject({
      budgetExhausted: true,
      deleted: 0,
      failed: 0,
      remaining: 1,
      selected: 1,
    });

    const second = await runCleanup(runtime, 100, {maxFiles: 2});
    expect(second).toMatchObject({
      budgetExhausted: true,
      deleted: 0,
      failed: 0,
      remaining: 1,
      selected: 1,
    });

    const third = await runCleanup(runtime, 100, {maxFiles: 2});
    expect(third).toMatchObject({
      budgetExhausted: false,
      deleted: 1,
      failed: 0,
      remaining: 0,
      selected: 1,
    });

    await expect(repository.findStagedUpload(
      upload.projectId,
      upload.id,
      upload.principalId,
    )).resolves.toBeNull();
  });

  test("cleanup stops a pass when its wall-clock budget expires", async () => {
    expect.hasAssertions();
    const bytes = new TextEncoder().encode("time budget proof");
    const file = {
      mediaType: "text/plain",
      path: "time-budget.txt",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };

    const advancingClock = new AdvancingClock(
      new Date("2026-08-13T00:00:00.000Z"),
      2,
    );
    const advancingRuntime = ManagedRuntime.make(createLocalApplicationLayer({
      apiToken: Redacted.make("test-api-token"),
      blobs,
      bootstrapAdministratorEmail: "admin@example.test",
      clock: advancingClock,
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
    }));
    await advancingRuntime.context();
    try {
      const uploadResult = await advancingRuntime.runPromise(StagedUploadService.use((service) =>
        service.createUpload({
          entryPath: file.path,
          files: [file],
          principal: testPrincipal("time-budget-principal"),
        })));
      if (uploadResult.kind === "committed") {
        throw new Error("Fixture upload unexpectedly returned a committed publication.");
      }
      const upload = uploadResult.upload;
      const slot = upload.files[0];
      if (slot === undefined) throw new Error("The time-budget fixture has no file slot.");
      await advancingRuntime.runPromise(StagedUploadService.use((service) => service.uploadFile({
        body: byteStream(bytes),
        ownerId: upload.principalId,
        projectId: upload.projectId,
        storageToken: slot.storageToken,
        uploadId: upload.id,
      })));

      advancingClock.base.set(new Date(new Date(upload.expiresAt).getTime() + 5 * 60 * 1_000));
      const report = await advancingRuntime.runPromise(
        ExpiredStagingCleanupService.use((service) =>
          service.runPass({limit: 100, maxDurationMilliseconds: 1})),
      );
      expect(report.budgetExhausted).toBe(true);
      expect(report.selected).toBeGreaterThanOrEqual(1);
      expect(report.deleted).toBe(0);
    } finally {
      await advancingRuntime.dispose();
    }
  });
});

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
    displayName: "Staged upload fixture",
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

class AdvancingClock implements Clock {
  readonly base: ControlledClock;
  readonly stepMilliseconds: number;
  #calls = 0;

  constructor(initial: Date, stepMilliseconds: number) {
    this.base = new ControlledClock(initial);
    this.stepMilliseconds = stepMilliseconds;
  }

  now(): Date {
    this.#calls += 1;
    return new Date(
      this.base.now().getTime() + this.#calls * this.stepMilliseconds,
    );
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

function runCleanup(
  runtime: ApplicationRuntime,
  limit: number,
  budgets?: {maxDurationMilliseconds?: number; maxFiles?: number},
) {
  return runtime.runPromise(ExpiredStagingCleanupService.use((service) =>
    service.runPass({limit, ...budgets})));
}

async function expectStagedFailure<A, E extends {_tag: string}>(
  runtime: ApplicationRuntime,
  expectedTag: E["_tag"],
  operation: (
    service: StagedUploadService["Service"],
  ) => Effect.Effect<A, E>,
): Promise<void> {
  const result = await runtime.runPromise(
    Effect.result(StagedUploadService.use(operation)),
  );
  const actualTag = Result.match(result, {
    onFailure: (failure) => failure._tag,
    onSuccess: () => "UnexpectedSuccess",
  });
  expect(actualTag).toBe(expectedTag);
}
