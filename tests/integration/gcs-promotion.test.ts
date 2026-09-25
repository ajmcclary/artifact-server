import {createHash, randomBytes, randomUUID} from "node:crypto";

import {Storage} from "@google-cloud/storage";
import {Option} from "effect";
import {beforeAll, describe, expect, test} from "vitest";

import type {
  BlobStore,
  SealedStagedSource,
  StagingStore,
  StoredBlob,
} from "../../src/core/ports.js";
import {createInstallationObjectKeyspace} from "../../src/storage/cloud-object-storage.js";
import {parseGcsFailure} from "../../src/storage/gcs-failure.js";
import {
  createGcsObjectStorageAdapters,
  createGcsObjectStorageProviderFactory,
} from "../../src/storage/gcs-object-storage.js";
import {probeGcsSealedPromotion} from
  "../../src/storage/gcs-sealed-promotion-probe.js";
import {startGcsRewriteFaultProxy} from "../support/gcs-rewrite-fault-proxy.js";
import {startGcsSealRaceProxy} from "../support/gcs-seal-race-proxy.js";

const bucketName = "artifact-server-integration";
const projectId = "artifact-server-integration";
const endpoint = requiredEnvironment("ARTIFACT_SERVER_TEST_GCS_ENDPOINT");
const storage = new Storage({apiEndpoint: endpoint, projectId});
const bucket = storage.bucket(bucketName);
const integrationTestTimeoutMs = 60_000;
const resumableBytes = 11 * 1024 * 1024;

