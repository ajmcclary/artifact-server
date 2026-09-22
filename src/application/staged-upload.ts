import { Context, DateTime, Effect, Layer } from "effect";

import {
  type ArtifactRepositoryFailure,
  type AuthorizationDenied,
  IdempotencyConflict,
  StagingStorageFailure,
  type ProjectArchived,
  UploadClosed,
  UploadExpired,
  type UploadFileNotFound,
  UploadIncomplete,
  UploadNotFound,
  UploadedFileMismatch,
} from "../core/errors.js";
import type { Principal } from "../core/identity.js";
import {maximumBatchRequestBytes} from "../core/publishing-limits.js";
import {
  uploadStatuses,
  type AccessSetting,
  type CanonicalManifest,
  type PublishedVersion,
  type RoutingMode,
  type StagedUpload,
  type StagedUploadFile,
} from "../core/model.js";
import type {
  CreateStagedUpload,
  ExpiredStagedUpload,
  IdGenerator,
  OpenedStagedFile,
  StagedFileWrite,
  StagedUploadFileSlot,
  StoredBlob,
} from "../core/ports.js";
import type { DeclaredManifestFile } from "../manifest/create-manifest.js";
import {
  type PublicationFileSource,
  type PublishArtifactFailure,
  PublishArtifactService,
} from "./publish-artifact.js";
import type { ApplicationClock } from "./application-clock.js";
import {type ManifestFailure, parseManifest} from "./parse-manifest.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import {
  type ProjectManagementFailure,
  ProjectManagementService,
} from "./project-management.js";
import {parseIdempotencyKey} from "./idempotency-key.js";

const uploadLifetimeMilliseconds = 60 * 60 * 1_000;
const singleWriteDeadlineMilliseconds = 10 * 60 * 1_000;

/** Input for creating a principal-bound staged upload. */
export interface CreateStagedUploadCommand {
  readonly entryPath: string;
  readonly files: readonly DeclaredManifestFile[];
  readonly idempotencyKey?: string;
  readonly principal: Principal;
  readonly projectId?: string | null;
  readonly routingMode?: RoutingMode;
}

/** Result of creating or resuming one staged upload bound to an idempotency key. */
export type CreateStagedUploadResult =
  | {readonly kind: "committed"; readonly publication: PublishedVersion}
  | {readonly kind: "upload"; readonly resumed: boolean; readonly upload: StagedUpload};

/** Input for streaming one file into the staged upload slot its URL names. */
export interface UploadStagedFileCommand {
  readonly body: ReadableStream<Uint8Array>;
  readonly ownerId: string;
  readonly projectId: string;
  readonly storageToken: string;
  readonly uploadId: string;
}

/** Input for one batched staged upload frame over an existing staged upload. */
export interface UploadStagedBatchCommand {
  readonly body: ReadableStream<Uint8Array>;
  readonly ownerId: string;
  readonly projectId: string;
  readonly uploadId: string;
}

/** The accepted/rejected parts of one decoded batch frame. */
export interface StagedUploadBatchResult {
  readonly accepted: readonly {
    readonly path: string;
    readonly status: "verified";
  }[];
  readonly rejected: readonly {
    readonly code:
      | "duplicate_part"
      | "size_mismatch"
      | "truncated"
      | "unknown_part";
    readonly path: string | null;
  }[];
  readonly truncated: boolean;
}

/** Publication target selected when committing a staged upload. */
export type CommitStagedUploadTarget =
  | {
    readonly accessSetting: AccessSetting;
    readonly kind: "new_artifact";
    readonly name: string;
    readonly tags?: readonly string[];
  }
  | {
    readonly artifactId: string;
    readonly expectedCurrentVersionId: string;
    readonly kind: "new_version";
  };

/** Input for committing a complete staged upload. */
export interface CommitStagedUploadCommand {
  readonly idempotencyKey: string;
  readonly principal: Principal;
  readonly projectId?: string | null;
  readonly target: CommitStagedUploadTarget;
  readonly uploadId: string;
}

