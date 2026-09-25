import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";

import {Storage, type Bucket, type CreateWriteStreamOptions, type FileMetadata} from "@google-cloud/storage";
import {Option, Schema} from "effect";

import type {
  BlobByteRange,
  BlobStore,
  BlobWrite,
  OpenedBlob,
  OpenedBlobRange,
  SealedStagedSource,
  StagingStore,
  StoredBlob,
} from "../core/ports.js";
import {
  createInstallationObjectKeyspace,
  digestMetadataName,
  inspectCloudObjectMetadata,
  kindMetadataName,
  nodeByteStream,
  type InstallationObjectKeyspace,
  type StoredObjectKind,
  verifyCloudObjectWriteSize,
} from "./cloud-object-storage.js";
import {parseGcsFailure} from "./gcs-failure.js";
import {probeGcsSealedPromotion} from "./gcs-sealed-promotion-probe.js";
import type {
  ObjectStorageProvider,
  ObjectStorageProviderFactory,
} from "./object-storage-provider.js";
import {drainVerifiedBlobWrite, verifiedBlobStream} from "./verified-file.js";

const resumableUploadThresholdBytes = 10 * 1024 * 1024;
const maximumSealAttempts = 3;

/** GCS settings using Google Application Default Credentials. */
export interface GcsObjectStorageProviderConfig {
  /** Optional API endpoint used only by controlled integration environments. */
  readonly apiEndpoint?: string;
  /** Existing bucket authorized for the runtime service account. */
  readonly bucket: string;
  /** Google Cloud project that owns the runtime and bucket. */
  readonly projectId: string;
}

/** Construction values for one installation's GCS adapters. */
export interface GcsObjectStorageConfig {
  /** Bucket client owned by the deployment composition root. */
  readonly bucket: Bucket;
  /** Trusted installation identity used to derive an isolated key prefix. */
  readonly installationId: string;
  /**
   * Sealed rewrite promotion mode. "probe" defers the decision to runtime
   * readiness; "enabled" exposes promote unconditionally (test seam);
   * "disabled" never exposes it.
   */
  readonly promotion?: "probe" | "enabled" | "disabled";
}

/** Immutable and staging adapters backed by one installation-scoped GCS bucket. */
export interface GcsObjectStorageAdapters {
  /** Content-addressed immutable blob operations. */
  readonly blobs: BlobStore;
  /** Uncommitted staged-upload operations. */
  readonly staging: StagingStore;
}

/** Build the deployment-facing GCS provider factory using ADC. */
export function createGcsObjectStorageProviderFactory(
  config: GcsObjectStorageProviderConfig,
): ObjectStorageProviderFactory {
  return {
    kind: "gcs",
    create: (installationId) => createGcsObjectStorageProvider(
      config,
      installationId,
    ),
  };
}

/** Construct GCS adapters around an already configured bucket client. */
export function createGcsObjectStorageAdapters(
  config: GcsObjectStorageConfig,
): GcsObjectStorageAdapters {
  const keyspace = createInstallationObjectKeyspace(config.installationId);
  const objects = new GcsObjects(config.bucket);
  return buildGcsObjectStorageAdapters(
    objects,
    keyspace,
    config.promotion ?? "probe",
  );
}

function buildGcsObjectStorageAdapters(
  objects: GcsObjects,
  keyspace: InstallationObjectKeyspace,
  promotion: "probe" | "enabled" | "disabled" = "probe",
): GcsObjectStorageAdapters {
  const blobs: BlobStore = {
    inspect: (digest) => objects.inspect(keyspace.blob(digest), digest, "blob"),
    open: (digest) => objects.open(keyspace.blob(digest), digest, "blob"),
    openRange: (digest, range) => objects.openRange(
      keyspace.blob(digest),
      digest,
      "blob",
      range,
    ),
    put: (write) => objects.put(
      keyspace.blob(write.sha256),
      write,
      write.sha256,
      "blob",
    ),
  };
  if (promotion === "enabled") {
    blobs.promote = (source) => objects.promote(source, keyspace);
  }

  return {
    blobs,
    staging: {
      remove: (uploadId, storageToken) => objects.remove(
        keyspace.staging(uploadId, storageToken),
      ),
      open: async (uploadId, storageToken) => {
        const opened = await objects.open(
          keyspace.staging(uploadId, storageToken),
          null,
          "staging",
        );
        return {body: opened.body, size: opened.size};
      },
      put: (write) => objects.put(
        keyspace.staging(write.uploadId, write.storageToken),
        write,
        write.sha256,
        "staging",
      ),
    },
  };
}

