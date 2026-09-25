import {createHash, randomBytes, randomUUID} from "node:crypto";

import {
  AbortMultipartUploadCommand,
  CopyObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {describe, expect, test} from "vitest";

import type {BlobStore, StagingStore} from "../../src/core/ports.js";
import {Option} from "effect";

import {createInstallationObjectKeyspace} from "../../src/storage/cloud-object-storage.js";
import {createS3ObjectStorageAdapters} from "../../src/storage/s3-object-storage.js";
import {parseS3Failure} from "../../src/storage/s3-failure.js";
import {probeS3SealedPromotion} from "../../src/storage/s3-sealed-promotion-probe.js";

const bucket = requiredBucket();
const multipartBytes = 9 * 1024 * 1024;

describe("AWS S3 sealed promotion probe", () => {
  test("AWS S3 enforces sealed promotion preconditions", async () => {
    const client = new S3Client({region: "us-east-1"});
    const installationId = `aws-s3-promotion-probe-${randomUUID()}`;
    const prefix = runPrefix(installationId);
    try {
      await expect(
        probeS3SealedPromotion(client, bucket, installationId),
      ).resolves.toBe(true);
      const remaining = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
      }));
      expect(remaining.Contents ?? []).toHaveLength(0);
    } finally {
      await removeRunObjects(client, prefix);
      client.destroy();
    }
  });

  test("sealed promotion installs exact bytes and converges create-only", async () => {
    const client = new S3Client({region: "us-east-1"});
    const installationId = `aws-s3-promotion-probe-${randomUUID()}`;
    const prefix = runPrefix(installationId);
    const storage = createS3ObjectStorageAdapters({
      bucket,
      client,
      installationId,
      promotion: "enabled",
    });
    const keyspace = createInstallationObjectKeyspace(installationId);
    try {
      const bytes = patternedBytes(multipartBytes);
      const fingerprint = digest(bytes);
      const storageToken = randomBytes(18).toString("hex");
      const uploadId = `upl_${randomUUID()}`;
      await storage.staging.put({
        body: chunkedBody(bytes, 256 * 1024),
        sha256: fingerprint,
        size: bytes.byteLength,
        storageToken,
        uploadId,
      });
      assertPromote(storage.blobs);
      const promoted = await storage.blobs.promote({
        sha256: fingerprint,
        size: bytes.byteLength,
        storageToken,
        uploadId,
      });
      expect(promoted).toEqual({sha256: fingerprint, size: bytes.byteLength});
      await expect(readBlob(storage.blobs, fingerprint)).resolves.toEqual(bytes);
      await expect(readStaged(storage.staging, uploadId, storageToken))
        .resolves.toEqual(bytes);

      const concurrentToken = randomBytes(18).toString("hex");
      const concurrentUploadId = `upl_${randomUUID()}`;
      await storage.staging.put({
        body: chunkedBody(bytes, 256 * 1024),
        sha256: fingerprint,
        size: bytes.byteLength,
        storageToken: concurrentToken,
        uploadId: concurrentUploadId,
      });
      const [first, second] = await Promise.all([
        storage.blobs.promote({
          sha256: fingerprint,
          size: bytes.byteLength,
          storageToken,
          uploadId,
        }),
        storage.blobs.promote({
          sha256: fingerprint,
          size: bytes.byteLength,
          storageToken: concurrentToken,
          uploadId: concurrentUploadId,
        }),
      ]);
      expect(first).toEqual(promoted);
      expect(second).toEqual(promoted);
      await expect(readBlob(storage.blobs, fingerprint)).resolves.toEqual(bytes);

      const otherBytes = patternedBytes(multipartBytes + 1);
      const otherSourceKey = `${prefix}/other-source`;
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: otherSourceKey,
        Body: otherBytes,
      }));
      const blobKey = keyspace.blob(fingerprint);
      const overwriteStatus = await catchStatus(client.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: blobKey,
        CopySource: `/${bucket}/${encodeURIComponent(otherSourceKey)}`,
        IfNoneMatch: "*",
        MetadataDirective: "REPLACE",
        Metadata: {},
      })));
      expect(overwriteStatus).toBe(412);
      await expect(readBlob(storage.blobs, fingerprint)).resolves.toEqual(bytes);
    } finally {
      await removeRunObjects(client, prefix);
      client.destroy();
    }
  });

  test("a replaced staged source fails closed and the stream fallback installs", async () => {
    const client = new S3Client({region: "us-east-1"});
    const installationId = `aws-s3-promotion-probe-${randomUUID()}`;
    const prefix = runPrefix(installationId);
    const storage = createS3ObjectStorageAdapters({
      bucket,
      client,
      installationId,
      promotion: "enabled",
    });
    const keyspace = createInstallationObjectKeyspace(installationId);
    try {
      const bytesA = patternedBytes(512 * 1024);
      const fingerprintA = digest(bytesA);
      const storageToken = randomBytes(18).toString("hex");
      const uploadId = `upl_${randomUUID()}`;
      await storage.staging.put({
        body: chunkedBody(bytesA, 64 * 1024),
        sha256: fingerprintA,
        size: bytesA.byteLength,
        storageToken,
        uploadId,
      });

      const bytesB = patternedBytes(512 * 1024 + 1);
      const stagingKey = keyspace.staging(uploadId, storageToken);
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: stagingKey,
        Body: bytesB,
      }));

      assertPromote(storage.blobs);
      await expect(storage.blobs.promote({
        sha256: fingerprintA,
        size: bytesA.byteLength,
        storageToken,
        uploadId,
      })).rejects.toThrow(/fingerprint|size|staged source/u);

      const orphanStatus = await catchStatus(client.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: keyspace.blob(fingerprintA),
      })));
      expect(orphanStatus).toBe(404);

      await expect(storage.blobs.put({
        body: chunkedBody(bytesA, 64 * 1024),
        sha256: fingerprintA,
        size: bytesA.byteLength,
      })).resolves.toEqual({sha256: fingerprintA, size: bytesA.byteLength});
      await expect(readBlob(storage.blobs, fingerprintA)).resolves.toEqual(bytesA);
    } finally {
      await removeRunObjects(client, prefix);
      client.destroy();
    }
  });
});