describe.sequential("GCS sealed staged promotion", () => {
  beforeAll(async () => {
    const [exists] = await bucket.exists();
    if (!exists) await storage.createBucket(bucketName);
  });

  test(
    "PUB-018-F: default probe on fake-gcs-server exposes no promote and leaves no scratch objects",
    async () => {
      const installationId = "installation-gcs-promotion-probe";
      const provider = createGcsObjectStorageProviderFactory({
        apiEndpoint: endpoint,
        bucket: bucketName,
        projectId,
      }).create(installationId);
      try {
        await provider.readiness(AbortSignal.timeout(10_000));
        // fake-gcs-server honors source generation pinning but ignores the
        // destination zero-generation precondition on rewriteTo, so the probe
        // must fail and the emulator keeps the verified-stream fallback.
        await expect(probeGcsSealedPromotion(bucket, installationId))
          .resolves.toBe(false);
        expect(Object.hasOwn(provider.blobs, "promote")).toBe(false);

        const namespace = createHash("sha256").update(installationId)
          .digest("hex");
        const [files] = await bucket.getFiles({
          prefix: `installations/${namespace}/promotion-probe/`,
        });
        expect(files).toEqual([]);
      } finally {
        await provider.close();
      }
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-B: sealed copy round trip promotes, keeps staged bytes, and serves exact bytes",
    async () => {
      const installationId = "installation-gcs-promotion-round-trip";
      const adapters = createStorage(installationId);
      const bytes = new TextEncoder().encode("sealed promotion round trip bytes");
      const digest = digestBytes(bytes);
      const {uploadId, storageToken} = await stage(adapters.staging, bytes, digest);

      const promoted = await promote(adapters, {
        sha256: digest,
        size: bytes.byteLength,
        storageToken,
        uploadId,
      });
      expect(promoted).toEqual({sha256: digest, size: bytes.byteLength});

      await expect(readBlob(adapters.blobs, digest)).resolves.toEqual(bytes);
      const keyspace = createInstallationObjectKeyspace(installationId);
      const [metadata] = await bucket.file(keyspace.blob(digest)).getMetadata();
      expect(metadata.metadata?.["artifact-kind"]).toBe("blob");
      expect(metadata.metadata?.["artifact-sha256"]).toBe(digest);
      expect(metadata.contentType).toBe("application/octet-stream");

      // The staged slot is retained after promotion; sealed promotion copies,
      // it does not move.
      await expect(readStaged(adapters.staging, uploadId, storageToken))
        .resolves.toEqual(bytes);
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-B: resumable-scale staged source promotes and serves exact bytes",
    async () => {
      const installationId = "installation-gcs-promotion-resumable";
      const adapters = createStorage(installationId);
      const bytes = patternedBytes(resumableBytes);
      const digest = digestBytes(bytes);
      const {uploadId, storageToken} = await stage(
        adapters.staging,
        bytes,
        digest,
        {chunkBytes: 256 * 1024},
      );

      const promoted = await promote(adapters, {
        sha256: digest,
        size: bytes.byteLength,
        storageToken,
        uploadId,
      });
      expect(promoted).toEqual({sha256: digest, size: bytes.byteLength});
      await expect(readBlob(adapters.blobs, digest)).resolves.toEqual(bytes);
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: size mismatch rejects and installs no blob",
    async () => {
      const installationId = "installation-gcs-promotion-size-mismatch";
      const adapters = createStorage(installationId);
      const bytes = new TextEncoder().encode("size mismatch bytes");
      const digest = digestBytes(bytes);
      const {uploadId, storageToken} = await stage(adapters.staging, bytes, digest);

      await expect(promote(adapters, {
        sha256: digest,
        size: bytes.byteLength + 1,
        storageToken,
        uploadId,
      })).rejects.toThrow(/unexpected size/u);
      await expect(headBlob(installationId, digest)).resolves.toBeNull();
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: digest mismatch rejects and installs no blob",
    async () => {
      const installationId = "installation-gcs-promotion-digest-mismatch";
      const adapters = createStorage(installationId);
      const bytes = new TextEncoder().encode("digest mismatch bytes");
      const digest = digestBytes(bytes);
      const wrongDigest = digestBytes(new TextEncoder().encode("different"));
      const {uploadId, storageToken} = await stage(adapters.staging, bytes, digest);

      await expect(promote(adapters, {
        sha256: wrongDigest,
        size: bytes.byteLength,
        storageToken,
        uploadId,
      })).rejects.toThrow(/fingerprint/u);
      await expect(headBlob(installationId, wrongDigest)).resolves.toBeNull();
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: missing staged source rejects and installs no blob",
    async () => {
      const installationId = "installation-gcs-promotion-missing-source";
      const adapters = createStorage(installationId);
      const digest = digestBytes(new TextEncoder().encode("missing source"));

      await expect(promote(adapters, {
        sha256: digest,
        size: 100,
        storageToken: stagedFileToken(),
        uploadId: `upl_${randomUUID()}`,
      })).rejects.toThrow(/missing/u);
      await expect(headBlob(installationId, digest)).resolves.toBeNull();
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: replaced staged source rejects and installs no blob",
    async () => {
      const installationId = "installation-gcs-promotion-replaced-source";
      const adapters = createStorage(installationId);
      const bytesA = new TextEncoder().encode("original sealed source bytes");
      const digestA = digestBytes(bytesA);
      const bytesB = new TextEncoder().encode("replaced sealed source bytes!");
      const {uploadId, storageToken} = await stage(
        adapters.staging,
        bytesA,
        digestA,
      );

      // Simulate a slot rewrite mid-commit by overwriting the staged key with
      // different bytes directly through the emulator.
      const keyspace = createInstallationObjectKeyspace(installationId);
      await overwriteStaged(keyspace.staging(uploadId, storageToken), bytesB);

      await expect(promote(adapters, {
        sha256: digestA,
        size: bytesA.byteLength,
        storageToken,
        uploadId,
      })).rejects.toThrow(/fingerprint|size/u);
      await expect(headBlob(installationId, digestA)).resolves.toBeNull();
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: replacement between seal and copy retries then fails closed",
    async () => {
      const installationId = "installation-gcs-promotion-seal-race";
      const adapters = createStorage(installationId);
      const bytesA = new TextEncoder().encode("seal race source bytes a");
      const digestA = digestBytes(bytesA);
      const bytesB = new TextEncoder().encode("seal race source bytes b!");
      const {uploadId, storageToken} = await stage(
        adapters.staging,
        bytesA,
        digestA,
      );

      // A loopback proxy overwrites the staged source after the seal's
      // metadata read is answered, so the pinned generation is gone at copy
      // time; the retry re-seals and rejects the replaced bytes.
      const keyspace = createInstallationObjectKeyspace(installationId);
      const sourceKey = keyspace.staging(uploadId, storageToken);
      const proxy = await startGcsSealRaceProxy(endpoint, sourceKey, async () => {
        await overwriteStaged(sourceKey, bytesB);
      });
      try {
        const proxyStorage = new Storage({
          apiEndpoint: proxy.origin,
          projectId,
        });
        const racing = createGcsObjectStorageAdapters({
          bucket: proxyStorage.bucket(bucketName),
          installationId,
          promotion: "enabled",
        });
        await expect(promote(racing, {
          sha256: digestA,
          size: bytesA.byteLength,
          storageToken,
          uploadId,
        })).rejects.toThrow(/fingerprint|size/u);
        await expect(headBlob(installationId, digestA)).resolves.toBeNull();
      } finally {
        await proxy.stop();
      }
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-B: same-digest concurrent promotions converge to one stored blob",
    async () => {
      const installationId = "installation-gcs-promotion-race";
      const adapters = createStorage(installationId);
      const bytes = patternedBytes(2 * 1024 * 1024);
      const digest = digestBytes(bytes);
      const first = await stage(adapters.staging, bytes, digest);
      const second = await stage(adapters.staging, bytes, digest);

      const [a, b] = await Promise.all([
        promote(adapters, {
          sha256: digest,
          size: bytes.byteLength,
          storageToken: first.storageToken,
          uploadId: first.uploadId,
        }),
        promote(adapters, {
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
      const [files] = await bucket.getFiles({prefix: keyspace.blob(digest)});
      expect(files.length).toBe(1);
      await expect(readBlob(adapters.blobs, digest)).resolves.toEqual(bytes);
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-B: lost rewrite response still converges on retry",
    async () => {
      const installationId = "installation-gcs-promotion-lost-response";
      const proxy = await startGcsRewriteFaultProxy(endpoint);
      try {
        const proxyStorage = new Storage({
          apiEndpoint: proxy.origin,
          projectId,
        });
        const adapters = createGcsObjectStorageAdapters({
          bucket: proxyStorage.bucket(bucketName),
          installationId,
          promotion: "enabled",
        });
        const bytes = new TextEncoder().encode("lost response bytes");
        const digest = digestBytes(bytes);
        const {uploadId, storageToken} = await stage(
          adapters.staging,
          bytes,
          digest,
        );

        const promoted = await promote(adapters, {
          sha256: digest,
          size: bytes.byteLength,
          storageToken,
          uploadId,
        });
        expect(promoted).toEqual({sha256: digest, size: bytes.byteLength});
        expect(proxy.destroyedRewriteResponses).toBe(1);
        await expect(readBlob(adapters.blobs, digest)).resolves.toEqual(bytes);
      } finally {
        await proxy.stop();
      }
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: repeated rewrite failures exhaust bounded attempts",
    async () => {
      const installationId = "installation-gcs-promotion-exhaustion";
      const proxy = await startGcsRewriteFaultProxy(endpoint, 3, "error");
      try {
        const proxyStorage = new Storage({
          apiEndpoint: proxy.origin,
          projectId,
        });
        const adapters = createGcsObjectStorageAdapters({
          bucket: proxyStorage.bucket(bucketName),
          installationId,
          promotion: "enabled",
        });
        const bytes = new TextEncoder().encode("exhaustion bytes");
        const digest = digestBytes(bytes);
        const {uploadId, storageToken} = await stage(
          adapters.staging,
          bytes,
          digest,
        );

        await expect(promote(adapters, {
          sha256: digest,
          size: bytes.byteLength,
          storageToken,
          uploadId,
        })).rejects.toThrow(/could not be promoted/u);
        expect(proxy.destroyedRewriteResponses).toBe(3);
        await expect(headBlob(installationId, digest)).resolves.toBeNull();
      } finally {
        await proxy.stop();
      }
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: rejected promote still allows verified-stream put to install the blob",
    async () => {
      const installationId = "installation-gcs-promotion-fallback";
      const adapters = createStorage(installationId);
      const bytes = new TextEncoder().encode("fallback after rejected promotion");
      const digest = digestBytes(bytes);
      const {uploadId, storageToken} = await stage(
        adapters.staging,
        bytes,
        digest,
      );

      // Make promotion fail by replacing the staged source with different bytes.
      const keyspace = createInstallationObjectKeyspace(installationId);
      const replacement = new TextEncoder().encode("different fallback bytes!");
      await overwriteStaged(
        keyspace.staging(uploadId, storageToken),
        replacement,
      );
      await expect(promote(adapters, {
        sha256: digest,
        size: bytes.byteLength,
        storageToken,
        uploadId,
      })).rejects.toBeDefined();

      // The verified-stream path can still install the exact bytes for the
      // digest the commit expected.
      await expect(adapters.blobs.put({
        body: chunkedBody(bytes, 7),
        sha256: digest,
        size: bytes.byteLength,
      })).resolves.toEqual({sha256: digest, size: bytes.byteLength});
      await expect(readBlob(adapters.blobs, digest)).resolves.toEqual(bytes);
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: disabled promotion exposes no promote and put installs exact bytes",
    async () => {
      const installationId = "installation-gcs-promotion-disabled";
      const adapters = createGcsObjectStorageAdapters({
        bucket,
        installationId,
        promotion: "disabled",
      });
      expect(Object.hasOwn(adapters.blobs, "promote")).toBe(false);
      const bytes = new TextEncoder().encode("disabled promotion stream bytes");
      const digest = digestBytes(bytes);
      await expect(adapters.blobs.put({
        body: chunkedBody(bytes, 5),
        sha256: digest,
        size: bytes.byteLength,
      })).resolves.toEqual({sha256: digest, size: bytes.byteLength});
      await expect(readBlob(adapters.blobs, digest)).resolves.toEqual(bytes);
    },
    integrationTestTimeoutMs,
  );
});

function createStorage(installationId: string) {
  return createGcsObjectStorageAdapters({
    bucket,
    installationId,
    promotion: "enabled",
  });
}

async function overwriteStaged(key: string, bytes: Uint8Array): Promise<void> {
  await bucket.file(key).save(bytes, {
    metadata: {
      metadata: {
        "artifact-kind": "staging",
        "artifact-sha256": digestBytes(bytes),
      },
    },
    resumable: false,
    validation: false,
  });
}

async function headBlob(
  installationId: string,
  fingerprint: string,
): Promise<StoredBlob | null> {
  const keyspace = createInstallationObjectKeyspace(installationId);
  try {
    const [metadata] = await bucket.file(keyspace.blob(fingerprint))
      .getMetadata();
    if (
      metadata.metadata?.["artifact-kind"] !== "blob" ||
      metadata.metadata?.["artifact-sha256"] !== fingerprint
    ) {
      return null;
    }
    return {sha256: fingerprint, size: Number(metadata.size)};
  } catch (error) {
    const failure = parseGcsFailure(error);
    if (Option.isSome(failure) && failure.value.code === 404) return null;
    throw error;
  }
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
  adapters: {blobs: BlobStore},
  source: SealedStagedSource,
): Promise<StoredBlob> {
  if (adapters.blobs.promote === undefined) {
    throw new Error("The storage adapter does not expose sealed promotion.");
  }
  return adapters.blobs.promote(source);
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

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error("Run this test through pnpm test:storage-native-cloud.");
  }
  return value;
}