function createGcsObjectStorageProvider(
  config: GcsObjectStorageProviderConfig,
  installationId: string,
): ObjectStorageProvider {
  const storage = new Storage(config.apiEndpoint === undefined
    ? {projectId: config.projectId}
    : {apiEndpoint: config.apiEndpoint, projectId: config.projectId});
  const bucket = storage.bucket(config.bucket);
  const keyspace = createInstallationObjectKeyspace(installationId);
  const objects = new GcsObjects(bucket);
  const adapters = buildGcsObjectStorageAdapters(objects, keyspace, "probe");
  // The capability probe writes, copies and deletes scratch objects, so a
  // settled result is memoized per process rather than re-run on every
  // readiness poll. A rejected probe is retried on the next poll and only
  // withholds promote — the verified-stream fallback keeps serving.
  let promotionProbe: Promise<boolean> | undefined;
  const probePromotion = async () => {
    promotionProbe ??= probeGcsSealedPromotion(bucket, installationId);
    try {
      return await promotionProbe;
    } catch {
      promotionProbe = undefined;
      return false;
    }
  };
  return {
    ...adapters,
    kind: "gcs",
    close: () => Promise.resolve(),
    readiness: async (signal) => {
      await abortable(bucket.getMetadata(), signal);
      if (await probePromotion()) {
        adapters.blobs.promote = (source) => objects.promote(source, keyspace);
      }
    },
  };
}

class GcsObjects {
  readonly #bucket: Bucket;

  constructor(bucket: Bucket) {
    this.#bucket = bucket;
  }

  async inspect(
    key: string,
    expectedDigest: string | null,
    kind: StoredObjectKind,
  ): Promise<StoredBlob> {
    const [metadata] = await this.#bucket.file(key).getMetadata();
    return inspectGcsMetadata(metadata, expectedDigest, kind);
  }

  async remove(key: string): Promise<void> {
    await this.#bucket.file(key).delete({ignoreNotFound: true});
  }

  async open(
    key: string,
    expectedDigest: string | null,
    kind: StoredObjectKind,
  ): Promise<OpenedBlob> {
    const file = this.#bucket.file(key);
    const [metadata] = await file.getMetadata();
    const stored = inspectGcsMetadata(metadata, expectedDigest, kind);
    return {
      body: nodeByteStream(file.createReadStream()),
      sha256: stored.sha256,
      size: stored.size,
    };
  }

  async openRange(
    key: string,
    expectedDigest: string,
    kind: StoredObjectKind,
    range: BlobByteRange,
  ): Promise<OpenedBlobRange> {
    const file = this.#bucket.file(key);
    const [metadata] = await file.getMetadata();
    const stored = inspectGcsMetadata(metadata, expectedDigest, kind);
    assertProviderRange("GCS", range, stored.size);
    return {
      body: nodeByteStream(file.createReadStream({
        end: range.endInclusive,
        start: range.start,
      })),
      range,
      sha256: stored.sha256,
      size: stored.size,
    };
  }

  async put(
    key: string,
    write: BlobWrite,
    expectedDigest: string,
    kind: StoredObjectKind,
  ): Promise<StoredBlob> {
    const file = this.#bucket.file(key);
    if (kind === "blob") {
      const existing = await this.#inspectIfPresent(key, expectedDigest);
      if (existing !== null) {
        await drainVerifiedBlobWrite(write, expectedDigest);
        return verifyCloudObjectWriteSize(existing, write.size, "GCS", kind);
      }
    }
    try {
      const options: CreateWriteStreamOptions = {
        metadata: {
          contentType: "application/octet-stream",
          metadata: {
            [digestMetadataName]: expectedDigest,
            [kindMetadataName]: kind,
          },
        },
        resumable: write.size >= resumableUploadThresholdBytes,
        validation: "crc32c",
      };
      // Immutable blobs install only into an unused generation; staging slots
      // stay rewritable for resumed uploads.
      if (kind === "blob") options.preconditionOpts = {ifGenerationMatch: 0};
      await pipeline(
        Readable.from(verifiedBlobStream(write, expectedDigest), {
          objectMode: false,
        }),
        file.createWriteStream(options),
        write.signal === undefined ? {} : {signal: write.signal},
      );
    } catch (error) {
      // A create-only rejection means a concurrent verified writer won; the
      // failed body already passed the stream verifier, so the stored object
      // only needs its metadata and size re-inspected before reuse.
      const failure = parseGcsFailure(error);
      if (kind !== "blob" || Option.isNone(failure) || failure.value.code !== 412) {
        throw error;
      }
    }
    return verifyCloudObjectWriteSize(
      await this.inspect(key, expectedDigest, kind),
      write.size,
      "GCS",
      kind,
    );
  }

