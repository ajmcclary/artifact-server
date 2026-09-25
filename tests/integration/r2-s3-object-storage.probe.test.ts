import {createHash, randomBytes, randomUUID} from "node:crypto";

import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {describe, expect, test} from "vitest";

import type {BlobStore, StagingStore} from "../../src/core/ports.js";
import {createS3ObjectStorageAdapters} from
  "../../src/storage/s3-object-storage.js";

const accessKeyId = requiredEnvironment("CLOUDFLARE_R2_ACCESS_ID");
const bucket = requiredEnvironment("ARTIFACT_SERVER_R2_S3_PROBE_BUCKET");
const endpoint = requiredR2Endpoint("CLOUDFLARE_R2_ENDPOINT");
const secretAccessKey = requiredEnvironment("CLOUDFLARE_R2_ACCESS_KEY");
const multipartBytes = 9 * 1024 * 1024;

describe("Cloudflare R2 S3 adapter probe", () => {
  test("R2 preserves verified streams, create-only convergence and exact cleanup", async () => {
    const client = new S3Client({
      credentials: {accessKeyId, secretAccessKey},
      endpoint,
      forcePathStyle: true,
      region: "auto",
    });
    const installationId = `r2-s3-probe-${randomUUID()}`;
    const namespace = createHash("sha256").update(installationId).digest("hex");
    const prefix = `installations/${namespace}/`;
    const storage = createS3ObjectStorageAdapters({
      bucket,
      client,
      installationId,
    });
    try {
      const bytes = patternedBytes(multipartBytes);
      const fingerprint = digest(bytes);
      await expect(storage.blobs.put({
        body: chunkedBody(bytes, 256 * 1024),
        sha256: fingerprint,
        size: bytes.byteLength,
      })).resolves.toEqual({sha256: fingerprint, size: bytes.byteLength});
      await expect(readBlob(storage.blobs, fingerprint)).resolves.toEqual(bytes);

      const concurrentBytes = patternedBytes(512 * 1024);
      const concurrentFingerprint = digest(concurrentBytes);
      await Promise.all(Array.from({length: 4}, () => storage.blobs.put({
        body: chunkedBody(concurrentBytes, 64 * 1024),
        sha256: concurrentFingerprint,
        size: concurrentBytes.byteLength,
      })));
      await expect(readBlob(storage.blobs, concurrentFingerprint))
        .resolves.toEqual(concurrentBytes);

      const stagedBytes = new TextEncoder().encode("R2 staged probe bytes");
      const stagedFingerprint = digest(stagedBytes);
      const storageToken = randomBytes(18).toString("hex");
      const uploadId = `upl_${randomUUID()}`;
      await storage.staging.put({
        body: chunkedBody(stagedBytes, 5),
        sha256: stagedFingerprint,
        size: stagedBytes.byteLength,
        storageToken,
        uploadId,
      });
      await expect(readStaged(storage.staging, uploadId, storageToken))
        .resolves.toEqual(stagedBytes);

      await expect(storage.blobs.put({
        body: chunkedBody(bytes, 256 * 1024),
        sha256: fingerprint,
        size: bytes.byteLength - 1,
      })).rejects.toThrow(/declared/u);
      await expect(readBlob(storage.blobs, fingerprint)).resolves.toEqual(bytes);
    } finally {
      await removeRunObjects(client, prefix);
      client.destroy();
    }
  });
});

async function removeRunObjects(client: S3Client, prefix: string): Promise<void> {
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  for (;;) {
    // Pages and cleanup mutations stay ordered so the live probe is bounded.
    // eslint-disable-next-line no-await-in-loop
    const uploads = await client.send(new ListMultipartUploadsCommand({
      Bucket: bucket,
      KeyMarker: keyMarker,
      Prefix: prefix,
      UploadIdMarker: uploadIdMarker,
    }));
    for (const upload of uploads.Uploads ?? []) {
      if (upload.Key === undefined || upload.UploadId === undefined) continue;
      // Aborts stay ordered to limit live provider concurrency during cleanup.
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
    // Each delete page is verified before listing the next bounded page.
    // eslint-disable-next-line no-await-in-loop
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
    }));
    const objects = (listed.Contents ?? []).flatMap(({Key}) =>
      Key === undefined ? [] : [{Key}]
    );
    if (objects.length === 0) break;
    // Deletes stay ordered so cleanup cannot fan out across live provider pages.
    // eslint-disable-next-line no-await-in-loop
    const deleted = await client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {Objects: objects, Quiet: true},
    }));
    if ((deleted.Errors ?? []).length > 0) {
      throw new Error("R2 qualification cleanup reported object deletion errors.");
    }
  }

  const remaining = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
  }));
  if ((remaining.Contents ?? []).length !== 0) {
    throw new Error("R2 qualification cleanup left run-scoped objects behind.");
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

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Run this test through pnpm verify:r2-s3; ${name} is missing.`);
  }
  return value;
}

function requiredR2Endpoint(name: string): string {
  const value = requiredEnvironment(name);
  const endpointUrl = new URL(value);
  if (
    endpointUrl.protocol !== "https:" ||
    !endpointUrl.hostname.endsWith(".r2.cloudflarestorage.com") ||
    endpointUrl.pathname !== "/"
  ) {
    throw new Error(`${name} is not an account-scoped Cloudflare R2 endpoint.`);
  }
  return endpointUrl.toString();
}
