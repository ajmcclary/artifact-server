import { Readable } from "node:stream";

import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  ListMultipartUploadsCommand,
  type PutObjectCommandInput,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Option, Redacted, Schema } from "effect";

import type {
  BlobByteRange,
  BlobStore,
  BlobWrite,
  OpenedBlob,
  OpenedBlobRange,
  StagingStore,
  StoredBlob,
} from "../core/ports.js";
import type {
  ObjectStorageProvider,
  ObjectStorageProviderFactory,
} from "./object-storage-provider.js";
import {
  createInstallationObjectKeyspace,
  digestMetadataName,
  inspectCloudObjectMetadata,
  kindMetadataName,
  requireCloudObjectBody,
  type StoredObjectKind,
  verifyCloudObjectWriteSize,
} from "./cloud-object-storage.js";
import { drainVerifiedBlobWrite, verifiedBlobStream } from "./verified-file.js";
const multipartPartBytes = 8 * 1024 * 1024;

const s3FailureSchema = Schema.Struct({
  $metadata: Schema.optional(Schema.Struct({
    httpStatusCode: Schema.optional(Schema.Number),
  })),
});
const parseS3Failure = Schema.decodeUnknownOption(s3FailureSchema);

interface S3ObjectStorageProviderConfigBase {
  readonly bucket: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  readonly region: string;
}

/** S3 settings using either a static pair or the AWS SDK credential chain. */
export type S3ObjectStorageProviderConfig = S3ObjectStorageProviderConfigBase & (
  | {
    readonly accessKeyId: string;
    readonly secretAccessKey: Redacted.Redacted;
  }
  | {
    readonly accessKeyId?: never;
    readonly secretAccessKey?: never;
  }
);

/** Construction values for one installation's S3-compatible storage adapters. */
export interface S3ObjectStorageConfig {
  /** Bucket created and authorized by the deployment composition root. */
  readonly bucket: string;
  /** Provider client owned and destroyed by the deployment composition root. */
  readonly client: S3Client;
  /** Trusted installation identity used to derive an isolated key prefix. */
  readonly installationId: string;
}

/** Immutable and staging adapters backed by one installation-scoped bucket. */
export interface S3ObjectStorageAdapters {
  /** Content-addressed immutable blob operations. */
  readonly blobs: BlobStore;
  /** Uncommitted staged-upload operations. */
  readonly staging: StagingStore;
}

/**
 * Build the deployment-facing S3 provider factory while keeping AWS SDK types
 * out of the external server runtime.
 */
export function createS3ObjectStorageProviderFactory(
  config: S3ObjectStorageProviderConfig,
): ObjectStorageProviderFactory {
  return {
    kind: "s3",
    create: (installationId) => createS3ObjectStorageProvider(config, installationId),
  };
}

/** Build an AWS SDK client configuration from validated S3 settings. */
export function createS3ClientConfig(
  config: S3ObjectStorageProviderConfig,
): S3ClientConfig {
  const base: S3ClientConfig = {
    forcePathStyle: config.forcePathStyle ?? false,
    region: config.region,
  };
  if (config.accessKeyId !== undefined) {
    base.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: Redacted.value(config.secretAccessKey),
    };
  }
  if (config.endpoint !== undefined) base.endpoint = config.endpoint;
  return base;
}

function createS3ObjectStorageProvider(
  config: S3ObjectStorageProviderConfig,
  installationId: string,
): ObjectStorageProvider {
  const client = new S3Client(createS3ClientConfig(config));
  const adapters = createS3ObjectStorageAdapters({
    bucket: config.bucket,
    client,
    installationId,
  });
  return {
    ...adapters,
    kind: "s3",
    close: () => {
      client.destroy();
      return Promise.resolve();
    },
    readiness: async (signal) => {
      await client.send(
        new HeadBucketCommand({Bucket: config.bucket}),
        {abortSignal: signal},
      );
    },
  };
}

/**
 * Construct S3-compatible storage adapters without exposing provider types to
 * application services.
 */