/** Repository capabilities required by the staged upload lifecycle. */
export interface StagedUploadRepositoryPort {
  createStagedUpload(
    command: CreateStagedUpload,
  ): Effect.Effect<StagedUpload, ArtifactRepositoryFailure | ProjectArchived>;
  findStagedUploadFileSlot(
    projectId: string,
    uploadId: string,
    principalId: string,
    storageToken: string,
  ): Effect.Effect<StagedUploadFileSlot | null, ArtifactRepositoryFailure>;
  findStagedUpload(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): Effect.Effect<StagedUpload | null, ArtifactRepositoryFailure>;
  findStagedUploadByIdempotencyKey(
    projectId: string,
    principalId: string,
    idempotencyKey: string,
  ): Effect.Effect<StagedUpload | null, ArtifactRepositoryFailure>;
  markStagedFileUploaded(
    projectId: string,
    uploadId: string,
    principalId: string,
    storageToken: string,
    uploadedAt: string,
  ): Effect.Effect<
    void,
    | UploadNotFound
    | UploadClosed
    | UploadFileNotFound
    | UploadExpired
    | ProjectArchived
    | ArtifactRepositoryFailure
  >;
  listExpiredStagedUploads(
    expiredBefore: string,
    limit: number,
  ): Effect.Effect<readonly ExpiredStagedUpload[], ArtifactRepositoryFailure>;
  removeExpiredStagedUpload(
    uploadId: string,
    expiredBefore: string,
  ): Effect.Effect<boolean, ArtifactRepositoryFailure>;
}

/** Staging storage capabilities required before immutable publication. */
export interface StagingStoragePort {
  open(
    uploadId: string,
    storageToken: string,
  ): Effect.Effect<OpenedStagedFile, StagingStorageFailure>;
  put(
    write: StagedFileWrite,
  ): Effect.Effect<StoredBlob, UploadedFileMismatch | StagingStorageFailure>;
  remove(
    uploadId: string,
    storageToken: string,
  ): Effect.Effect<void, StagingStorageFailure>;
}

/** Dependencies used to construct the staged upload application service. */
export interface StagedUploadDependencies {
  readonly clock: ApplicationClock;
  readonly ids: IdGenerator;
  readonly staging: StagingStoragePort;
  readonly uploads: StagedUploadRepositoryPort;
}

/** Expected failures produced by the staged upload application service. */
export type StagedUploadFailure =
  | ManifestFailure
  | UploadNotFound
  | UploadClosed
  | UploadExpired
  | UploadFileNotFound
  | UploadIncomplete
  | UploadedFileMismatch
  | ArtifactRepositoryFailure
  | StagingStorageFailure
  | PublishArtifactFailure
  | ProjectManagementFailure
  | AuthorizationDenied;

interface StagedUploadOperations {
  readonly commitUpload: (
    command: CommitStagedUploadCommand,
  ) => Effect.Effect<PublishedVersion, StagedUploadFailure>;
  readonly createUpload: (
    command: CreateStagedUploadCommand,
  ) => Effect.Effect<CreateStagedUploadResult, StagedUploadFailure>;
  readonly uploadBatch: (
    command: UploadStagedBatchCommand,
  ) => Effect.Effect<StagedUploadBatchResult, StagedUploadFailure>;
  readonly uploadFile: (
    command: UploadStagedFileCommand,
  ) => Effect.Effect<StagedUploadFile, StagedUploadFailure>;
}

/** Owns the principal-bound upload lifecycle before immutable publication. */
export class StagedUploadService extends Context.Service<
  StagedUploadService,
  StagedUploadOperations
>()("artifact-server/application/StagedUploadService") {
  /** Construct the service using the shared publication service and staged ports. */
  static readonly layer = (
    dependencies: StagedUploadDependencies,
  ): Layer.Layer<
    StagedUploadService,
    never,
    PublishArtifactService | AuthorizationService
      | ProjectManagementService
  > =>
    Layer.effect(
      StagedUploadService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        const publish = yield* PublishArtifactService;
        const projects = yield* ProjectManagementService;
        return makeStagedUploadService(
          dependencies,
          publish,
          authorization,
          projects,
        );
      }),
    );
}

