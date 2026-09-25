import {createHash, randomBytes, randomUUID} from "node:crypto";

import {Storage} from "@google-cloud/storage";
import {Option} from "effect";
import {describe, expect, test} from "vitest";

import type {BlobStore, StagingStore} from "../../src/core/ports.js";
import {createInstallationObjectKeyspace} from "../../src/storage/cloud-object-storage.js";
import {parseGcsFailure} from "../../src/storage/gcs-failure.js";
import {createGcsObjectStorageAdapters} from
  "../../src/storage/gcs-object-storage.js";
import {probeGcsSealedPromotion} from
  "../../src/storage/gcs-sealed-promotion-probe.js";

const bucket = requiredEnvironment("ARTIFACT_SERVER_GCS_PROBE_BUCKET");
const projectId = requiredEnvironment("ARTIFACT_SERVER_GCS_PROBE_PROJECT_ID");
const resumableBytes = 11 * 1024 * 1024;

describe("GCS sealed promotion probe (live)", () => {
  test("GCS enforces sealed promotion preconditions", async () => {
    const storage = new Storage({projectId});
    const gcsBucket = storage.bucket(bucket);
    const installationId = `gcs-promotion-probe-${randomUUID()}`;
    try {
      await expect(probeGcsSealedPromotion(gcsBucket, installationId))
        .resolves.toBe(true);
      const [remaining] = await gcsBucket.getFiles({
        prefix: runPrefix(installationId),
      });
      expect(remaining).toHaveLength(0);
    } finally {
      await removeRunObjects(gcsBucket, runPrefix(installationId));
    }
  });

  test("sealed promotion installs exact bytes and converges create-only", async () => {
    const storage = new Storage({projectId});
    const gcsBucket = storage.bucket(bucket);
    const installationId = `gcs-promotion-probe-${randomUUID()}`;
    const adapters = createGcsObjectStorageAdapters({
      bucket: gcsBucket,
      installationId,
      promotion: "enabled",
    });
    const keyspace = createInstallationObjectKeyspace(installationId);
    try {
      const bytes = patternedBytes(resumableBytes);
      const fingerprint = digest(bytes);
      const storageToken = randomBytes(18).toString("hex");
      const uploadId = `upl_${randomUUID()}`;
      await adapters.staging.put({
        body: chunkedBody(bytes, 256 * 1024),
        sha256: fingerprint,
        size: bytes.byteLength,
        storageToken,
        uploadId,
      });
      assertPromote(adapters.blobs);
      const promoted = await adapters.blobs.promote({
        sha256: fingerprint,
        size: bytes.byteLength,
        storageToken,
        uploadId,
      });
      expect(promoted).toEqual({sha256: fingerprint, size: bytes.byteLength});
      await expect(readBlob(adapters.blobs, fingerprint)).resolves.toEqual(bytes);
      await expect(readStaged(adapters.staging, uploadId, storageToken))
        .resolves.toEqual(bytes);

      const concurrentToken = randomBytes(18).toString("hex");
      const concurrentUploadId = `upl_${randomUUID()}`;
      await adapters.staging.put({
        body: chunkedBody(bytes, 256 * 1024),
        sha256: fingerprint,
        size: bytes.byteLength,
        storageToken: concurrentToken,
        uploadId: concurrentUploadId,
      });
      const [first, second] = await Promise.all([
        adapters.blobs.promote({
          sha256: fingerprint,
          size: bytes.byteLength,
          storageToken,
          uploadId,
        }),
        adapters.blobs.promote({
          sha256: fingerprint,
          size: bytes.byteLength,
          storageToken: concurrentToken,
          uploadId: concurrentUploadId,
        }),
      ]);
      expect(first).toEqual(promoted);
      expect(second).toEqual(promoted);
      await expect(readBlob(adapters.blobs, fingerprint)).resolves.toEqual(bytes);

      // A raw create-only overwrite of the installed blob is rejected and the
      // original bytes stay intact.
      const overwriteStatus = await catchStatus(
        gcsBucket.file(keyspace.blob(fingerprint)).save(
          patternedBytes(resumableBytes + 1),
          {
            preconditionOpts: {ifGenerationMatch: 0},
            resumable: false,
            validation: false,
          },
        ),
      );
      expect(overwriteStatus).toBe(412);
      await expect(readBlob(adapters.blobs, fingerprint)).resolves.toEqual(bytes);
    } finally {
      await removeRunObjects(gcsBucket, runPrefix(installationId));
    }
  });

  test("a replaced staged source fails closed and the stream fallback installs", async () => {
    const storage = new Storage({projectId});
    const gcsBucket = storage.bucket(bucket);
    const installationId = `gcs-promotion-probe-${randomUUID()}`;
    const adapters = createGcsObjectStorageAdapters({
      bucket: gcsBucket,
      installationId,
      promotion: "enabled",
    });
    const keyspace = createInstallationObjectKeyspace(installationId);
    try {
      const bytesA = patternedBytes(512 * 1024);
      const fingerprintA = digest(bytesA);
      const storageToken = randomBytes(18).toString("hex");
      const uploadId = `upl_${randomUUID()}`;
      await adapters.staging.put({
        body: chunkedBody(bytesA, 64 * 1024),
        sha256: fingerprintA,
        size: bytesA.byteLength,
        storageToken,
        uploadId,
      });

      const bytesB = patternedBytes(512 * 1024 + 1);
      await gcsBucket.file(keyspace.staging(uploadId, storageToken)).save(bytesB, {
        resumable: false,
        validation: false,
      });

      assertPromote(adapters.blobs);
      await expect(adapters.blobs.promote({
        sha256: fingerprintA,
        size: bytesA.byteLength,
        storageToken,
        uploadId,
      })).rejects.toThrow(/fingerprint|size|staged source/u);

      const orphanStatus = await catchStatus(
        gcsBucket.file(keyspace.blob(fingerprintA)).getMetadata(),
      );
      expect(orphanStatus).toBe(404);

      await expect(adapters.blobs.put({
        body: chunkedBody(bytesA, 64 * 1024),
        sha256: fingerprintA,
        size: bytesA.byteLength,
      })).resolves.toEqual({sha256: fingerprintA, size: bytesA.byteLength});
      await expect(readBlob(adapters.blobs, fingerprintA)).resolves.toEqual(bytesA);
    } finally {
      await removeRunObjects(gcsBucket, runPrefix(installationId));
    }
  });
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error("Run this test through pnpm verify:gcs-promotion.");
  }
  return value;
}

function runPrefix(installationId: string): string {
  const namespace = createHash("sha256").update(installationId).digest("hex");
  return `installations/${namespace}/`;
}

async function removeRunObjects(
  gcsBucket: ReturnType<Storage["bucket"]>,
  prefix: string,
): Promise<void> {
  await gcsBucket.deleteFiles({force: true, prefix});
  const [remaining] = await gcsBucket.getFiles({prefix});
  if (remaining.length !== 0) {
    throw new Error("GCS promotion probe cleanup left run-scoped objects behind.");
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
    const failure = parseGcsFailure(error);
    return Option.match(failure, {
      onNone: () => undefined,
      onSome: (value) => value.code,
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