function requiredBucket(): string {
  const value = process.env["ARTIFACT_SERVER_AWS_S3_PROMOTION_BUCKET"] ??
    "artifact-server-runtime-ajmcclary-20260923";
  if (value !== "artifact-server-runtime-ajmcclary-20260923") {
    throw new Error(
      "This probe must target artifact-server-runtime-ajmcclary-20260923.",
    );
  }
  return value;
}

function runPrefix(installationId: string): string {
  const namespace = createHash("sha256").update(installationId).digest("hex");
  return `installations/${namespace}/`;
}

async function removeRunObjects(client: S3Client, prefix: string): Promise<void> {
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const uploads = await client.send(new ListMultipartUploadsCommand({
      Bucket: bucket,
      KeyMarker: keyMarker,
      Prefix: prefix,
      UploadIdMarker: uploadIdMarker,
    }));
    for (const upload of uploads.Uploads ?? []) {
      if (upload.Key === undefined || upload.UploadId === undefined) continue;
      // eslint-disable-next-line no-await-in-loop
      await client.send(new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: upload.Key,
        UploadId: upload.UploadId,
      }));
    }
    if (uploads.IsTruncated !== true) break;
    keyMarker = uploads.NextKeyMarker;
    uploadIdMarker = uploads.NextUploadIdMarker;
  }

  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
    }));
    const objects = (listed.Contents ?? []).flatMap(({Key}) =>
      Key === undefined ? [] : [{Key}]
    );
    if (objects.length === 0) break;
    // eslint-disable-next-line no-await-in-loop
    const deleted = await client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {Objects: objects, Quiet: true},
    }));
    if ((deleted.Errors ?? []).length > 0) {
      throw new Error("AWS S3 promotion probe cleanup reported deletion errors.");
    }
  }

  const remaining = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
  }));
  if ((remaining.Contents ?? []).length !== 0) {
    throw new Error("AWS S3 promotion probe cleanup left run-scoped objects behind.");
  }
}

function assertPromote(
  blobs: BlobStore,
): asserts blobs is BlobStore & {promote: NonNullable<BlobStore["promote"]>} {
  if (blobs.promote === undefined) {
    throw new Error("promote is not exposed; the probe returned false.");
  }
}

async function catchStatus(request: Promise<unknown>): Promise<number | undefined> {
  try {
    await request;
    return undefined;
  } catch (error) {
    const failure = parseS3Failure(error);
    return Option.match(failure, {
      onNone: () => undefined,
      onSome: (value) => value.$metadata?.httpStatusCode,
    });
  }
}

async function readBlob(
  store: BlobStore,
  fingerprint: string,
): Promise<Uint8Array> {
  const opened = await store.open(fingerprint);
  return new Uint8Array(await new Response(opened.body).arrayBuffer());
}

async function readStaged(
  store: StagingStore,
  uploadId: string,
  storageToken: string,
): Promise<Uint8Array> {
  const opened = await store.open(uploadId, storageToken);
  return new Uint8Array(await new Response(opened.body).arrayBuffer());
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function patternedBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

function chunkedBody(
  bytes: Uint8Array,
  chunkBytes: number,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const next = Math.min(offset + chunkBytes, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, next));
      offset = next;
    },
  });
}