function makeStagedUploadService(
  dependencies: StagedUploadDependencies,
  publish: PublishArtifactService["Service"],
  authorization: AuthorizationOperations,
  projects: ProjectManagementService["Service"],
): StagedUploadOperations {
  const requiredUpload = Effect.fn("StagedUploadService.requiredUpload")(
    function*(projectId: string, uploadId: string, principalId: string) {
      const upload = yield* dependencies.uploads.findStagedUpload(
        projectId,
        uploadId,
        principalId,
      );
      if (upload === null) {
        return yield* new UploadNotFound({
          message: "The staged upload does not exist.",
        });
      }
      return upload;
    },
  );

  const createFreshUpload = (
    projectId: string,
    manifest: CanonicalManifest,
    principalId: string,
  ): Effect.Effect<StagedUpload, StagedUploadFailure> =>
    createKeyBoundUpload(projectId, manifest, principalId, null);

  const createKeyBoundUpload = (
    projectId: string,
    manifest: CanonicalManifest,
    principalId: string,
    idempotencyKey: string | null,
  ): Effect.Effect<StagedUpload, StagedUploadFailure> =>
    Effect.gen(function*() {
      const {entries} = manifest;
      const created = yield* dependencies.clock.now;
      return yield* dependencies.uploads.createStagedUpload({
        createdAt: DateTime.formatIso(created),
        expiresAt: DateTime.formatIso(
          DateTime.addDuration(created, uploadLifetimeMilliseconds),
        ),
        files: entries.map((entry) => ({
          entry,
          storageToken: dependencies.ids.stagedFileToken(),
        })),
        id: dependencies.ids.uploadId(),
        idempotencyKey,
        manifest,
        principalId,
        projectId,
      });
    });

  const removeExpiredStagedUpload = (
    upload: StagedUpload,
  ): Effect.Effect<void, StagingStorageFailure | ArtifactRepositoryFailure> =>
    Effect.gen(function*() {
      yield* Effect.forEach(
        upload.files,
        (file) => dependencies.staging.remove(upload.id, file.storageToken),
        {concurrency: 1, discard: true},
      );
      yield* dependencies.uploads.removeExpiredStagedUpload(
        upload.id,
        upload.expiresAt,
      );
    });

  const createUpload = Effect.fn("StagedUploadService.createUpload")(
    function*(
    command: CreateStagedUploadCommand,
  ): Effect.fn.Return<CreateStagedUploadResult, StagedUploadFailure> {
      yield* authorization.requirePublicationPreparation(command.principal);
      const project = yield* projects.resolveActiveProject({
        principal: command.principal,
        projectId: command.projectId ?? null,
      });

      if (command.idempotencyKey === undefined) {
        const manifest = yield* parseManifest({
          entryPath: command.entryPath,
          files: command.files,
          routingMode: command.routingMode ?? "static",
        });
        const upload = yield* createFreshUpload(
          project.id,
          manifest,
          command.principal.id,
        );
        return {kind: "upload" as const, resumed: false, upload};
      }

      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const committed = yield* publish.findPublicationByIdempotencyKey(
        project.id,
        command.principal.id,
        idempotencyKey,
      );
      if (committed !== null) {
        return {kind: "committed" as const, publication: committed};
      }

      const manifest = yield* parseManifest({
        entryPath: command.entryPath,
        files: command.files,
        routingMode: command.routingMode ?? "static",
      });
      const existing = yield* dependencies.uploads.findStagedUploadByIdempotencyKey(
        project.id,
        command.principal.id,
        idempotencyKey,
      );
      if (existing !== null) {
        if (existing.status === uploadStatuses.committed) {
          return yield* new IdempotencyConflict({
            message: "The idempotency key is already bound to a committed upload.",
          });
        }
        const now = yield* dependencies.clock.now;
        if (DateTime.isLessThanOrEqualTo(DateTime.makeUnsafe(existing.expiresAt), now)) {
          yield* removeExpiredStagedUpload(existing);
          const upload = yield* createKeyBoundUpload(
            project.id,
            manifest,
            command.principal.id,
            idempotencyKey,
          );
          return {kind: "upload" as const, resumed: false, upload};
        }
        if (existing.manifest.digest !== manifest.digest) {
          return yield* new IdempotencyConflict({
            message: "The idempotency key is already bound to a different upload.",
          });
        }
        return {kind: "upload" as const, resumed: true, upload: existing};
      }

      const result = yield* createKeyBoundUpload(
        project.id,
        manifest,
        command.principal.id,
        idempotencyKey,
      ).pipe(
        Effect.catchTag("ArtifactRepositoryFailure", (error) =>
          Effect.gen(function*() {
            const raced = yield* dependencies.uploads
              .findStagedUploadByIdempotencyKey(
                project.id,
                command.principal.id,
                idempotencyKey,
              );
            if (raced === null) {
              return yield* Effect.fail(error);
            }
            if (raced.status === uploadStatuses.committed) {
              return yield* new IdempotencyConflict({
                message: "The idempotency key is already bound to a committed upload.",
              });
            }
            const now = yield* dependencies.clock.now;
            if (DateTime.isLessThanOrEqualTo(DateTime.makeUnsafe(raced.expiresAt), now)) {
              return yield* new IdempotencyConflict({
                message: "The idempotency key is already bound to an expired upload.",
              });
            }
            if (raced.manifest.digest !== manifest.digest) {
              return yield* new IdempotencyConflict({
                message: "The idempotency key is already bound to a different upload.",
              });
            }
            return {kind: "upload" as const, resumed: true, upload: raced};
          })),
      );
      if ("kind" in result) {
        return result;
      }
      return {kind: "upload" as const, resumed: false, upload: result};
    },
  );

  const uploadFile = Effect.fn("StagedUploadService.uploadFile")(
    function*(
    command: UploadStagedFileCommand,
  ): Effect.fn.Return<StagedUploadFile, StagedUploadFailure> {
      const slot = yield* dependencies.uploads.findStagedUploadFileSlot(
        command.projectId,
        command.uploadId,
        command.ownerId,
        command.storageToken,
      );
      if (slot === null || slot.file === null) {
        return yield* new UploadNotFound({
          message: "The staged upload does not exist.",
        });
      }
      const uploadStartedAt = yield* dependencies.clock.now;
      yield* ensureUploadAcceptsFiles(slot, uploadStartedAt);
      const file = slot.file;

      // An upload stays open for an hour, but one write must not hold a
      // connection that long.
      const writeDeadline = DateTime.formatIso(
        DateTime.addDuration(uploadStartedAt, singleWriteDeadlineMilliseconds),
      );
      const signal = abortSignalUntil(
        writeDeadline < slot.expiresAt ? writeDeadline : slot.expiresAt,
        uploadStartedAt,
      );
      yield* dependencies.staging.put({
        body: command.body,
        sha256: file.entry.sha256,
        signal,
        size: file.entry.size,
        storageToken: file.storageToken,
        uploadId: command.uploadId,
      }).pipe(Effect.catch((error) => Effect.fail(signal.aborted
        ? new UploadExpired({message: "The staged upload has expired."})
        : error)));
      const uploadedAt = DateTime.formatIso(yield* dependencies.clock.now);
      yield* dependencies.uploads.markStagedFileUploaded(
        command.projectId,
        command.uploadId,
        command.ownerId,
        file.storageToken,
        uploadedAt,
      );
      return {...file, uploadedAt};
    },
  );

  const uploadBatch = Effect.fn("StagedUploadService.uploadBatch")(
    function*(
    command: UploadStagedBatchCommand,
  ): Effect.fn.Return<StagedUploadBatchResult, StagedUploadFailure> {
      const upload = yield* dependencies.uploads.findStagedUpload(
        command.projectId,
        command.uploadId,
        command.ownerId,
      );
      if (upload === null) {
        return yield* new UploadNotFound({
          message: "The staged upload does not exist.",
        });
      }
      const batchStartedAt = yield* dependencies.clock.now;
      yield* ensureUploadAcceptsFiles(upload, batchStartedAt);
      const writeDeadline = DateTime.formatIso(
        DateTime.addDuration(batchStartedAt, singleWriteDeadlineMilliseconds),
      );
      const signal = abortSignalUntil(
        writeDeadline < upload.expiresAt ? writeDeadline : upload.expiresAt,
        batchStartedAt,
      );
      const frame = yield* Effect.tryPromise({
        try: () => readBatchFrame(command.body, maximumBatchRequestBytes),
        catch: () =>
          new UploadedFileMismatch({
            message: "The staged upload batch frame is malformed.",
          }),
      });
      const accepted: StagedUploadBatchResult["accepted"][number][] = [];
      const rejected: StagedUploadBatchResult["rejected"][number][] = [];
      const seenIndices = new Set<number>();
      // Guard deterministically first, then write the surviving parts with the
      // same bounded concurrency the per-file PUT fan-out already relies on.
      const writable: {part: typeof frame.parts[number]; slot: (typeof upload.files)[number]}[] = [];
      for (const part of frame.parts) {
        const slot: (typeof upload.files)[number] | null =
          part.orderIndex >= 0 && part.orderIndex < upload.files.length
            ? (upload.files[part.orderIndex] ?? null)
            : null;
        if (slot === null) {
          rejected.push({code: "unknown_part", path: null});
        } else if (seenIndices.has(part.orderIndex)) {
          rejected.push({code: "duplicate_part", path: slot.entry.path});
        } else if (part.declaredSize !== slot.entry.size) {
          rejected.push({code: "size_mismatch", path: slot.entry.path});
        } else {
          seenIndices.add(part.orderIndex);
          writable.push({part, slot});
        }
      }
      yield* Effect.forEach(
        writable,
        ({part, slot}) => Effect.gen(function*() {
          yield* dependencies.staging.put({
            body: part.body,
            sha256: slot.entry.sha256,
            signal,
            size: slot.entry.size,
            storageToken: slot.storageToken,
            uploadId: command.uploadId,
          }).pipe(Effect.catch((error) => Effect.fail(signal.aborted
            ? new UploadExpired({message: "The staged upload has expired."})
            : error)));
          const uploadedAt = DateTime.formatIso(yield* dependencies.clock.now);
          yield* dependencies.uploads.markStagedFileUploaded(
            command.projectId,
            command.uploadId,
            command.ownerId,
            slot.storageToken,
            uploadedAt,
          );
          accepted.push({path: slot.entry.path, status: "verified" as const});
        }),
        {concurrency: 4},
      );
      if (frame.truncated && rejected.length === 0 && frame.parts.length === 0) {
        rejected.push({code: "truncated", path: null});
      }
      return {accepted, rejected, truncated: frame.truncated};
    },
  );

  const publicationSource = (
    upload: StagedUpload,
    file: StagedUpload["files"][number],
    signal: AbortSignal | undefined,
  ): PublicationFileSource => {
    const source = {
      open: Effect.fn("StagedUploadService.openPublicationSource")(
      function*(): Effect.fn.Return<
        ReadableStream<Uint8Array>,
        StagingStorageFailure
      > {
        const opened = yield* dependencies.staging.open(
          upload.id,
          file.storageToken,
        );
        if (opened.size !== file.entry.size) {
          yield* Effect.tryPromise({
            try: () => opened.body.cancel(),
            catch: (cause) =>
              new StagingStorageFailure({cause, operation: "open"}),
          });
          return yield* new StagingStorageFailure({
            cause: new Error(
              "A verified staged file changed before publication.",
            ),
            operation: "open",
          });
        }
        return opened.body;
      },
      ),
      path: file.entry.path,
      sha256: file.entry.sha256,
      size: file.entry.size,
    };
    return signal === undefined ? source : {...source, signal};
  };

  const commitUpload = Effect.fn("StagedUploadService.commitUpload")(
    function*(
    command: CommitStagedUploadCommand,
  ): Effect.fn.Return<PublishedVersion, StagedUploadFailure> {
      yield* authorization.requirePublicationPreparation(command.principal);
      // An explicit project can be archived after a successful commit. Let the
      // repository replay that exact idempotent result; it still rejects every
      // genuinely new publication into the archived project.
      const project = command.projectId === undefined || command.projectId === null
        ? yield* projects.resolveActiveProject({
          principal: command.principal,
          projectId: null,
        })
        : yield* projects.getProject({
          principal: command.principal,
          projectId: command.projectId,
        });
      const upload = yield* requiredUpload(
        project.id,
        command.uploadId,
        command.principal.id,
      );
      const commitStartedAt = yield* dependencies.clock.now;
      const signal = upload.status === uploadStatuses.open
        ? abortSignalUntil(upload.expiresAt, commitStartedAt)
        : undefined;
      if (upload.status === uploadStatuses.open) {
        yield* ensureUploadNotExpired(upload, commitStartedAt);
      }
      if (upload.files.some((file) => file.uploadedAt === null)) {
        return yield* new UploadIncomplete({
          message: "Every declared upload file must be verified before commit.",
        });
      }
      const files = upload.files.map((file) =>
        publicationSource(upload, file, signal));
      const source = {
        kind: "staged_upload" as const,
        principalId: command.principal.id,
        projectId: project.id,
        uploadId: upload.id,
      };
      switch (command.target.kind) {
        case "new_artifact":
          return yield* expirePublicationAtDeadline(signal,
            publish.publishPreparedNew({
            accessSetting: command.target.accessSetting,
            files,
            idempotencyKey: command.idempotencyKey,
            manifest: upload.manifest,
            name: command.target.name,
            principal: command.principal,
            projectId: project.id,
            source,
            tags: command.target.tags ?? [],
            }));
        case "new_version":
          return yield* expirePublicationAtDeadline(signal,
            publish.publishPreparedVersion({
            artifactId: command.target.artifactId,
            expectedCurrentVersionId: command.target.expectedCurrentVersionId,
            files,
            idempotencyKey: command.idempotencyKey,
            manifest: upload.manifest,
            principal: command.principal,
            projectId: project.id,
            source,
            }));
      }
      return yield* Effect.die(
        new Error(
          `Unreachable staged upload target: ${String(command.target)}`,
        ),
      );
    },
  );

  return StagedUploadService.of({commitUpload, createUpload, uploadBatch, uploadFile});
}