  async #inspectIfPresent(
    key: string,
    expectedDigest: string,
  ): Promise<StoredBlob | null> {
    try {
      return await this.inspect(key, expectedDigest, "blob");
    } catch (error) {
      const failure = parseGcsFailure(error);
      if (Option.isNone(failure) || failure.value.code !== 404) throw error;
      return null;
    }
  }

  async promote(
    source: SealedStagedSource,
    keyspace: InstallationObjectKeyspace,
  ): Promise<StoredBlob> {
    const destKey = keyspace.blob(source.sha256);
    for (let attempt = 0; attempt < maximumSealAttempts; attempt += 1) {
      // Each iteration re-inspects the destination first so a completed but
      // unacknowledged copy converges instead of duplicating.
      // eslint-disable-next-line no-await-in-loop
      const existing = await this.#inspectIfPresent(destKey, source.sha256);
      if (existing !== null) {
        return verifyCloudObjectWriteSize(
          existing,
          source.size,
          "GCS",
          "blob",
        );
      }

      const sourceKey = keyspace.staging(
        source.uploadId,
        source.storageToken,
      );
      let generation: number | string;
      try {
        // eslint-disable-next-line no-await-in-loop
        const [metadata] = await this.#bucket.file(sourceKey).getMetadata();
        if (Number(metadata.size) !== source.size) {
          throw new Error(
            `The staged source for blob ${source.sha256} has an unexpected size.`,
          );
        }
        if (stringMetadata(metadata.metadata)?.[digestMetadataName] !== source.sha256) {
          throw new Error(
            `The staged source for blob ${source.sha256} failed fingerprint verification.`,
          );
        }
        if (metadata.generation === undefined) {
          throw new Error("GCS returned no generation for the staged source.");
        }
        generation = metadata.generation;
      } catch (error) {
        const failure = parseGcsFailure(error);
        if (Option.isSome(failure) && failure.value.code === 404) {
          throw new Error(
            `The staged source for blob ${source.sha256} is missing.`,
            {cause: error},
          );
        }
        throw error;
      }

      try {
        // The pinned source generation copies exactly the sealed bytes: a
        // staged slot replaced after the seal either rewrites the old
        // generation or fails 404 so the next attempt re-seals. The
        // zero-generation destination precondition keeps the copy create-only.
        // eslint-disable-next-line no-await-in-loop
        await this.#bucket.file(sourceKey, {generation}).copy(
          this.#bucket.file(destKey),
          {
            contentType: "application/octet-stream",
            metadata: {
              [digestMetadataName]: source.sha256,
              [kindMetadataName]: "blob",
            },
            preconditionOpts: {ifGenerationMatch: 0},
          },
        );
      } catch (error) {
        const failure = parseGcsFailure(error);
        const status = Option.isSome(failure) ? failure.value.code : undefined;
        if (status === 412) {
          // eslint-disable-next-line no-await-in-loop
          const winner = await this.#inspectIfPresent(destKey, source.sha256);
          if (winner !== null) {
            return verifyCloudObjectWriteSize(
              winner,
              source.size,
              "GCS",
              "blob",
            );
          }
        }
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const verified = await this.inspect(destKey, source.sha256, "blob");
      return verifyCloudObjectWriteSize(
        verified,
        source.size,
        "GCS",
        "blob",
      );
    }
    throw new Error(
      `The staged source for blob ${source.sha256} could not be promoted after ${maximumSealAttempts} attempts.`,
    );
  }
}

function assertProviderRange(
  provider: string,
  range: BlobByteRange,
  size: number,
): void {
  if (range.start < 0 || range.endInclusive < range.start || range.endInclusive >= size) {
    throw new RangeError(`${provider} blob range is outside the stored object.`);
  }
}

function inspectGcsMetadata(
  metadata: FileMetadata,
  expectedDigest: string | null,
  kind: StoredObjectKind,
): StoredBlob {
  return inspectCloudObjectMetadata({
    expectedDigest,
    kind,
    metadata: stringMetadata(metadata.metadata),
    provider: "GCS",
    size: Number(metadata.size),
  });
}

function stringMetadata(
  metadata: FileMetadata["metadata"],
): Readonly<Record<string, string>> | undefined {
  if (metadata === undefined) return undefined;
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const parsed = Schema.decodeUnknownOption(Schema.String)(value);
    if (Option.isSome(parsed)) strings[key] = parsed.value;
  }
  return strings;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, {once: true});
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
        return undefined;
      },
      (error: Error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
        return undefined;
      },
    );
  });
}
