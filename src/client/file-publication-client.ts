import {createHash} from "node:crypto";
import {
  constants as fileSystemConstants,
  lstat,
  open,
  readdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";

import {
  Clock,
  Context,
  Duration,
  Effect,
  Option,
  Predicate,
  Schedule,
  Schema,
  type Redacted,
} from "effect";
import type * as FileSystem from "effect/FileSystem";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import {
  EmptyManifest,
  errorCodes,
  InvalidManifestFile,
  InvalidManifestPath,
  MissingManifestEntry,
} from "../core/errors.js";
import {
  createManifest,
  parseManifestPath,
} from "../manifest/create-manifest.js";
import {
  maximumBatchParts,
  maximumBatchRequestBytes,
} from "../core/publishing-limits.js";
import {redactFailureMessage} from "../observability/failure-cause-summary.js";

import {
  claudeDesignManifestPath,
  claudeDesignPublication,
  designCardPublication,
} from "../manifest/claude-design.js";
import {parseDesignCard, type DesignCard} from "../manifest/design-card.js";
import {
  createPreviewIndex,
  isReservedPreviewPath,
  maximumThumbnailBytes,
  parsePreviewSource,
  previewIndexPath,
  previewSourcePath,
  previewThumbnailCopyPath,
  serializePreviewIndex,
  sniffPreviewImage,
  type PreviewDraft,
  type PreviewImage,
} from "../manifest/preview-index.js";

const maximumFileCount = 10_000;
const maximumManifestPathLength = 1_024;
const defaultDirectoryEntryPath = "index.html";
const maximumDesignMetadataBytes = 4 * 1024 * 1024;
const uploadConcurrency = 4;

const mediaTypesByExtension = new Map<string, string>([
  [".aac", "audio/aac"],
  [".avif", "image/avif"],
  [".avi", "video/x-msvideo"],
  [".bin", "application/octet-stream"],
  [".bmp", "image/bmp"],
  [".css", "text/css; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".gif", "image/gif"],
  [".gz", "application/gzip"],
  [".htm", "text/html; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".m4a", "audio/mp4"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".ogv", "video/ogg"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tar", "application/x-tar"],
  [".text", "text/plain; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".xml", "application/xml; charset=utf-8"],
  [".zip", "application/zip"],
]);

const positiveIntegerSchema = Schema.Int.check(Schema.isGreaterThan(0));
const nonnegativeIntegerSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const artifactSchema = Schema.Struct({
  accessSetting: Schema.Literals(["account_required", "public_link"]),
  createdAt: Schema.String,
  currentVersionId: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
  id: Schema.String,
  name: Schema.String,
  projectId: Schema.String,
  tags: Schema.Array(Schema.String),
});
const versionSchema = Schema.Struct({
  artifactId: Schema.String,
  contentToken: Schema.String,
  createdAt: Schema.String,
  entryPath: Schema.String,
  id: Schema.String,
  manifestDigest: Schema.String,
  number: positiveIntegerSchema,
  publisherPrincipalId: Schema.String,
  projectId: Schema.String,
  routingMode: Schema.Literals(["static", "spa"]),
});
const publishResponseSchema = Schema.Struct({
  artifact: artifactSchema,
  links: Schema.Struct({
    artifact: Schema.URLFromString,
    review: Schema.URLFromString,
    version: Schema.URLFromString,
  }),
  replayed: Schema.Boolean,
  version: versionSchema,
});
const committedUploadResponseSchema = Schema.Struct({
  artifact: artifactSchema,
  links: Schema.Struct({
    artifact: Schema.URLFromString,
    review: Schema.URLFromString,
    version: Schema.URLFromString,
  }),
  replayed: Schema.Boolean,
  status: Schema.Literal("committed"),
  version: versionSchema,
});
const preparingUploadResponseSchema = Schema.Struct({
  installed: nonnegativeIntegerSchema,
  status: Schema.Literal("preparing"),
  total: nonnegativeIntegerSchema,
});
const stagedUploadResponseSchema = Schema.Struct({
  commitUrl: Schema.URLFromString,
  expiresAt: Schema.String,
  files: Schema.Array(Schema.Struct({
    method: Schema.Literal("PUT"),
    path: Schema.String,
    size: nonnegativeIntegerSchema,
    uploadUrl: Schema.URLFromString,
    verified: Schema.Boolean,
  })),
  manifestDigest: Schema.String,
  projectId: Schema.String,
  status: Schema.Literals(["created", "resumed"]),
  uploadId: Schema.String,
});
const createUploadResponseSchema = Schema.Union([
  committedUploadResponseSchema,
  stagedUploadResponseSchema,
]);
const serverErrorSchema = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
});
const uploadedFileResponseSchema = Schema.Struct({
  path: Schema.String,
  status: Schema.Literal("verified"),
  uploadId: Schema.String,
});
const batchUploadResponseSchema = Schema.Struct({
  accepted: Schema.Array(Schema.Struct({
    path: Schema.String,
    status: Schema.Literal("verified"),
  })),
  rejected: Schema.Array(Schema.Struct({
    code: Schema.String,
    path: Schema.Union([Schema.String, Schema.Null]),
  })),
  truncated: Schema.Boolean,
  uploadId: Schema.String,
});

const decodeServerError = Schema.decodeUnknownOption(serverErrorSchema);

/** A filesystem input cannot be turned into a safe artifact publication. */
export class FilePublicationInputError extends Schema.TaggedError<FilePublicationInputError>()(
  "FilePublicationInputError",
  {
    inputPath: Schema.String,
    message: Schema.String,
    reason: Schema.Literals([
      "empty_directory",
      "input_changed",
      "invalid_entry",
      "invalid_path",
      "read_failed",
      "symbolic_link",
      "too_many_files",
      "unsupported_file_type",
    ]),
  },
) {}

/** The configured server or one of its upload-plan URLs is unsafe. */
export class FilePublicationConfigurationError extends Schema.TaggedError<FilePublicationConfigurationError>()(
  "FilePublicationConfigurationError",
  {
    message: Schema.String,
    reason: Schema.Literals(["invalid_server", "unsafe_upload_plan"]),
  },
) {}

/** The server could not complete or validate one file publication operation. */
export class FilePublicationProtocolError extends Schema.TaggedError<FilePublicationProtocolError>()(
  "FilePublicationProtocolError",
  {
    message: Schema.String,
    operation: Schema.Literals([
      "commit_upload",
      "create_upload",
      "upload_batch",
      "upload_file",
    ]),
    serverCode: Schema.NullOr(Schema.String),
    status: Schema.NullOr(Schema.Int),
    /** The transport error code when the exchange broke before an answer arrived. */
    transportCode: Schema.NullOr(Schema.String),
  },
) {}

/** Bounded retry of one idempotent staged transfer: a file PUT or a batch POST. */
export interface StagedTransferRetryPolicy {
  readonly initialDelayMilliseconds: number;
  readonly maximumAttempts: number;
  readonly maximumDelayMilliseconds: number;
}

/**
 * The staged transfer retry policy: four attempts with jittered exponential
 * backoff from one second, never sleeping past thirty seconds. A transfer is
 * safe to repeat because its URL names one slot and the server verifies the
 * bytes by size and SHA-256 before marking it.
 */
export const StagedTransferRetry = Context.Reference<StagedTransferRetryPolicy>(
  "artifact-server/client/StagedTransferRetry",
  {
    defaultValue: () => ({
      initialDelayMilliseconds: 1_000,
      maximumAttempts: 4,
      maximumDelayMilliseconds: 30_000,
    }),
  },
);

/** Expected failures from the file-first publication client. */
export type FilePublicationFailure =
  | FilePublicationInputError
  | FilePublicationConfigurationError
  | FilePublicationProtocolError;

/** Result returned after a staged upload commits an immutable version. */
export type FilePublicationResult = typeof publishResponseSchema.Type;

/** Target selected by a file-first publication caller. */
export type FilePublicationTarget =
  | {
    readonly accessSetting: "account_required" | "public_link";
    readonly kind: "new_artifact";
    readonly name?: string;
    readonly tags: readonly string[];
  }
  | {
    readonly artifactId: string;
    readonly expectedCurrentVersionId: string;
    readonly kind: "new_version";
  };

/** One user-facing file or directory publication request. */
export interface FilePublicationCommand {
  readonly entryPath?: string;
  readonly idempotencyKey: string;
  readonly inputPath: string;
  readonly projectId?: string;
  readonly routingMode?: "spa" | "static";
  readonly target: FilePublicationTarget;
}

/** A publication request before its durable operation identity is assigned. */
export type FilePublicationIntent = Omit<FilePublicationCommand, "idempotencyKey">;

/** Connection values for one Artifact Server installation. */
export interface FilePublicationClientConfig {
  readonly apiToken: Redacted.Redacted;
  readonly serverOrigin: string;
  readonly transport?: "per-file" | "batch";
}

interface DiskPreparedFile {
  readonly kind: "disk";
  readonly absolutePath: string;
  readonly device: number;
  readonly inode: number;
  readonly mediaType: string;
  readonly modifiedAtMilliseconds: number;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

interface GeneratedPreparedFile {
  readonly kind: "generated";
  /** Held in memory so a retry within this process sends exactly the hashed bytes. */
  readonly content: Uint8Array;
  readonly mediaType: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

type PreparedFile = DiskPreparedFile | GeneratedPreparedFile;

interface PreparedPublication {
  readonly defaultName: string;
  readonly entryPath: string;
  readonly files: readonly PreparedFile[];
  readonly routingMode: "spa" | "static";
}

/**
 * One validated local publication snapshot. Callers can persist the digest as
 * the identity of a retry without retaining local paths or file bytes.
 */
export interface PreparedFilePublication {
  readonly operationDigest: string;
  readonly operationScopeDigest: string;
  readonly publication: PreparedPublication;
  readonly projectId?: string;
  readonly target: CommitPublicationTarget;
}

interface CreateUploadRequestBody {
  readonly entryPath: string;
  readonly files: readonly {
    readonly mediaType: string;
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  }[];
  readonly projectId?: string;
  readonly routingMode: "spa" | "static";
}

type CommitPublicationTarget =
  | {
    readonly accessSetting: "account_required" | "public_link";
    readonly kind: "new_artifact";
    readonly name: string;
    readonly tags: readonly string[];
  }
  | {
    readonly artifactId: string;
    readonly expectedCurrentVersionId: string;
    readonly kind: "new_version";
  };

interface CommitUploadRequestBody {
  readonly target: CommitPublicationTarget;
}

type FilePublicationRequestBody =
  | CreateUploadRequestBody
  | CommitUploadRequestBody;

type FilePublicationOperation = FilePublicationProtocolError["operation"];

/** What one HTTP exchange was doing, for a failure message a person can act on. */
interface TransferSubject {
  /** A present-participle phrase, such as "Uploading index.html". */
  readonly action: string;
  readonly operation: FilePublicationOperation;
}

/** The stable code and redacted message of one broken HTTP exchange. */
interface TransportCause {
  readonly code: string | null;
  readonly message: string;
}

/** Answers that mean "try the same transfer again", never "your input is wrong". */
const transientTransferStatuses: ReadonlySet<number> = new Set([408, 429, 502, 503, 504]);

/** Transport codes for a connection that was never established. */
const unreachableTransportCodes: ReadonlySet<string> = new Set([
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const transportCodeDescriptions: ReadonlyMap<string, string> = new Map([
  ["ECONNABORTED", "the connection was aborted"],
  ["ECONNRESET", "the connection was reset"],
  ["EPIPE", "the connection closed while the request was still being sent"],
  ["ETIMEDOUT", "the connection timed out"],
  ["UND_ERR_BODY_TIMEOUT", "the server's answer stalled"],
  ["UND_ERR_CLOSED", "the connection closed unexpectedly"],
  ["UND_ERR_HEADERS_TIMEOUT", "the server did not answer in time"],
  ["UND_ERR_SOCKET", "the connection closed unexpectedly"],
]);
/**
 * Transport codes worth another attempt: a connection that broke or never
 * opened. A failure without one of these codes, such as a refused redirect
 * or a certificate error, is never repeated.
 */
const transientTransportCodes: ReadonlySet<string> = new Set([
  ...unreachableTransportCodes,
  ...transportCodeDescriptions.keys(),
]);
const transportCodePattern = /^[A-Z][A-Z0-9_]{1,63}$/u;
const maximumTransportCauseDepth = 5;

/**
 * Publish one local file or finished directory through a server-issued upload
 * plan. The server receives bytes and portable manifest paths, never the local
 * filesystem path. Publication uses Fetch with redirects refused; a caller may
 * provide FetchHttpClient.RequestInit for transport settings, except redirect mode.
 */
export const publishPath = Effect.fn("FilePublicationClient.publishPath")(
  function*(
    config: FilePublicationClientConfig,
    command: FilePublicationCommand,
  ): Effect.fn.Return<
    FilePublicationResult,
    FilePublicationFailure,
    FileSystem.FileSystem
  > {
    const prepared = yield* prepareFilePublication(command);
    return yield* publishPreparedPath(
      config,
      command.idempotencyKey,
      prepared,
    );
  },
);

/** Inspect, hash, and canonicalize a local file publication before mutation. */
export const prepareFilePublication = Effect.fn(
  "FilePublicationClient.prepareFilePublication",
)(function*(
  command: FilePublicationIntent,
): Effect.fn.Return<PreparedFilePublication, FilePublicationInputError> {
  const publication = yield* preparePublication(command);
  const target = effectiveCommitTarget(command.target, publication.defaultName);
  const operationScopeDigest = createHash("sha256").update(JSON.stringify({
    entryPath: publication.entryPath,
    inputPath: path.resolve(command.inputPath),
    projectId: command.projectId ?? null,
    routingMode: publication.routingMode,
    target,
  })).digest("hex");
  const operationDigest = createHash("sha256").update(JSON.stringify({
    entryPath: publication.entryPath,
    files: publication.files.map((file) => ({
      mediaType: file.mediaType,
      path: file.path,
      sha256: file.sha256,
      size: file.size,
    })),
    projectId: command.projectId ?? null,
    routingMode: publication.routingMode,
    target,
  })).digest("hex");
  return command.projectId === undefined
    ? {operationDigest, operationScopeDigest, publication, target}
    : {
      operationDigest,
      operationScopeDigest,
      projectId: command.projectId,
      publication,
      target,
    };
});

/** Execute every publication request through the redirect-refusing Fetch boundary. */
export const publishPreparedPath = Effect.fn("FilePublicationClient.publishPreparedPath")(
  function*(
    config: FilePublicationClientConfig,
    idempotencyKey: string,
    prepared: PreparedFilePublication,
  ): Effect.fn.Return<FilePublicationResult, FilePublicationFailure, FileSystem.FileSystem> {
    const suppliedInit = Option.getOrElse(
      yield* Effect.serviceOption(FetchHttpClient.RequestInit),
      (): RequestInit => ({}),
    );
    return yield* publishPreparedWithClient(config, idempotencyKey, prepared).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, {
        ...suppliedInit,
        redirect: "error",
      }),
    );
  },
);

/** Publish one previously validated local snapshot with a durable operation key. */
const publishPreparedWithClient = Effect.fn(
  "FilePublicationClient.publishPreparedWithClient",
)(function*(
  config: FilePublicationClientConfig,
  idempotencyKey: string,
  prepared: PreparedFilePublication,
): Effect.fn.Return<
  FilePublicationResult,
  FilePublicationFailure,
  FileSystem.FileSystem | HttpClient.HttpClient
> {
    const serverOrigin = yield* parseServerOrigin(config.serverOrigin);
    const publication = prepared.publication;
    const response = yield* createUpload(
      serverOrigin,
      config.apiToken,
      publication,
      prepared.projectId,
      idempotencyKey,
    );
    if (response.status === "committed") {
      return {
        artifact: response.artifact,
        links: response.links,
        replayed: response.replayed,
        version: response.version,
      };
    }
    yield* validateUploadPlan(serverOrigin, publication, response);
    const unverified = response.files.filter((plannedFile) => !plannedFile.verified);
    if ((config.transport ?? "per-file") === "batch" && unverified.length > 1) {
      yield* uploadPreparedBatch(
        serverOrigin,
        response.uploadId,
        unverified,
        publication.files,
        response,
        config,
      );
    } else {
      yield* Effect.forEach(
        unverified,
        (plannedFile) => uploadPreparedFile(
          plannedFile,
          requiredPreparedFile(publication.files, plannedFile.path),
          response.uploadId,
        ),
        {concurrency: uploadConcurrency, discard: true},
      );
    }
    return yield* commitUpload(
      config.apiToken,
      idempotencyKey,
      prepared.target,
      response.commitUrl,
    );
});

function effectiveCommitTarget(
  target: FilePublicationTarget,
  defaultName: string,
): CommitPublicationTarget {
  return target.kind === "new_artifact"
    ? {
      accessSetting: target.accessSetting,
      kind: target.kind,
      name: target.name ?? defaultName,
      tags: target.tags,
    }
    : target;
}

/** Infer a deterministic browser media type from one file name. */
export function mediaTypeForPath(filePath: string): string {
  return mediaTypesByExtension.get(path.extname(filePath).toLowerCase())
    ?? "application/octet-stream";
}

const preparePublication = Effect.fn("FilePublicationClient.preparePublication")(
  function*(
    command: FilePublicationIntent,
  ): Effect.fn.Return<PreparedPublication, FilePublicationInputError> {
    const absoluteInputPath = path.resolve(command.inputPath);
    const prepared = yield* Effect.tryPromise({
      try: () => inspectPublicationPath(
        absoluteInputPath,
        command.entryPath,
        command.routingMode ?? "static",
      ),
      catch: (cause) => inputFailureFrom(cause, absoluteInputPath),
    });
    return prepared;
  },
);

async function inspectPublicationPath(
  absoluteInputPath: string,
  requestedEntryPath: string | undefined,
  routingMode: "spa" | "static",
): Promise<PreparedPublication> {
  const rootInfo = await lstat(absoluteInputPath);
  if (rootInfo.isSymbolicLink()) {
    throw inputFailure(
      absoluteInputPath,
      "symbolic_link",
      "The publication input cannot be a symbolic link.",
    );
  }
  if (rootInfo.isFile()) {
    const relativePath = path.basename(absoluteInputPath);
    if (
      requestedEntryPath !== undefined
      && requestedEntryPath !== relativePath
    ) {
      throw inputFailure(
        absoluteInputPath,
        "invalid_entry",
        `A single-file artifact opens ${JSON.stringify(relativePath)}; --entry is only needed for a directory.`,
      );
    }
    const file = await inspectRegularFile(absoluteInputPath, relativePath);
    return canonicalPreparedPublication(
      path.basename(absoluteInputPath),
      relativePath,
      [file],
      absoluteInputPath,
      routingMode,
    );
  }
  if (!rootInfo.isDirectory()) {
    throw inputFailure(
      absoluteInputPath,
      "unsupported_file_type",
      "The publication input must be one regular file or directory.",
    );
  }

  const files: PreparedFile[] = [];
  await inspectDirectory(absoluteInputPath, "", files);
  if (files.length === 0) {
    throw inputFailure(
      absoluteInputPath,
      "empty_directory",
      "The publication directory does not contain any files.",
    );
  }
  const entryPath = requestedEntryPath
    ?? await inferDirectoryEntry(files, absoluteInputPath);
  return canonicalPreparedPublication(
    path.basename(absoluteInputPath),
    entryPath,
    files,
    absoluteInputPath,
    routingMode,
  );
}

async function inferDirectoryEntry(files: PreparedFile[], inputPath: string): Promise<string> {
  const paths = files.map((file) => file.path);
  if (paths.includes(defaultDirectoryEntryPath)) return defaultDirectoryEntryPath;
  try {
    const design = await prepareDesignGallery(files, paths, path.basename(inputPath));
    if (design === undefined) return defaultDirectoryEntryPath;
    if (paths.some(isReservedPreviewPath)) {
      throw new Error("The generated preview asset directory already exists; choose --entry explicitly.");
    }
    if (files.length + design.generated.length > maximumFileCount) {
      throw new Error("The design preview index would exceed the publication file limit.");
    }
    files.push(...design.generated);
    return design.entryPath;
  } catch (cause) {
    throw inputFailure(inputPath, "invalid_entry", cause instanceof Error
      ? `Cannot prepare design export: ${cause.message}`
      : "Cannot prepare Claude Design export.");
  }
}

interface PreparedDesignGallery {
  /** The first preview, which opens when the version is viewed outside Review's gallery. */
  readonly entryPath: string;
  /** The preview index and typed thumbnail copies, in deterministic order. */
  readonly generated: readonly GeneratedPreparedFile[];
}

/**
 * A producer preview source outranks automatic detection; otherwise the existing
 * vendor-manifest, card and artboard precedence applies unchanged.
 */
async function prepareDesignGallery(
  files: readonly PreparedFile[],
  paths: readonly string[],
  title: string,
): Promise<PreparedDesignGallery | undefined> {
  const source = files.find((file) => file.path === previewSourcePath);
  if (source?.kind === "disk") {
    const draft = parsePreviewSource(await readDesignMetadata(source), paths);
    return indexedGallery(files, draft, true);
  }
  const manifestPath = claudeDesignManifestPath(paths);
  const manifest = files.find((file) => file.path === manifestPath);
  const manifestText = manifest?.kind === "disk"
    ? await readDesignMetadata(manifest)
    : undefined;
  const cards = manifestPath === undefined ? await readDesignCards(files) : [];
  const design: PreviewDraft | undefined = cards.length > 0
    ? designCardPublication(paths, cards, title)
    : claudeDesignPublication(paths, manifestPath, manifestText, title);
  if (design === undefined) return undefined;
  const cover = conventionalCover(files);
  return indexedGallery(files, cover === undefined ? design : {...design, cover}, false);
}

/** Claude exports place an optional project cover at `.thumbnail`; it is used only when valid. */
function conventionalCover(files: readonly PreparedFile[]): string | undefined {
  return files.find((file) => file.kind === "disk"
    && (file.path === ".thumbnail" || file.path === "project/.thumbnail")
    && file.size <= maximumThumbnailBytes)?.path;
}

async function indexedGallery(
  files: readonly PreparedFile[],
  draft: PreviewDraft,
  declared: boolean,
): Promise<PreparedDesignGallery> {
  const references = [...new Set([draft.cover, ...draft.items.map((item) => item.thumbnail)]
    .filter((reference): reference is string => reference !== undefined))];
  const lookups = await Promise.all(references.map(async (reference) => {
    const image = await resolvePreviewImage(files, reference);
    if (image === undefined && declared) {
      throw new Error(`Preview thumbnail ${JSON.stringify(reference)} must be a PNG, JPEG or WebP image of at most 2 MiB.`);
    }
    return [reference, image] as const;
  }));
  const images = new Map(lookups.flatMap(([reference, image]) => image === undefined ? [] : [[reference, image] as const]));
  // An undeclared conventional cover that is not a supported image is simply omitted.
  const {cover, ...uncovered} = draft;
  const usable: PreviewDraft = cover !== undefined && images.has(cover) ? draft : uncovered;
  const index = createPreviewIndex(usable, (reference) => {
    const resolved = images.get(reference);
    if (resolved === undefined) throw new Error("A preview thumbnail was not resolved.");
    return resolved.image;
  });
  const copies = new Map<string, GeneratedPreparedFile>();
  for (const {copy} of images.values()) if (copy !== undefined) copies.set(copy.path, copy);
  const [first] = index.items;
  if (first === undefined) throw new Error("A preview index must contain at least one preview.");
  return {
    entryPath: first.path,
    generated: [
      generatedFile(previewIndexPath, serializePreviewIndex(index), "application/json; charset=utf-8"),
      ...[...copies.values()].toSorted((left, right) => left.path < right.path ? -1 : Number(left.path > right.path)),
    ],
  };
}

/**
 * Identify a thumbnail by its bytes. A file whose name already gives the same image
 * type is referenced in place; an extensionless supplied image gets a typed,
 * content-addressed copy. A name that claims another type is refused.
 */
async function resolvePreviewImage(
  files: readonly PreparedFile[],
  reference: string,
): Promise<{readonly image: PreviewImage; readonly copy?: GeneratedPreparedFile} | undefined> {
  const file = files.find((candidate) => candidate.path === reference);
  if (file?.kind !== "disk" || file.size > maximumThumbnailBytes) return undefined;
  const bytes = await readVerifiedBytes(file);
  const mediaType = sniffPreviewImage(bytes);
  if (mediaType === undefined) return undefined;
  const declaredType = file.mediaType.split(";", 1)[0]?.trim().toLowerCase();
  if (declaredType === mediaType) return {image: {path: file.path, mediaType}};
  if (declaredType !== "application/octet-stream") return undefined;
  const copy: GeneratedPreparedFile = {
    kind: "generated",
    content: bytes,
    mediaType,
    path: previewThumbnailCopyPath(file.sha256, mediaType),
    sha256: file.sha256,
    size: bytes.byteLength,
  };
  return {image: {path: copy.path, mediaType}, copy};
}

function generatedFile(filePath: string, text: string, mediaType: string): GeneratedPreparedFile {
  const content = new TextEncoder().encode(text);
  return {
    kind: "generated",
    content,
    mediaType,
    path: filePath,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: content.byteLength,
  };
}

async function readDesignCards(files: readonly PreparedFile[]): Promise<DesignCard[]> {
  return files.reduce<Promise<DesignCard[]>>(async (pending, file) => {
    const cards = await pending;
    if (file.kind === "disk" && file.path.endsWith(".card.html")) {
      cards.push(parseDesignCard(file.path, await readDesignMetadata(file)));
    }
    return cards;
  }, Promise.resolve([]));
}

async function readDesignMetadata(file: DiskPreparedFile): Promise<string> {
  if (file.size > maximumDesignMetadataBytes) {
    throw new Error("Design metadata files and card previews must not exceed 4 MiB.");
  }
  return Buffer.from(await readVerifiedBytes(file)).toString("utf8");
}

/** Read a small prepared file and prove it still has the fingerprinted bytes. */
async function readVerifiedBytes(file: DiskPreparedFile): Promise<Uint8Array> {
  const handle = await open(file.absolutePath, fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(file.size + 1);
    let length = 0;
    const stream = handle.createReadStream({autoClose: false, start: 0, end: file.size});
    for await (const chunk of stream) {
      bytes.set(chunk, length);
      length += chunk.length;
    }
    const content = bytes.subarray(0, length);
    if (length !== file.size || createHash("sha256").update(content).digest("hex") !== file.sha256) {
      throw new Error("Design metadata changed during publication preparation.");
    }
    return new Uint8Array(content);
  } finally {
    await handle.close();
  }
}

async function inspectDirectory(
  absoluteDirectoryPath: string,
  relativeDirectoryPath: string,
  files: PreparedFile[],
): Promise<void> {
  const names = (await readdir(absoluteDirectoryPath)).toSorted();
  await names.reduce<Promise<void>>(
    (previous, name) => previous.then(() => inspectDirectoryEntry(
      absoluteDirectoryPath,
      relativeDirectoryPath,
      name,
      files,
    )),
    Promise.resolve(),
  );
}

async function inspectDirectoryEntry(
  absoluteDirectoryPath: string,
  relativeDirectoryPath: string,
  name: string,
  files: PreparedFile[],
): Promise<void> {
  const absoluteChildPath = path.join(absoluteDirectoryPath, name);
  const relativeChildPath = relativeDirectoryPath.length === 0
    ? name
    : path.posix.join(relativeDirectoryPath, name);
  assertPortableClientPath(relativeChildPath, absoluteChildPath);
  const info = await lstat(absoluteChildPath);
  if (info.isSymbolicLink()) {
    throw inputFailure(
      absoluteChildPath,
      "symbolic_link",
      "Publication directories cannot contain symbolic links.",
    );
  }
  if (info.isDirectory()) {
    await inspectDirectory(absoluteChildPath, relativeChildPath, files);
    return undefined;
  }
  if (!info.isFile()) {
    throw inputFailure(
      absoluteChildPath,
      "unsupported_file_type",
      "Publication directories can contain only regular files and directories.",
    );
  }
  if (files.length >= maximumFileCount) {
    throw inputFailure(
      absoluteChildPath,
      "too_many_files",
      `A publication can contain at most ${maximumFileCount} files.`,
    );
  }
  files.push(await inspectRegularFile(absoluteChildPath, relativeChildPath));
}

async function inspectRegularFile(
  absolutePath: string,
  relativePath: string,
): Promise<DiskPreparedFile> {
  assertPortableClientPath(relativePath, absolutePath);
  const fileHandle = await open(
    absolutePath,
    fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW,
  );
  try {
    const info = await fileHandle.stat();
    if (!info.isFile()) {
      throw inputFailure(
        absolutePath,
        "unsupported_file_type",
        "The publication input must contain only regular files.",
      );
    }
    if (!Number.isSafeInteger(info.size)) {
      throw inputFailure(
        absolutePath,
        "unsupported_file_type",
        "The selected file is too large to represent safely.",
      );
    }
    const fingerprint = createHash("sha256");
    const stream = fileHandle.createReadStream({autoClose: false});
    for await (const chunk of stream) fingerprint.update(chunk);
    return {
      kind: "disk",
      absolutePath,
      device: info.dev,
      inode: info.ino,
      mediaType: mediaTypeForPath(relativePath),
      modifiedAtMilliseconds: info.mtimeMs,
      path: relativePath,
      sha256: fingerprint.digest("hex"),
      size: info.size,
    };
  } finally {
    await fileHandle.close();
  }
}

function canonicalPreparedPublication(
  defaultName: string,
  entryPath: string,
  files: readonly PreparedFile[],
  inputPath: string,
  routingMode: "spa" | "static",
): PreparedPublication {
  try {
    const manifest = createManifest({
      entryPath,
      files,
      routingMode,
    });
    const filesByPath = new Map(files.map((file) => [file.path, file]));
    return {
      defaultName,
      entryPath: manifest.entryPath,
      files: manifest.entries.map((entry) => {
        const file = filesByPath.get(entry.path);
        if (file === undefined) {
          throw new Error("A canonical manifest entry lost its prepared file.");
        }
        return file;
      }),
      routingMode: manifest.routingMode,
    };
  } catch (cause) {
    if (cause instanceof EmptyManifest) {
      throw inputFailure(inputPath, "empty_directory", cause.message);
    }
    if (cause instanceof MissingManifestEntry) {
      throw inputFailure(inputPath, "invalid_entry", cause.message);
    }
    if (cause instanceof InvalidManifestPath) {
      throw inputFailure(inputPath, "invalid_path", cause.message);
    }
    if (cause instanceof InvalidManifestFile) {
      throw inputFailure(inputPath, "unsupported_file_type", cause.message);
    }
    throw cause;
  }
}

function assertPortableClientPath(
  relativePath: string,
  absolutePath: string,
): void {
  if (relativePath.length > maximumManifestPathLength) {
    throw inputFailure(
      absolutePath,
      "invalid_path",
      `Artifact paths cannot exceed ${maximumManifestPathLength} characters.`,
    );
  }
  try {
    parseManifestPath(relativePath);
  } catch (cause) {
    if (cause instanceof InvalidManifestPath) {
      throw inputFailure(absolutePath, "invalid_path", cause.message);
    }
    throw cause;
  }
}

const parseServerOrigin = Effect.fn("FilePublicationClient.parseServerOrigin")(
  function*(
    candidate: string,
  ): Effect.fn.Return<URL, FilePublicationConfigurationError> {
    return yield* Effect.try({
      try: () => {
        const url = new URL(candidate);
        if (
          (url.protocol !== "http:" && url.protocol !== "https:")
          || url.username.length > 0
          || url.password.length > 0
          || (url.pathname !== "/" && url.pathname !== "")
          || url.search.length > 0
          || url.hash.length > 0
        ) {
          throw new Error("invalid server origin");
        }
        url.pathname = "/";
        return url;
      },
      catch: () => new FilePublicationConfigurationError({
        message: "The Artifact Server URL must be an HTTP or HTTPS origin without credentials, a path, a query, or a fragment.",
        reason: "invalid_server",
      }),
    });
  },
);

const createUpload = Effect.fn("FilePublicationClient.createUpload")(
  function*(
    serverOrigin: URL,
    apiToken: Redacted.Redacted,
    prepared: PreparedPublication,
    projectId: string | undefined,
    idempotencyKey: string,
  ): Effect.fn.Return<
    typeof createUploadResponseSchema.Type,
    FilePublicationProtocolError,
    HttpClient.HttpClient
  > {
    const files = prepared.files.map((file) => ({
      mediaType: file.mediaType,
      path: file.path,
      sha256: file.sha256,
      size: file.size,
    }));
    const body: CreateUploadRequestBody = projectId === undefined ? {
      entryPath: prepared.entryPath,
      files,
      routingMode: prepared.routingMode,
    } : {
      entryPath: prepared.entryPath,
      files,
      projectId,
      routingMode: prepared.routingMode,
    };
    const request = yield* jsonRequest(
      HttpClientRequest.post(new URL("/api/v1/uploads", serverOrigin)).pipe(
        HttpClientRequest.setHeader("Idempotency-Key", idempotencyKey),
      ),
      apiToken,
      body,
      "create_upload",
    );
    return yield* executeJson(
      request,
      createUploadResponseSchema,
      {action: "Creating the upload", operation: "create_upload"},
    );
  },
);

const validateUploadPlan = Effect.fn("FilePublicationClient.validateUploadPlan")(
  function*(
    serverOrigin: URL,
    prepared: PreparedPublication,
    upload: typeof stagedUploadResponseSchema.Type,
  ): Effect.fn.Return<void, FilePublicationConfigurationError> {
    if (
      upload.commitUrl.origin !== serverOrigin.origin
      || upload.files.some((file) => file.uploadUrl.origin !== serverOrigin.origin)
    ) {
      return yield* new FilePublicationConfigurationError({
        message: "The server returned an upload URL on another origin. Artifact Server credentials were not sent.",
        reason: "unsafe_upload_plan",
      });
    }
    if (upload.files.length !== prepared.files.length) {
      return yield* unsafeUploadPlan(
        "The server returned an incomplete file-upload plan.",
      );
    }
    const preparedByPath = new Map(prepared.files.map((file) => [file.path, file]));
    const plannedPaths = new Set<string>();
    for (const planned of upload.files) {
      const preparedFile = preparedByPath.get(planned.path);
      if (
        preparedFile === undefined
        || preparedFile.size !== planned.size
        || plannedPaths.has(planned.path)
      ) {
        return yield* unsafeUploadPlan(
          "The server returned a file-upload plan that does not match the selected files.",
        );
      }
      plannedPaths.add(planned.path);
    }
    return undefined;
  },
);

const uploadPreparedFile = Effect.fn("FilePublicationClient.uploadPreparedFile")(
  function*(
    plannedFile: typeof stagedUploadResponseSchema.Type["files"][number],
    preparedFile: PreparedFile,
    uploadId: string,
  ): Effect.fn.Return<
    void,
    FilePublicationInputError | FilePublicationProtocolError,
    FileSystem.FileSystem | HttpClient.HttpClient
  > {
    const subject: TransferSubject = {
      action: `Uploading ${plannedFile.path}`,
      operation: "upload_file",
    };
    const uploaded = yield* retryStagedTransfer(Effect.gen(function*() {
      // Each attempt reopens the file and re-checks it is the prepared one.
      const body = preparedFile.kind === "generated"
        ? HttpBody.uint8Array(preparedFile.content, preparedFile.mediaType)
        : yield* preparedDiskBody(preparedFile);
      const request = HttpClientRequest.put(plannedFile.uploadUrl).pipe(
        HttpClientRequest.setBody(body),
      );
      return yield* executeJson(request, uploadedFileResponseSchema, subject);
    }));
    if (uploaded.path !== plannedFile.path || uploaded.uploadId !== uploadId) {
      return yield* protocolFailure(
        "upload_file",
        "Artifact Server verified a different upload file than the client sent.",
        200,
      );
    }
    return undefined;
  },
);

const uploadPreparedBatch = Effect.fn("FilePublicationClient.uploadPreparedBatch")(
  function*(
    serverOrigin: URL,
    uploadId: string,
    unverified: typeof stagedUploadResponseSchema.Type["files"],
    preparedFiles: readonly PreparedFile[],
    plan: typeof stagedUploadResponseSchema.Type,
    config: FilePublicationClientConfig,
  ): Effect.fn.Return<
    void,
    FilePublicationInputError | FilePublicationProtocolError,
    FileSystem.FileSystem | HttpClient.HttpClient
  > {
    const firstFile = unverified[0];
    if (firstFile === undefined) return undefined;
    const orderIndexByPath = new Map(
      plan.files.map((file, index) => [file.path, index] as const),
    );
    if (unverified.some((file) => file.size > maximumBatchRequestBytes)) {
      yield* Effect.forEach(
        unverified,
        (plannedFile) => uploadPreparedFile(
          plannedFile,
          requiredPreparedFile(preparedFiles, plannedFile.path),
          uploadId,
        ),
        {concurrency: uploadConcurrency, discard: true},
      );
      return undefined;
    }
    const batches: (typeof unverified)[number][][] = [];
    let current: (typeof unverified)[number][] = [];
    let currentBytes = 0;
    for (const plannedFile of unverified) {
      if (
        current.length > 0 &&
        (current.length >= maximumBatchParts ||
          currentBytes + plannedFile.size > maximumBatchRequestBytes)
      ) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(plannedFile);
      currentBytes += plannedFile.size;
    }
    if (current.length > 0) batches.push(current);

    const batchUrl = new URL(`/api/v1/uploads/${uploadId}/batch`, serverOrigin);
    batchUrl.search = new URL(firstFile.uploadUrl).search;

    for (const batch of batches) {
      const subject: TransferSubject = {
        action: `Uploading a batch of ${batch.length} files starting with ${batch[0]?.path ?? "?"}`,
        operation: "upload_batch",
      };
      // eslint-disable-next-line no-await-in-loop -- sequential batch POSTs
      const result = yield* retryStagedTransfer(Effect.gen(function*() {
        // Each attempt rereads every part and re-checks it is the prepared file.
        const parts: {bytes: Uint8Array; declaredSize: number; orderIndex: number}[] = [];
        for (const plannedFile of batch) {
          const preparedFile = requiredPreparedFile(preparedFiles, plannedFile.path);
          const orderIndex = orderIndexByPath.get(plannedFile.path);
          if (orderIndex === undefined) {
            return yield* protocolFailure(
              "upload_batch",
              `The upload plan does not declare ${plannedFile.path}.`,
              200,
            );
          }
          // eslint-disable-next-line no-await-in-loop -- sequential per-part reads
          const bytes = yield* preparedFileBytes(preparedFile);
          parts.push({bytes, declaredSize: bytes.byteLength, orderIndex});
        }
        const frame = encodeBatchFrame(parts);
        const request = HttpClientRequest.post(batchUrl).pipe(
          HttpClientRequest.bearerToken(config.apiToken),
          HttpClientRequest.setBody(HttpBody.uint8Array(frame)),
        );
        return yield* executeJson(request, batchUploadResponseSchema, subject);
      }));
      if (result.uploadId !== uploadId) {
        return yield* protocolFailure(
          "upload_batch",
          "Artifact Server answered a different upload than the client sent.",
          200,
        );
      }
      if (result.rejected.length > 0) {
        return yield* protocolFailure(
          "upload_batch",
          `Artifact Server rejected batch parts: ${
            result.rejected.map((part) => `${part.path ?? "?"}:${part.code}`).join(", ")
          }.`,
          200,
        );
      }
      const accepted = new Set(result.accepted.map((part) => part.path));
      for (const plannedFile of batch) {
        if (!accepted.has(plannedFile.path)) {
          return yield* protocolFailure(
            "upload_batch",
            `Artifact Server did not verify ${plannedFile.path}.`,
            200,
          );
        }
      }
    }
    return undefined;
  },
);

function encodeBatchFrame(
  parts: readonly {bytes: Uint8Array; declaredSize: number; orderIndex: number}[],
): Uint8Array {
  const total = parts.reduce((sum, part) => sum + 12 + part.bytes.byteLength, 0);
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.orderIndex, true);
    view.setFloat64(offset + 4, part.declaredSize, true);
    frame.set(part.bytes, offset + 12);
    offset += 12 + part.bytes.byteLength;
  }
  return frame;
}

const preparedFileBytes = Effect.fn("FilePublicationClient.preparedFileBytes")(
  function*(
    preparedFile: PreparedFile,
  ): Effect.fn.Return<Uint8Array, FilePublicationInputError> {
    if (preparedFile.kind === "generated") {
      return preparedFile.content;
    }
    yield* assertPreparedFileStable(preparedFile);
    return yield* Effect.tryPromise({
      try: () => readFile(preparedFile.absolutePath).then(
        (buffer) => new Uint8Array(buffer),
      ),
      catch: () => inputFailure(
        preparedFile.absolutePath,
        "read_failed",
        "The selected file could not be opened for upload.",
      ),
    });
  },
);

const preparedDiskBody = Effect.fn("FilePublicationClient.preparedDiskBody")(
  function*(preparedFile: DiskPreparedFile) {
    yield* assertPreparedFileStable(preparedFile);
    return yield* HttpBody.file(preparedFile.absolutePath, {
      contentType: preparedFile.mediaType,
    }).pipe(
      Effect.mapError(() => inputFailure(
        preparedFile.absolutePath,
        "read_failed",
        "The selected file could not be opened for upload.",
      )),
    );
  },
);

const assertPreparedFileStable = Effect.fn("FilePublicationClient.assertPreparedFileStable")(
  function*(
    preparedFile: DiskPreparedFile,
  ): Effect.fn.Return<void, FilePublicationInputError> {
    const current = yield* Effect.tryPromise({
      try: () => lstat(preparedFile.absolutePath),
      catch: () => inputFailure(
        preparedFile.absolutePath,
        "read_failed",
        "The selected file could not be inspected before upload.",
      ),
    });
    if (
      !current.isFile()
      || current.isSymbolicLink()
      || current.dev !== preparedFile.device
      || current.ino !== preparedFile.inode
      || current.size !== preparedFile.size
      || current.mtimeMs !== preparedFile.modifiedAtMilliseconds
    ) {
      return yield* inputFailure(
        preparedFile.absolutePath,
        "input_changed",
        "The selected file changed after publication preparation. Run publish again.",
      );
    }
    return undefined;
  },
);



type CommitAttemptResult =
  | {readonly kind: "committed"; readonly publication: FilePublicationResult}
  | {readonly kind: "preparing"; readonly installed: number; readonly total: number};

const maximumCommitPreparationRetries = 9;

const tryCommitUpload = Effect.fn("FilePublicationClient.tryCommitUpload")(
  function*(
    apiToken: Redacted.Redacted,
    idempotencyKey: string,
    target: CommitPublicationTarget,
    commitUrl: URL,
  ): Effect.fn.Return<
    CommitAttemptResult,
    FilePublicationProtocolError,
    HttpClient.HttpClient
  > {
    const request = yield* jsonRequest(
      HttpClientRequest.post(commitUrl).pipe(
        HttpClientRequest.setHeader("Idempotency-Key", idempotencyKey),
      ),
      apiToken,
      {target},
      "commit_upload",
    );
    const response = yield* executeWithTransportContext(
      request,
      {action: "Committing the upload", operation: "commit_upload"},
    );
    if (response.status === 202) {
      const preparing = yield* HttpClientResponse.schemaBodyJson(
        preparingUploadResponseSchema,
      )(response).pipe(
        Effect.mapError(() => protocolFailure(
          "commit_upload",
          "Artifact Server returned an invalid preparation-progress response.",
          202,
        )),
      );
      return {kind: "preparing" as const, ...preparing};
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* failureFromResponse(
        response,
        {action: "Committing the upload", operation: "commit_upload"},
      );
    }
    const publication = yield* HttpClientResponse.schemaBodyJson(publishResponseSchema)(response).pipe(
      Effect.mapError(() => protocolFailure(
        "commit_upload",
        "Artifact Server returned an invalid success response.",
        response.status,
      )),
    );
    return {kind: "committed" as const, publication};
  },
);

const commitUpload = Effect.fn("FilePublicationClient.commitUpload")(
  function*(
    apiToken: Redacted.Redacted,
    idempotencyKey: string,
    target: CommitPublicationTarget,
    commitUrl: URL,
  ): Effect.fn.Return<
    FilePublicationResult,
    FilePublicationProtocolError,
    HttpClient.HttpClient
  > {
    let lastPreparing: {readonly installed: number; readonly total: number} | undefined;
    for (let attempt = 0; attempt <= maximumCommitPreparationRetries; attempt += 1) {
      const result = yield* tryCommitUpload(
        apiToken,
        idempotencyKey,
        target,
        commitUrl,
      );
      if (result.kind === "committed") {
        return result.publication;
      }
      lastPreparing = result;
      if (attempt === maximumCommitPreparationRetries) {
        break;
      }
      const delaySeconds = Math.min(2 ** attempt, 30);
      yield* Effect.sleep(Duration.seconds(delaySeconds));
    }
    const progress = lastPreparing ?? {installed: 0, total: 0};
    return yield* new FilePublicationProtocolError({
      message:
        `The upload is still preparing (${progress.installed}/${progress.total} files). Re-run the same publish with the same idempotency key to resume.`,
      operation: "commit_upload",
      serverCode: null,
      status: 202,
      transportCode: null,
    });
  },
);

const jsonRequest = Effect.fn("FilePublicationClient.jsonRequest")(
  function*(
    request: HttpClientRequest.HttpClientRequest,
    apiToken: Redacted.Redacted,
    body: FilePublicationRequestBody,
    operation: FilePublicationOperation,
  ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, FilePublicationProtocolError> {
    return yield* HttpClientRequest.bodyJson(
      HttpClientRequest.bearerToken(request, apiToken),
      body,
    ).pipe(
      Effect.mapError(() => protocolFailure(
        operation,
        "The publication request could not be encoded.",
      )),
    );
  },
);

const executeJson = Effect.fn("FilePublicationClient.executeJson")(
  function*<A>(
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.ConstraintDecoder<A>,
    subject: TransferSubject,
  ): Effect.fn.Return<A, FilePublicationProtocolError, HttpClient.HttpClient> {
    const response = yield* executeWithTransportContext(request, subject);
    if (response.status < 200 || response.status >= 300) {
      return yield* failureFromResponse(response, subject);
    }
    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(() => protocolFailure(
        subject.operation,
        "Artifact Server returned an invalid success response.",
        response.status,
      )),
    );
  },
);

/**
 * Send one request, and when the exchange breaks before an answer arrives,
 * say what was being sent, how long it ran, and the transport's own code.
 * "Could not be reached" is kept for a connection that never opened.
 */
const executeWithTransportContext = Effect.fn(
  "FilePublicationClient.executeWithTransportContext",
)(function*(
  request: HttpClientRequest.HttpClientRequest,
  subject: TransferSubject,
): Effect.fn.Return<
  HttpClientResponse.HttpClientResponse,
  FilePublicationProtocolError,
  HttpClient.HttpClient
> {
  const startedAt = yield* Clock.currentTimeMillis;
  return yield* HttpClient.execute(request).pipe(
    Effect.catch((error) => Effect.flatMap(
      Clock.currentTimeMillis,
      (failedAt) => Effect.fail(transportFailure(subject, error, failedAt - startedAt)),
    )),
  );
});

const failureFromResponse = Effect.fn("FilePublicationClient.failureFromResponse")(
  function*(
    response: HttpClientResponse.HttpClientResponse,
    subject: TransferSubject,
  ): Effect.fn.Return<never, FilePublicationProtocolError> {
    const decoded = yield* response.json.pipe(
      Effect.map(decodeServerError),
      Effect.catch(() => Effect.succeed(Option.none())),
    );
    // A file transfer names its file; whole-publication answers stand alone.
    const prefix = subject.operation === "upload_file" || subject.operation === "upload_batch"
      ? `${subject.action} failed: `
      : "";
    return yield* Option.match(decoded, {
      onNone: () => protocolFailure(
        subject.operation,
        `${prefix}Artifact Server rejected the publication request with HTTP ${response.status}.`,
        response.status,
      ),
      onSome: (body) => new FilePublicationProtocolError({
        message: `${prefix}${body.error.message}`,
        operation: subject.operation,
        serverCode: body.error.code,
        status: response.status,
        transportCode: null,
      }),
    });
  },
);

/**
 * Repeat one staged transfer while it fails transiently, with jittered
 * exponential backoff capped at the policy ceiling. A validation rejection,
 * a digest mismatch, or a changed local file is never repeated.
 */
const retryStagedTransfer = Effect.fnUntraced(function*<A, R>(
  transfer: Effect.Effect<A, FilePublicationInputError | FilePublicationProtocolError, R>,
): Effect.fn.Return<A, FilePublicationInputError | FilePublicationProtocolError, R> {
  const policy = yield* StagedTransferRetry;
  const ceiling = Duration.millis(policy.maximumDelayMilliseconds);
  const backoff = Schedule.exponential(Duration.millis(policy.initialDelayMilliseconds)).pipe(
    Schedule.jittered,
    Schedule.modifyDelay(({duration}) => Effect.succeed(Duration.min(duration, ceiling))),
  );
  let attempts = 0;
  return yield* Effect.suspend(() => {
    attempts += 1;
    return transfer;
  }).pipe(
    Effect.retry({
      schedule: backoff,
      times: Math.max(0, policy.maximumAttempts - 1),
      while: isTransientTransferFailure,
    }),
    Effect.mapError((error) =>
      attempts > 1 && error._tag === "FilePublicationProtocolError"
        ? new FilePublicationProtocolError({
          message:
            `${error.message} Gave up after ${attempts} attempts; re-run the same publish to resume. Files already verified are not sent again.`,
          operation: error.operation,
          serverCode: error.serverCode,
          status: error.status,
          transportCode: error.transportCode,
        })
        : error
    ),
  );
});

function isTransientTransferFailure(
  error: FilePublicationInputError | FilePublicationProtocolError,
): boolean {
  return error._tag === "FilePublicationProtocolError" && (
    (error.transportCode !== null && transientTransportCodes.has(error.transportCode))
    || (error.status !== null && transientTransferStatuses.has(error.status))
    || error.serverCode === errorCodes.uploadInterrupted
  );
}

function transportFailure(
  subject: TransferSubject,
  error: HttpClientError.HttpClientError,
  elapsedMilliseconds: number,
): FilePublicationProtocolError {
  const cause = transportCause(error);
  const detail = cause.code === null
    ? cause.message === "" ? "" : ` (${cause.message})`
    : cause.message === "" || cause.message.includes(cause.code)
    ? ` (${cause.code})`
    : ` (${cause.code}: ${cause.message})`;
  const unreachable = cause.code !== null && unreachableTransportCodes.has(cause.code);
  const fileTransfer = subject.operation === "upload_file" || subject.operation === "upload_batch";
  const seconds = Math.max(0, Math.round(elapsedMilliseconds / 1_000));
  const description = cause.code === null
    ? "the request failed"
    : transportCodeDescriptions.get(cause.code) ?? "the request failed";
  const message = unreachable
    ? `${fileTransfer ? `${subject.action} failed: ` : ""}Artifact Server could not be reached${detail}.`
    : `${subject.action} failed after ${seconds} s: ${description}${detail}.`;
  return new FilePublicationProtocolError({
    message,
    operation: subject.operation,
    serverCode: null,
    status: null,
    transportCode: cause.code ?? "TRANSPORT_FAILURE",
  });
}

/**
 * The deepest stable transport code in a fetch failure's cause chain, with
 * that error's message stripped of URLs, paths, and opaque identifiers. The
 * HTTP client's own message is skipped because it repeats the request URL,
 * and an upload URL carries its slot's write capability.
 */
function transportCause(error: HttpClientError.HttpClientError): TransportCause {
  let found: TransportCause = {code: null, message: ""};
  let current: unknown = error.cause;
  for (
    let depth = 0;
    depth < maximumTransportCauseDepth && current instanceof Error;
    depth += 1
  ) {
    const code = Predicate.hasProperty(current, "code") &&
        Predicate.isString(current.code) &&
        transportCodePattern.test(current.code)
      ? current.code
      : null;
    if (code !== null || found.code === null) {
      found = {code: code ?? found.code, message: redactFailureMessage(current.message)};
    }
    current = current.cause;
  }
  return found;
}

function requiredPreparedFile(
  files: readonly PreparedFile[],
  filePath: string,
): PreparedFile {
  const file = files.find((candidate) => candidate.path === filePath);
  if (file === undefined) {
    throw new Error("A validated upload plan lost its prepared file.");
  }
  return file;
}

function inputFailureFrom(cause: unknown, inputPath: string): FilePublicationInputError {
  if (cause instanceof FilePublicationInputError) return cause;
  return inputFailure(
    inputPath,
    "read_failed",
    "The publication input could not be read.",
  );
}

function inputFailure(
  inputPath: string,
  reason: FilePublicationInputError["reason"],
  message: string,
): FilePublicationInputError {
  return new FilePublicationInputError({inputPath, message, reason});
}

function protocolFailure(
  operation: FilePublicationOperation,
  message: string,
  status: number | null = null,
): FilePublicationProtocolError {
  return new FilePublicationProtocolError({
    message,
    operation,
    serverCode: null,
    status,
    transportCode: null,
  });
}

function unsafeUploadPlan(message: string): FilePublicationConfigurationError {
  return new FilePublicationConfigurationError({
    message,
    reason: "unsafe_upload_plan",
  });
}