function abortSignalUntil(expiresAt: string, now: DateTime.Utc): AbortSignal {
  const remainingMilliseconds = Math.max(
    1,
    Date.parse(expiresAt) - DateTime.toEpochMillis(now),
  );
  return AbortSignal.timeout(remainingMilliseconds);
}

function expirePublicationAtDeadline<A, E>(
  signal: AbortSignal | undefined,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E | UploadExpired> {
  return effect.pipe(Effect.catch((error) => Effect.fail(
    signal?.aborted === true
      ? new UploadExpired({message: "The staged upload has expired."})
      : error,
  )));
}

function ensureUploadAcceptsFiles(
  upload: Pick<StagedUpload, "expiresAt" | "status">,
  now: DateTime.Utc,
): Effect.Effect<void, UploadClosed | UploadExpired> {
  if (upload.status !== uploadStatuses.open) {
    return new UploadClosed({
      message: "The staged upload is already committed.",
    });
  }
  return ensureUploadNotExpired(upload, now);
}

function ensureUploadNotExpired(
  upload: Pick<StagedUpload, "expiresAt">,
  now: DateTime.Utc,
): Effect.Effect<void, UploadExpired> {
  const expiresAt = DateTime.makeUnsafe(upload.expiresAt);
  return DateTime.isLessThanOrEqualTo(expiresAt, now)
    ? new UploadExpired({message: "The staged upload has expired."})
    : Effect.void;
}

interface BatchFramePart {
  readonly body: ReadableStream<Uint8Array>;
  readonly declaredSize: number;
  readonly orderIndex: number;
}

interface BatchFrame {
  readonly parts: readonly BatchFramePart[];
  readonly truncated: boolean;
}

async function readBatchFrame(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<BatchFrame> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  let total = 0;
  const parts: BatchFramePart[] = [];
  const header = new Uint8Array(12);

  const consume = async (bytes: Uint8Array): Promise<void> => {
    total += bytes.byteLength;
    if (total > maximumBytes) throw new Error("The staged upload batch is too large.");
    const merged = new Uint8Array(buffer.byteLength + bytes.byteLength);
    merged.set(buffer, 0);
    merged.set(bytes, buffer.byteLength);
    buffer = merged;
  };

  const take = async (count: number): Promise<Uint8Array | null> => {
    while (buffer.byteLength < count) {
      // eslint-disable-next-line no-await-in-loop -- read until this slice is complete
      const {done, value} = await reader.read();
      if (done) return null;
      // eslint-disable-next-line no-await-in-loop -- read until this slice is complete
      if (value !== undefined) await consume(value);
    }
    const slice = buffer.subarray(0, count);
    buffer = buffer.subarray(count);
    return slice;
  };

  while (true) {
    // eslint-disable-next-line no-await-in-loop -- one part at a time
    const headerBytes = await take(12);
    if (headerBytes === null) {
      // Clean end of stream: no more complete parts.
      return {parts, truncated: false};
    }
    header.set(headerBytes, 0);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const orderIndex = view.getUint32(0, true);
    const declaredSize = view.getFloat64(4, true);
    if (
      !Number.isInteger(orderIndex) || orderIndex < 0 ||
      !Number.isSafeInteger(declaredSize) || declaredSize < 0
    ) {
      throw new Error("The staged upload batch part header is malformed.");
    }
    const size = declaredSize;
    let remaining = size;
    const chunks: Uint8Array[] = [];
    let complete = true;
    while (remaining > 0) {
      // eslint-disable-next-line no-await-in-loop -- read until this part's declared size
      const chunk = await take(Math.min(remaining, 64 * 1024));
      if (chunk === null) {
        complete = false;
        break;
      }
      chunks.push(chunk);
      remaining -= chunk.byteLength;
    }
    if (!complete) {
      return {parts, truncated: true};
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    parts.push({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      declaredSize: size,
      orderIndex,
    });
  }
}