export function createS3ObjectStorageAdapters(
  config: S3ObjectStorageConfig,
): S3ObjectStorageAdapters {
  const keyspace = createInstallationObjectKeyspace(config.installationId);
  const objects = new S3Objects(config.client, config.bucket);

  return {
    blobs: {
      inspect: (digest) => objects.inspect(
        keyspace.blob(digest),
        digest,
        "blob",
      ),
      open: (digest) => objects.open(
        keyspace.blob(digest),
        digest,
        "blob",
      ),
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
    },
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

class S3Objects {
  readonly #bucket: string;
  readonly #client: S3Client;

  constructor(client: S3Client, bucket: string) {
    this.#bucket = bucket;
    this.#client = client;
  }

  async inspect(
    key: string,
    expectedDigest: string | null,
    kind: StoredObjectKind,
  ): Promise<StoredBlob> {
    const output = await this.#client.send(new HeadObjectCommand({
      Bucket: this.#bucket,
      Key: key,
    }));
    return inspectCloudObjectMetadata({
      expectedDigest,
      kind,
      metadata: output.Metadata,
      provider: "S3",
      size: output.ContentLength ?? Number.NaN,
    });
  }

  async remove(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({
      Bucket: this.#bucket,
      Key: key,
    }));
  }

  async open(
    key: string,
    expectedDigest: string | null,
    kind: StoredObjectKind,
  ): Promise<OpenedBlob> {
    const output = await this.#client.send(new GetObjectCommand({
      Bucket: this.#bucket,
      Key: key,
    }));
    const stored = inspectCloudObjectMetadata({
      expectedDigest,
      kind,
      metadata: output.Metadata,
      provider: "S3",
      size: output.ContentLength ?? Number.NaN,
    });
    const body = requireCloudObjectBody(
      output.Body,
      "S3",
      kind,
      "provider returned no body",
    );
    return {
      body: body.transformToWebStream(),
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
    const output = await this.#client.send(new GetObjectCommand({
      Bucket: this.#bucket,
      Key: key,
      Range: `bytes=${range.start}-${range.endInclusive}`,
    }));
    const totalSize = parseS3ContentRange(output.ContentRange, range);
    const stored = inspectCloudObjectMetadata({
      expectedDigest,
      kind,
      metadata: output.Metadata,
      provider: "S3",
      size: totalSize,
    });
    const body = requireCloudObjectBody(
      output.Body,
      "S3",
      kind,
      "provider returned no ranged body",
    );
    return {
      body: body.transformToWebStream(),
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
    if (kind === "blob") {
      const existing = await this.#inspectIfPresent(key, expectedDigest);
      if (existing !== null) {
        await drainVerifiedBlobWrite(write, expectedDigest);
        return verifyCloudObjectWriteSize(existing, write.size, "S3", kind);
      }
      try {
        await this.#upload(key, write, expectedDigest, kind, true);
      } catch (error) {
        // A create-only rejection means a concurrent verified writer won; the
        // failed body already passed the stream verifier, so the stored object
        // only needs its metadata and size re-inspected before reuse.
        const failure = parseS3Failure(error);
        const preconditionFailed = Option.isSome(failure) &&
          failure.value.$metadata?.httpStatusCode === 412;
        if (!preconditionFailed) throw error;
        // The existing object dooms every in-flight multipart session for this
        // key, including the rejected one, which the uploader does not abort.
        await this.#abortDoomedMultipartUploads(key);
      }
    } else {
      await this.#upload(key, write, expectedDigest, kind, false);
    }
    return verifyCloudObjectWriteSize(
      await this.inspect(key, expectedDigest, kind),
      write.size,
      "S3",
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
      const failure = parseS3Failure(error);
      const missing = Option.isSome(failure) &&
        failure.value.$metadata?.httpStatusCode === 404;
      if (!missing) throw error;
      return null;
    }
  }

  async #abortDoomedMultipartUploads(key: string): Promise<void> {
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    for (;;) {
      // Pages must stay ordered so a bounded number of sessions is listed.
      // eslint-disable-next-line no-await-in-loop
      const listed = await this.#client.send(new ListMultipartUploadsCommand({
        Bucket: this.#bucket,
        KeyMarker: keyMarker,
        Prefix: key,
        UploadIdMarker: uploadIdMarker,
      }));
      for (const session of listed.Uploads ?? []) {
        if (session.Key !== key || session.UploadId === undefined) continue;
        try {
          // Aborts must stay ordered so a bounded number of sessions is active.
          // eslint-disable-next-line no-await-in-loop
          await this.#client.send(new AbortMultipartUploadCommand({
            Bucket: this.#bucket,
            Key: key,
            UploadId: session.UploadId,
          }));
        } catch (error) {
          const failure = parseS3Failure(error);
          const alreadyGone = Option.isSome(failure) &&
            failure.value.$metadata?.httpStatusCode === 404;
          if (!alreadyGone) throw error;
        }
      }
      if (listed.IsTruncated !== true) return;
      keyMarker = listed.NextKeyMarker;
      uploadIdMarker = listed.NextUploadIdMarker;
    }
  }

  async #upload(
    key: string,
    write: BlobWrite,
    expectedDigest: string,
    kind: StoredObjectKind,
    createOnly: boolean,
  ): Promise<void> {
    const verifiedBody = verifiedBlobStream(write, expectedDigest);
    const abortController = new AbortController();
    const abort = () => abortController.abort(write.signal?.reason);
    if (write.signal?.aborted === true) abort();
    else write.signal?.addEventListener("abort", abort, {once: true});
    const params: PutObjectCommandInput = {
      Body: Readable.from(verifiedBody, {objectMode: false}),
      Bucket: this.#bucket,
      ContentType: "application/octet-stream",
      Key: key,
      Metadata: {
        [digestMetadataName]: expectedDigest,
        [kindMetadataName]: kind,
      },
    };
    // PutObject applies the condition directly; multipart uploads apply it at
    // CompleteMultipartUpload after every part passed verification.
    if (createOnly) params.IfNoneMatch = "*";
    const upload = new Upload({
      abortController,
      client: this.#client,
      leavePartsOnError: false,
      params,
      partSize: multipartPartBytes,
      queueSize: 2,
    });
    try {
      await upload.done();
    } finally {
      write.signal?.removeEventListener("abort", abort);
    }
  }
}

function parseS3ContentRange(
  contentRange: string | undefined,
  expected: BlobByteRange,
): number {
  const match = contentRange === undefined
    ? null
    : /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(contentRange);
  if (match === null) throw new Error("S3 returned an invalid ranged response.");
  const [, startText, endText, sizeText] = match;
  const start = Number(startText);
  const endInclusive = Number(endText);
  const size = Number(sizeText);
  if (
    !Number.isSafeInteger(size) ||
    start !== expected.start ||
    endInclusive !== expected.endInclusive ||
    expected.endInclusive >= size
  ) {
    throw new Error("S3 returned a range other than the requested blob bytes.");
  }
  return size;
}
