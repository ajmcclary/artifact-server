import {createHash} from "node:crypto";
import {
  constants as fileSystemConstants,
  lstat,
  open,
  readdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";

import {Effect, Option, Schema, type Redacted} from "effect";
import type * as FileSystem from "effect/FileSystem";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  EmptyManifest,
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

import {
  claudeDesignCatalogPath,
  claudeDesignManifestPath,
  createClaudeDesignCatalog,
} from "../manifest/claude-design.js";

const maximumFileCount = 10_000;
const maximumManifestPathLength = 1_024;
const defaultDirectoryEntryPath = "index.html";
const maximumDesignManifestBytes = 4 * 1024 * 1024;
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
  },
) {}

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
  readonly content: string;
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

/**
 * Publish one local file or finished directory through a server-issued upload
 * plan. The server receives bytes and portable manifest paths, never the local
 * filesystem path.
 */
export const publishPath = Effect.fn("FilePublicationClient.publishPath")(
  function*(
    config: FilePublicationClientConfig,
    command: FilePublicationCommand,
  ): Effect.fn.Return<
    FilePublicationResult,
    FilePublicationFailure,
    FileSystem.FileSystem | HttpClient.HttpClient
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

/** Publish one previously validated local snapshot with a durable operation key. */
export const publishPreparedPath = Effect.fn(
  "FilePublicationClient.publishPreparedPath",
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
  const manifestPath = claudeDesignManifestPath(paths);
  const manifest = files.find((file) => file.path === manifestPath);
  try {
    const manifestText = manifest?.kind === "disk"
      ? await readDesignManifest(manifest)
      : undefined;
    const content = createClaudeDesignCatalog(paths, manifestPath, manifestText);
    if (content === undefined) return defaultDirectoryEntryPath;
    if (paths.some((candidate) => candidate.toLowerCase() === claudeDesignCatalogPath)) {
      throw new Error("The generated Claude Design catalog path already exists; choose --entry explicitly.");
    }
    if (files.length >= maximumFileCount) {
      throw new Error("The Claude Design catalog would exceed the publication file limit.");
    }
    files.push({
      kind: "generated",
      content,
      mediaType: "text/html; charset=utf-8",
      path: claudeDesignCatalogPath,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: Buffer.byteLength(content),
    });
    return claudeDesignCatalogPath;
  } catch (cause) {
    throw inputFailure(inputPath, "invalid_entry", cause instanceof Error
      ? `Cannot prepare Claude Design export: ${cause.message}`
      : "Cannot prepare Claude Design export.");
  }
}

async function readDesignManifest(file: DiskPreparedFile): Promise<string> {
  if (file.size > maximumDesignManifestBytes) {
    throw new Error("Claude Design manifests must not exceed 4 MiB.");
  }
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
      throw new Error("Claude Design manifest changed during publication preparation.");
    }
    return content.toString("utf8");
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
      "create_upload",
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
    const body = preparedFile.kind === "generated"
      ? HttpBody.text(preparedFile.content, preparedFile.mediaType)
      : yield* preparedDiskBody(preparedFile);
    const request = HttpClientRequest.put(plannedFile.uploadUrl).pipe(
      HttpClientRequest.setBody(body),
    );
    const uploaded = yield* executeJson(
      request,
      uploadedFileResponseSchema,
      "upload_file",
    );
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
      // eslint-disable-next-line no-await-in-loop -- sequential batch POSTs
      const result = yield* executeJson(request, batchUploadResponseSchema, "upload_batch");
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
      return new TextEncoder().encode(preparedFile.content);
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
    const request = yield* jsonRequest(
      HttpClientRequest.post(commitUrl).pipe(
        HttpClientRequest.setHeader("Idempotency-Key", idempotencyKey),
      ),
      apiToken,
      {target},
      "commit_upload",
    );
    return yield* executeJson(request, publishResponseSchema, "commit_upload");
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
    operation: FilePublicationOperation,
  ): Effect.fn.Return<A, FilePublicationProtocolError, HttpClient.HttpClient> {
    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError(() => protocolFailure(
        operation,
        "Artifact Server could not be reached.",
      )),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* failureFromResponse(response, operation);
    }
    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(() => protocolFailure(
        operation,
        "Artifact Server returned an invalid success response.",
        response.status,
      )),
    );
  },
);

const failureFromResponse = Effect.fn("FilePublicationClient.failureFromResponse")(
  function*(
    response: HttpClientResponse.HttpClientResponse,
    operation: FilePublicationOperation,
  ): Effect.fn.Return<never, FilePublicationProtocolError> {
    const decoded = yield* response.json.pipe(
      Effect.map(decodeServerError),
      Effect.catch(() => Effect.succeed(Option.none())),
    );
    return yield* Option.match(decoded, {
      onNone: () => protocolFailure(
        operation,
        `Artifact Server rejected the publication request with HTTP ${response.status}.`,
        response.status,
      ),
      onSome: (body) => new FilePublicationProtocolError({
        message: body.error.message,
        operation,
        serverCode: body.error.code,
        status: response.status,
      }),
    });
  },
);

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
  });
}

function unsafeUploadPlan(message: string): FilePublicationConfigurationError {
  return new FilePublicationConfigurationError({
    message,
    reason: "unsafe_upload_plan",
  });
}
