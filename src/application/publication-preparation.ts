import {Context, DateTime, Duration, Effect, Layer} from "effect";

import {
  ArtifactRepositoryFailure,
  type BlobStorageFailure,
  StagingStorageFailure,
  UploadClosed,
  UploadExpired,
  UploadIncomplete,
  type UploadNotFound,
  UploadPreparationLeaseLost,
} from "../core/errors.js";
import {
  preparationStates,
  uploadStatuses,
  type ManifestEntry,
  type StagedUpload,
  type StagedUploadFile,
} from "../core/model.js";
import type {
  OpenedStagedFile,
  StagedUploadRepository,
  StoredBlob,
} from "../core/ports.js";
import type {ApplicationClock} from "./application-clock.js";
import {
  installPublicationFile,
  type PublicationFileSource,
} from "./install-publication-file.js";

const preparationLeaseSeconds = 45;
const preparationRenewalSeconds = 15;
const installConcurrency = 4;

/** Repository capabilities required by publication preparation. */
export type PublicationPreparationRepository = Pick<
  StagedUploadRepository,
  | "claimUploadPreparation"
  | "countPreparedManifestEntries"
  | "extendStagedUploadExpiry"
  | "findStagedUpload"
  | "markUploadPrepared"
  | "recordStagedFileInstalled"
  | "releaseUploadPreparation"
  | "renewUploadPreparation"
  | "writePreparedManifestEntries"
>;

/** Staging capabilities required to open staged files for verification. */
export interface PublicationPreparationStaging {
  readonly open: (
    uploadId: string,
    storageToken: string,
  ) => Effect.Effect<OpenedStagedFile, StagingStorageFailure>;
}

/** Blob capabilities required to install staged files into immutable storage. */
export interface PublicationPreparationBlobs {
  readonly put: (
    write: {readonly body: ReadableStream<Uint8Array>; readonly sha256: string; readonly size: number; readonly signal?: AbortSignal},
  ) => Effect.Effect<StoredBlob, BlobStorageFailure>;
  readonly promote?: (
    source: {readonly sha256: string; readonly size: number; readonly storageToken: string; readonly uploadId: string},
  ) => Effect.Effect<StoredBlob, BlobStorageFailure>;
}

/** Runtime configuration that sizes each preparation pass. */
export interface PublicationPreparationConfig {
  /** Maximum number of files installed in one invocation. */
  readonly filesPerPass: number;
  /** Maximum number of manifest entries written in one invocation. */
  readonly preparedEntriesPerPass: number;
}

/** Dependencies used to construct the publication preparation service. */
export interface PublicationPreparationDependencies {
  readonly blobs: PublicationPreparationBlobs;
  readonly clock: ApplicationClock;
  readonly config: PublicationPreparationConfig;
  readonly repository: PublicationPreparationRepository;
  readonly staging: PublicationPreparationStaging;
}

/** Input for preparing one staged upload for commit. */
export interface PrepareUploadCommand {
  readonly upload: StagedUpload;
}

/** Result of one bounded preparation pass. */
export type PrepareUploadResult =
  | {readonly kind: "prepared"}
  | {readonly kind: "preparing"; readonly installed: number; readonly total: number};

/** Expected failures produced by the publication preparation service. */
export type PublicationPreparationFailure =
  | ArtifactRepositoryFailure
  | BlobStorageFailure
  | StagingStorageFailure
  | UploadClosed
  | UploadExpired
  | UploadIncomplete
  | UploadNotFound
  | UploadPreparationLeaseLost;

interface PublicationPreparationOperations {
  readonly prepareUpload: (
    command: PrepareUploadCommand,
  ) => Effect.Effect<PrepareUploadResult, PublicationPreparationFailure>;
}

/** Prepares staged uploads for atomic commit through bounded, resumable passes. */
export class PublicationPreparationService extends Context.Service<
  PublicationPreparationService,
  PublicationPreparationOperations
