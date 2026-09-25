import {createHash, randomBytes, randomUUID} from "node:crypto";

import {
  CreateBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {Redacted} from "effect";
import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BlobStore, SealedStagedSource, StagingStore, StoredBlob} from "../../src/core/ports.js";
import {createInstallationObjectKeyspace} from "../../src/storage/cloud-object-storage.js";
import {
  createS3ObjectStorageAdapters,
  createS3ObjectStorageProviderFactory,
  type S3ObjectStorageConfig,
} from "../../src/storage/s3-object-storage.js";
import {startS3CopyObjectFaultProxy} from "../support/s3-copyobject-fault-proxy.js";

const bucket = "artifact-server-integration-promotion";
const region = "us-east-1";
const integrationTestTimeoutMs = 90_000;
const multipartBytes = 9 * 1024 * 1024;

interface IntegrationEnvironment {
  readonly accessKey: string;
  readonly container: string;
  readonly endpoint: string;
  readonly image: string;
  readonly secretKey: string;
  readonly volume: string;
}

describe.sequential("S3 sealed staged promotion", () => {
  let client: S3Client;
  let environment: IntegrationEnvironment;

  beforeAll(async () => {
    environment = readIntegrationEnvironment();
    client = createClient(environment);
    try {
      await client.send(new CreateBucketCommand({Bucket: bucket}));
    } catch (error) {
      const parsed = s3ErrorSchema.safeParse(error);
      if (
        !parsed.success ||
        parsed.data.$metadata?.httpStatusCode !== 409
      ) {
        throw error;
      }
    }
  });

  afterAll(() => {
    client.destroy();
  });

  test(
    "PUB-018-F: default probe on MinIO exposes no promote and leaves no scratch objects",
    async () => {
      const installationId = "installation-promotion-probe";
      const storage = createS3ObjectStorageProviderFactory({
        accessKeyId: environment.accessKey,
        bucket,
        endpoint: environment.endpoint,
        forcePathStyle: true,
        region,
        secretAccessKey: Redacted.make(environment.secretKey),
      }).create(installationId);
      try {
        await storage.readiness(AbortSignal.timeout(3_000));
        expect(Object.hasOwn(storage.blobs, "promote")).toBe(false);

        const namespace = createHash("sha256").update(installationId).digest("hex");
        const listed = await client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `installations/${namespace}/promotion-probe/`,
        }));
        expect(listed.Contents ?? []).toEqual([]);
      } finally {
        await storage.close();
      }
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-B: sealed copy round trip promotes, keeps staged bytes, and serves exact bytes",
    async () => {
      const installationId = "installation-promotion-round-trip";
      const storage = createStorage(client, installationId, {promotion: "enabled"});
      const bytes = new TextEncoder().encode("sealed promotion round trip bytes");
      const digest = digestBytes(bytes);
      const {uploadId, storageToken} = await stage(storage.staging, bytes, digest);

      const promoted = await promote(storage, {
        sha256: digest,
        size: bytes.byteLength,
        storageToken,
        uploadId,
      });
      expect(promoted).toEqual({sha256: digest, size: bytes.byteLength});

      await expect(readBlob(storage.blobs, digest)).resolves.toEqual(bytes);
      const head = await client.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: blobKey(installationId, digest),
      }));
      expect(head.Metadata?.["artifact-kind"]).toBe("blob");
      expect(head.Metadata?.["artifact-sha256"]).toBe(digest);

      // The staged slot is retained after promotion; sealed promotion copies,
      // it does not move.
      await expect(readStaged(storage.staging, uploadId, storageToken))
        .resolves.toEqual(bytes);
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-B: multipart staged source promotes and serves exact bytes",
    async () => {
      const installationId = "installation-promotion-multipart";
      const storage = createStorage(client, installationId, {promotion: "enabled"});
      const bytes = patternedBytes(multipartBytes);
      const digest = digestBytes(bytes);
      const {uploadId, storageToken} = await stage(
        storage.staging,
        bytes,
        digest,
        {chunkBytes: 64 * 1024},
      );

      const promoted = await promote(storage, {
        sha256: digest,
        size: bytes.byteLength,
        storageToken,
        uploadId,
      });
      expect(promoted).toEqual({sha256: digest, size: bytes.byteLength});
      await expect(readBlob(storage.blobs, digest)).resolves.toEqual(bytes);
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: size mismatch rejects and installs no blob",
    async () => {
      const installationId = "installation-promotion-size-mismatch";
      const storage = createStorage(client, installationId, {promotion: "enabled"});
      const bytes = new TextEncoder().encode("size mismatch bytes");
      const digest = digestBytes(bytes);
      const {uploadId, storageToken} = await stage(storage.staging, bytes, digest);

      await expect(promote(storage, {
        sha256: digest,
        size: bytes.byteLength + 1,
        storageToken,
        uploadId,
      })).rejects.toThrow(/unexpected size/u);
      await expect(headBlob(client, installationId, digest)).resolves.toBeNull();
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: digest mismatch rejects and installs no blob",
    async () => {
      const installationId = "installation-promotion-digest-mismatch";
      const storage = createStorage(client, installationId, {promotion: "enabled"});
      const bytes = new TextEncoder().encode("digest mismatch bytes");
      const digest = digestBytes(bytes);
      const wrongDigest = digestBytes(new TextEncoder().encode("different"));
      const {uploadId, storageToken} = await stage(storage.staging, bytes, digest);

      await expect(promote(storage, {
        sha256: wrongDigest,
        size: bytes.byteLength,
        storageToken,
        uploadId,
      })).rejects.toThrow(/fingerprint/u);
      await expect(headBlob(client, installationId, wrongDigest))
        .resolves.toBeNull();
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: missing staged source rejects and installs no blob",
    async () => {
      const installationId = "installation-promotion-missing-source";
      const storage = createStorage(client, installationId, {promotion: "enabled"});
      const digest = digestBytes(new TextEncoder().encode("missing source"));

      await expect(promote(storage, {
        sha256: digest,
        size: 100,
        storageToken: stagedFileToken(),
        uploadId: `upl_${randomUUID()}`,
      })).rejects.toThrow(/missing/u);
      await expect(headBlob(client, installationId, digest)).resolves.toBeNull();
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: replaced staged source rejects after bounded attempts and installs no blob",
    async () => {
      const installationId = "installation-promotion-replaced-source";
      const storage = createStorage(client, installationId, {promotion: "enabled"});
      const bytesA = new TextEncoder().encode("original sealed source bytes");
      const digestA = digestBytes(bytesA);
      const bytesB = new TextEncoder().encode("replaced sealed source bytes");
      const {uploadId, storageToken} = await stage(storage.staging, bytesA, digestA);

      // Simulate a slot rewrite mid-commit by overwriting the staged key with
      // different bytes through a raw S3 client.
      const keyspace = createInstallationObjectKeyspace(installationId);
      await client.send(new PutObjectCommand({
        Body: bytesB,
        Bucket: bucket,
        Key: keyspace.staging(uploadId, storageToken),
        Metadata: {
          "artifact-sha256": digestBytes(bytesB),
          "artifact-kind": "staging",
        },
      }));

      await expect(promote(storage, {
        sha256: digestA,
        size: bytesA.byteLength,
        storageToken,
        uploadId,
      })).rejects.toThrow(/fingerprint/u);
      await expect(headBlob(client, installationId, digestA)).resolves.toBeNull();
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-B: same-digest concurrent promotions converge to one stored blob",
    async () => {
      const installationId = "installation-promotion-race";
      const storage = createStorage(client, installationId, {promotion: "enabled"});
      const bytes = patternedBytes(2 * 1024 * 1024);
      const digest = digestBytes(bytes);
      const first = await stage(storage.staging, bytes, digest);
      const second = await stage(storage.staging, bytes, digest);

      const [a, b] = await Promise.all([
        promote(storage, {
          sha256: digest,
          size: bytes.byteLength,
          storageToken: first.storageToken,
          uploadId: first.uploadId,
        }),
        promote(storage, {
          sha256: digest,
          size: bytes.byteLength,
          storageToken: second.storageToken,
          uploadId: second.uploadId,
        }),
      ]);
      expect(a).toEqual({sha256: digest, size: bytes.byteLength});
      expect(b).toEqual(a);

      // The destination is content-addressed, so exactly one object holds the
      // bytes regardless of whether the provider enforced create-only copy.
      const keyspace = createInstallationObjectKeyspace(installationId);
      const listed = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: keyspace.blob(digest),
      }));
      expect((listed.Contents ?? []).length).toBe(1);
      await expect(readBlob(storage.blobs, digest)).resolves.toEqual(bytes);
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-B: lost CopyObject response still converges on retry",
    async () => {
      const installationId = "installation-promotion-lost-response";
      const proxy = await startS3CopyObjectFaultProxy(environment.endpoint);
      try {
        const proxyClient = new S3Client({
          credentials: {
            accessKeyId: environment.accessKey,
            secretAccessKey: environment.secretKey,
          },
          endpoint: proxy.origin,
          forcePathStyle: true,
          region,
        });
        const storage = createStorage(proxyClient, installationId, {
          promotion: "enabled",
        });
        const bytes = new TextEncoder().encode("lost response bytes");
        const digest = digestBytes(bytes);
        const {uploadId, storageToken} = await stage(
          storage.staging,
          bytes,
          digest,
        );

        const promoted = await promote(storage, {
          sha256: digest,
          size: bytes.byteLength,
          storageToken,
          uploadId,
        });
        expect(promoted).toEqual({sha256: digest, size: bytes.byteLength});
        expect(proxy.destroyedCopyObjectResponses).toBe(1);
        await expect(readBlob(storage.blobs, digest)).resolves.toEqual(bytes);
        proxyClient.destroy();
      } finally {
        await proxy.stop();
      }
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: repeated lost CopyObject responses exhaust bounded attempts",
    async () => {
      const installationId = "installation-promotion-exhaustion";
      const proxy = await startS3CopyObjectFaultProxy(
        environment.endpoint,
        3,
        "error",
      );
      try {
        // Disable SDK retries so each promotion attempt makes exactly one
        // CopyObject that the proxy faults.
        const proxyClient = new S3Client({
          credentials: {
            accessKeyId: environment.accessKey,
            secretAccessKey: environment.secretKey,
          },
          endpoint: proxy.origin,
          forcePathStyle: true,
          maxAttempts: 1,
          region,
        });
        const storage = createStorage(proxyClient, installationId, {
          promotion: "enabled",
        });
        const bytes = new TextEncoder().encode("exhaustion bytes");
        const digest = digestBytes(bytes);
        const {uploadId, storageToken} = await stage(
          storage.staging,
          bytes,
          digest,
        );

        await expect(promote(storage, {
          sha256: digest,
          size: bytes.byteLength,
          storageToken,
          uploadId,
        })).rejects.toThrow(/could not be promoted/u);
        expect(proxy.destroyedCopyObjectResponses).toBe(3);
        proxyClient.destroy();
      } finally {
        await proxy.stop();
      }
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: CopyObject source ETag mismatch retries then fails closed",
    async () => {
      const installationId = "installation-promotion-etag-mismatch";
      const storage = createStorage(client, installationId, {
        promotion: "enabled",
      });
      const bytesA = new TextEncoder().encode("etag mismatch source a");
      const digestA = digestBytes(bytesA);
      const bytesB = new TextEncoder().encode("etag mismatch source b");
      const {uploadId, storageToken} = await stage(
        storage.staging,
        bytesA,
        digestA,
      );

      const keyspace = createInstallationObjectKeyspace(installationId);
      const sourceKey = keyspace.staging(uploadId, storageToken);
      const racingClient = createClient(environment);
      const headInputSchema = z.object({
        Bucket: z.string().optional(),
        Key: z.string().optional(),
      });
      racingClient.middlewareStack.add(
        (next, context) => async (arguments_) => {
          const result = await next(arguments_);
          const parsed = headInputSchema.safeParse(arguments_.input);
          if (
            !parsed.success ||
            context.commandName !== "HeadObjectCommand" ||
            parsed.data.Key !== sourceKey ||
            parsed.data.Bucket !== bucket
          ) {
            return result;
          }
          // Overwrite the staged source after the seal read so the sealed
          // ETag no longer matches at copy time.
          await client.send(new PutObjectCommand({
            Body: bytesB,
            Bucket: bucket,
            Key: sourceKey,
            Metadata: {
              "artifact-sha256": digestBytes(bytesB),
              "artifact-kind": "staging",
            },
          }));
          return result;
        },
        {name: "overwriteAfterHead", step: "deserialize"},
      );

      const racingStorage = createStorage(racingClient, installationId, {
        promotion: "enabled",
      });
      try {
        await expect(promote(racingStorage, {
          sha256: digestA,
          size: bytesA.byteLength,
          storageToken,
          uploadId,
        })).rejects.toThrow(/fingerprint/u);
      } finally {
        racingClient.destroy();
      }
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: rejected promote still allows verified-stream put to install the blob",
    async () => {
      const installationId = "installation-promotion-fallback";
      const storage = createStorage(client, installationId, {promotion: "enabled"});
      const bytes = new TextEncoder().encode("fallback after rejected promotion");
      const digest = digestBytes(bytes);
      const {uploadId, storageToken} = await stage(storage.staging, bytes, digest);

      // Make promotion fail by replacing the staged source with different bytes.
      const keyspace = createInstallationObjectKeyspace(installationId);
      const replacement = new TextEncoder().encode("different fallback bytes");
      await client.send(new PutObjectCommand({
        Body: replacement,
        Bucket: bucket,
        Key: keyspace.staging(uploadId, storageToken),
        Metadata: {
          "artifact-sha256": digestBytes(replacement),
          "artifact-kind": "staging",
        },
      }));
      await expect(promote(storage, {
        sha256: digest,
        size: bytes.byteLength,
        storageToken,
        uploadId,
      })).rejects.toBeDefined();

      // The verified-stream path can still install the exact bytes for the
      // digest the commit expected.
      await expect(storage.blobs.put({
        body: chunkedBody(bytes, 7),
        sha256: digest,
        size: bytes.byteLength,
      })).resolves.toEqual({sha256: digest, size: bytes.byteLength});
      await expect(readBlob(storage.blobs, digest)).resolves.toEqual(bytes);
    },
    integrationTestTimeoutMs,
  );
});

function createClient(environment: IntegrationEnvironment): S3Client {
  return new S3Client({
    credentials: {
      accessKeyId: environment.accessKey,
      secretAccessKey: environment.secretKey,
    },
    endpoint: environment.endpoint,
    forcePathStyle: true,
    region,
  });
}

function createStorage(
  client: S3Client,
  installationId: string,
  options: {promotion?: S3ObjectStorageConfig["promotion"]} = {},
) {
  return createS3ObjectStorageAdapters({
    bucket,
    client,
    installationId,
    promotion: options.promotion ?? "enabled",
  });
}

function readIntegrationEnvironment(): IntegrationEnvironment {
  const accessKey = process.env["ARTIFACT_SERVER_S3_ACCESS_KEY"];
  const container = process.env["ARTIFACT_SERVER_MINIO_CONTAINER"];
  const endpoint = process.env["ARTIFACT_SERVER_S3_ENDPOINT"];
  const image = process.env["ARTIFACT_SERVER_MINIO_IMAGE"];
  const secretKey = process.env["ARTIFACT_SERVER_S3_SECRET_KEY"];
  const volume = process.env["ARTIFACT_SERVER_MINIO_VOLUME"];
  if (
    accessKey === undefined || container === undefined ||
    endpoint === undefined || image === undefined ||
    secretKey === undefined || volume === undefined
  ) {
    throw new Error("Run this test through pnpm test:storage-s3.");
  }
  return {accessKey, container, endpoint, image, secretKey, volume};
}

async function readBlob(store: BlobStore, fingerprint: string): Promise<Uint8Array> {
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

function promote(
  storage: {blobs: BlobStore},
  source: SealedStagedSource,
): Promise<StoredBlob> {
  if (storage.blobs.promote === undefined) {
    throw new Error("The storage adapter does not expose sealed promotion.");
  }
  return storage.blobs.promote(source);
}

const s3ErrorSchema = z.object({
  $metadata: z.object({
    httpStatusCode: z.number().optional(),
  }).optional(),
});

async function headBlob(
  s3Client: S3Client,
  installationId: string,
  fingerprint: string,
): Promise<StoredBlob | null> {
  try {
    const output = await s3Client.send(new HeadObjectCommand({
      Bucket: bucket,
      Key: blobKey(installationId, fingerprint),
    }));
    if (
      output.Metadata?.["artifact-kind"] !== "blob" ||
      output.Metadata?.["artifact-sha256"] !== fingerprint
    ) {
      return null;
    }
    return {sha256: fingerprint, size: output.ContentLength ?? Number.NaN};
  } catch (error) {
    const parsed = s3ErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }
}

async function stage(
  store: StagingStore,
  bytes: Uint8Array,
  digest: string,
  options: {chunkBytes?: number} = {},
): Promise<{storageToken: string; uploadId: string}> {
  const uploadId = `upl_${randomUUID()}`;
  const storageToken = stagedFileToken();
  await store.put({
    body: chunkedBody(bytes, options.chunkBytes ?? 5),
    sha256: digest,
    size: bytes.byteLength,
    storageToken,
    uploadId,
  });
  return {storageToken, uploadId};
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function blobKey(installationId: string, fingerprint: string): string {
  const namespace = createHash("sha256").update(installationId).digest("hex");
  return `installations/${namespace}/blobs/${fingerprint.slice(0, 2)}/${fingerprint}`;
}

function stagedFileToken(): string {
  return randomBytes(18).toString("hex");
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