>()("artifact-server/application/PublicationPreparationService") {
  /** Construct the service from publication-preparation ports. */
  static readonly layer = (
    dependencies: PublicationPreparationDependencies,
  ): Layer.Layer<PublicationPreparationService> =>
    Layer.succeed(PublicationPreparationService, makePublicationPreparationService(dependencies));
}

function makePublicationPreparationService(
  dependencies: PublicationPreparationDependencies,
): PublicationPreparationOperations {
  const installFile = (
    upload: StagedUpload,
    file: StagedUploadFile,
  ): Effect.Effect<StoredBlob, BlobStorageFailure | StagingStorageFailure> =>
    installPublicationFile(dependencies.blobs, stagedFileSource(upload, file, dependencies.staging));

  const ensurePreparedManifestEntries = (
    upload: StagedUpload,
    attempts: number,
  ): Effect.Effect<boolean, ArtifactRepositoryFailure | UploadPreparationLeaseLost> =>
    Effect.gen(function*() {
      const count = yield* Effect.tryPromise({
        try: () => dependencies.repository.countPreparedManifestEntries(upload.id),
        catch: (cause) => repositoryFailure("countPreparedManifestEntries", cause),
      });
      if (count === upload.manifest.entries.length) return true;
      const entriesToWrite = upload.manifest.entries.slice(
        count,
        count + dependencies.config.preparedEntriesPerPass,
      );
      yield* writePreparedManifestEntries(upload, attempts, entriesToWrite);
      return count + entriesToWrite.length >= upload.manifest.entries.length;
    });

  const writePreparedManifestEntries = (
    upload: StagedUpload,
    attempts: number,
    entries: readonly ManifestEntry[],
  ): Effect.Effect<void, ArtifactRepositoryFailure | UploadPreparationLeaseLost> =>
    Effect.tryPromise({
      try: () => dependencies.repository.writePreparedManifestEntries(
        upload.id,
        attempts,
        entries,
      ),
      catch: (cause) =>
        cause instanceof UploadPreparationLeaseLost
          ? cause
          : repositoryFailure("writePreparedManifestEntries", cause),
    });

  const markPrepared = (
    upload: StagedUpload,
    attempts: number,
  ): Effect.Effect<void, ArtifactRepositoryFailure | UploadPreparationLeaseLost> =>
    Effect.gen(function*() {
      const now = yield* dependencies.clock.now;
      yield* Effect.tryPromise({
        try: () => dependencies.repository.markUploadPrepared(
          upload.id,
          attempts,
          DateTime.formatIso(now),
        ),
        catch: (cause) =>
          cause instanceof UploadPreparationLeaseLost
            ? cause
            : repositoryFailure("markUploadPrepared", cause),
      });
    });

  const release = (
    uploadId: string,
    attempts: number,
  ): Effect.Effect<void, ArtifactRepositoryFailure> =>
    Effect.tryPromise({
      try: () => dependencies.repository.releaseUploadPreparation(uploadId, attempts),
      catch: (cause) => repositoryFailure("releaseUploadPreparation", cause),
    });

  const claim = (
    upload: StagedUpload,
  ): Effect.Effect<
    {readonly attempts: number; readonly leaseExpiresAt: string},
    PublicationPreparationFailure
  > =>
    Effect.gen(function*() {
      const now = yield* dependencies.clock.now;
      const leaseExpiresAt = DateTime.formatIso(
        DateTime.addDuration(now, Duration.seconds(preparationLeaseSeconds)),
      );
      const claimResult = yield* Effect.tryPromise({
        try: () => dependencies.repository.claimUploadPreparation(
          upload.id,
          DateTime.formatIso(now),
          leaseExpiresAt,
        ),
        catch: (cause) => repositoryFailure("claimUploadPreparation", cause),
      });
      if (claimResult === null) {
        return yield* Effect.fail(new UploadPreparationLeaseLost());
      }
      return {
        attempts: claimResult.attempts,
        leaseExpiresAt: claimResult.leaseExpiresAt,
      };
    });

  const renewLeaseIfDue = (
    upload: StagedUpload,
    attempts: number,
    leaseExpiresAt: string,
  ): Effect.Effect<string, ArtifactRepositoryFailure | UploadPreparationLeaseLost> =>
    Effect.gen(function*() {
      const now = yield* dependencies.clock.now;
      const renewThreshold = DateTime.addDuration(
        now,
        Duration.seconds(preparationRenewalSeconds),
      );
      if (DateTime.isLessThanOrEqualTo(DateTime.makeUnsafe(leaseExpiresAt), renewThreshold)) {
        const newLeaseExpiresAt = DateTime.formatIso(
          DateTime.addDuration(now, Duration.seconds(preparationLeaseSeconds)),
        );
        const renewed = yield* Effect.tryPromise({
          try: () => dependencies.repository.renewUploadPreparation(
            upload.id,
            attempts,
            DateTime.formatIso(now),
            newLeaseExpiresAt,
          ),
          catch: (cause) => repositoryFailure("renewUploadPreparation", cause),
        });
        if (!renewed) {
          return yield* Effect.fail(new UploadPreparationLeaseLost());
        }
        return newLeaseExpiresAt;
      }
      return leaseExpiresAt;
    });

  const refreshUploadExpiry = (
    upload: StagedUpload,
    attempts: number,
  ): Effect.Effect<void, ArtifactRepositoryFailure | UploadPreparationLeaseLost> =>
    Effect.gen(function*() {
      const now = yield* dependencies.clock.now;
      const newExpiresAt = DateTime.formatIso(
        DateTime.addDuration(now, Duration.minutes(60)),
      );
      const extended = yield* Effect.tryPromise({
        try: () => dependencies.repository.extendStagedUploadExpiry(
          upload.id,
          attempts,
          newExpiresAt,
        ),
        catch: (cause) =>
          cause instanceof UploadPreparationLeaseLost
            ? cause
            : repositoryFailure("extendStagedUploadExpiry", cause),
      });
      if (!extended) {
        return yield* Effect.fail(new UploadPreparationLeaseLost());
      }
      return undefined;
    });

  const recordInstalled = (
    upload: StagedUpload,
    attempts: number,
    file: StagedUploadFile,
  ): Effect.Effect<void, ArtifactRepositoryFailure | UploadPreparationLeaseLost> =>
    Effect.gen(function*() {
      const now = yield* dependencies.clock.now;
      yield* Effect.tryPromise({
        try: () => dependencies.repository.recordStagedFileInstalled(
          upload.id,
          file.storageToken,
          attempts,
          DateTime.formatIso(now),
        ),
        catch: (cause) =>
          cause instanceof UploadPreparationLeaseLost
            ? cause
            : repositoryFailure("recordStagedFileInstalled", cause),
      });
    });

  const installBatch = (
    upload: StagedUpload,
    attempts: number,
    files: readonly StagedUploadFile[],
    leaseExpiresAt: string,
  ): Effect.Effect<string, PublicationPreparationFailure> =>
    Effect.gen(function*() {
      let currentLeaseExpiresAt = leaseExpiresAt;
      for (let i = 0; i < files.length; i += installConcurrency) {
        currentLeaseExpiresAt = yield* renewLeaseIfDue(
          upload,
          attempts,
          currentLeaseExpiresAt,
        );
        const chunk = files.slice(i, i + installConcurrency);
        yield* Effect.forEach(
          chunk,
          (file) =>
            Effect.gen(function*() {
              yield* installFile(upload, file);
              yield* recordInstalled(upload, attempts, file);
            }),
          {concurrency: installConcurrency, discard: true},
        );
      }
      return currentLeaseExpiresAt;
    });

  const prepareUpload = Effect.fn("PublicationPreparationService.prepareUpload")(
    function*(
      command: PrepareUploadCommand,
    ): Effect.fn.Return<PrepareUploadResult, PublicationPreparationFailure> {
      // Re-fetch the upload so callers that hold a stale snapshot (e.g. linked
      // captures that stage and upload files in separate steps) see current
      // uploadedAt/installedAt values.
      const latest = yield* Effect.tryPromise({
        try: () => dependencies.repository.findStagedUpload(
          command.upload.projectId,
          command.upload.id,
          command.upload.principalId,
        ),
        catch: (cause) => repositoryFailure("findStagedUpload", cause),
      });
      const upload = latest ?? command.upload;
      const total = upload.files.length;
      const installedCount = upload.files.filter((file) => file.installedAt !== null).length;

      if (upload.status !== uploadStatuses.open) {
        return yield* new UploadClosed({
          message: "The staged upload is already committed.",
        });
      }
      const now = yield* dependencies.clock.now;
      if (DateTime.isLessThanOrEqualTo(DateTime.makeUnsafe(upload.expiresAt), now)) {
        return yield* new UploadExpired({
          message: "The staged upload has expired.",
        });
      }
      if (upload.files.some((file) => file.uploadedAt === null)) {
        return yield* new UploadIncomplete({
          message: "Every declared upload file must be verified before commit.",
        });
      }

      if (upload.preparationState === preparationStates.prepared) {
        const currentInstalled = upload.files.filter(
          (file) => file.installedAt !== null,
        ).length;
        if (currentInstalled !== total) {
          return yield* new UploadIncomplete({
            message: "The staged upload is marked prepared but files are not installed.",
          });
        }
        yield* ensurePreparedManifestEntries(upload, upload.preparationAttempts);
        return {kind: "prepared" as const};
      }

      const uninstalled = upload.files.filter((file) => file.installedAt === null);
      if (uninstalled.length === 0) {
        // All files are installed but the upload is not marked prepared yet.
        // Claim and finalize in one pass.
        const claimResult = yield* claim(upload);
        const entriesComplete = yield* ensurePreparedManifestEntries(
          upload,
          claimResult.attempts,
        );
        if (!entriesComplete) {
          yield* release(upload.id, claimResult.attempts);
          return {kind: "preparing", installed: total, total};
        }
        yield* markPrepared(upload, claimResult.attempts);
        return {kind: "prepared" as const};
      }

      const claimResult = yield* claim(upload);
      const filesToInstall = uninstalled.slice(0, dependencies.config.filesPerPass);
      yield* installBatch(upload, claimResult.attempts, filesToInstall, claimResult.leaseExpiresAt);
      yield* refreshUploadExpiry(upload, claimResult.attempts);
      const entriesComplete = yield* ensurePreparedManifestEntries(
        upload,
        claimResult.attempts,
      );

      const remainingUninstalled = total - (installedCount + filesToInstall.length);
      if (!entriesComplete || remainingUninstalled > 0) {
        yield* release(upload.id, claimResult.attempts);
        return {kind: "preparing", installed: total - remainingUninstalled, total};
      }

      yield* markPrepared(upload, claimResult.attempts);
      return {kind: "prepared" as const};
    },
  );

  return PublicationPreparationService.of({prepareUpload});
}

function stagedFileSource(
  upload: StagedUpload,
  file: StagedUploadFile,
  staging: PublicationPreparationStaging,
): PublicationFileSource {
  return {
    installed: file.installedAt !== null,
    open: Effect.fn("PublicationPreparationService.openStagedFile")(
      function*(): Effect.fn.Return<ReadableStream<Uint8Array>, StagingStorageFailure> {
        const opened = yield* staging.open(upload.id, file.storageToken);
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

function repositoryFailure(
  operation: ArtifactRepositoryFailure["operation"],
  cause: unknown,
): ArtifactRepositoryFailure {
  return new ArtifactRepositoryFailure({cause, operation});
}
