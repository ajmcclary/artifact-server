import {createHash, randomBytes, randomUUID} from "node:crypto";

import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import {beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import type {
  BlobStore,
  SealedStagedSource,
  StagingStore,
  StoredBlob,
} from "../../src/core/ports.js";
import {createInstallationObjectKeyspace} from "../../src/storage/cloud-object-storage.js";
import {
  createAzureBlobObjectStorageAdapters,
  createAzureBlobObjectStorageProviderFactory,
  type AzureBlobObjectStorageConfig,
} from "../../src/storage/azure-blob-object-storage.js";
import {
  startAzureCopyBlobFaultProxy,
  startAzureSealRaceProxy,
} from "../support/azure-copy-blob-fault-proxy.js";

const accountName = "devstoreaccount1";
const accountKey =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/" +
  "K1SZFPTOtr/KBHBeksoGMGw==";
const containerName = "artifact-server-integration-promotion";
const endpoint = requiredEnvironment("ARTIFACT_SERVER_TEST_AZURE_BLOB_ENDPOINT");
const credential = new StorageSharedKeyCredential(accountName, accountKey);
const service = new BlobServiceClient(endpoint, credential);
const container = service.getContainerClient(containerName);
const integrationTestTimeoutMs = 90_000;
const blockBytes = 9 * 1024 * 1024;

describe.sequential("Azure Blob sealed staged promotion", () => {
  beforeAll(async () => {
    await container.createIfNotExists();
  });

  test(
    "PUB-018-B: default probe on Azurite exposes promote and leaves no scratch objects",
    async () => {
      const installationId = "installation-azure-promotion-probe";
      const provider = createAzureBlobObjectStorageProviderFactory({
        accountUrl: endpoint,
        container: containerName,
        copySourceUrl: (source) => source.url,
        credential: new StorageSharedKeyCredential(accountName, accountKey),
      }).create(installationId);
      try {
        await provider.readiness(AbortSignal.timeout(10_000));
        expect(Object.hasOwn(provider.blobs, "promote")).toBe(true);

        const namespace = createHash("sha256").update(installationId)
          .digest("hex");
        const listed: unknown[] = [];
        for await (
          const blob of container.listBlobsFlat({
            prefix: `installations/${namespace}/promotion-probe/`,
          })
        ) {
          listed.push(blob);
        }
        expect(listed).toEqual([]);
      } finally {
        await provider.close();
      }
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-B: sealed copy round trip promotes, keeps staged bytes, and serves exact bytes",
    async () => {
      const installationId = "installation-azure-promotion-round-trip";
      const storage = createStorage(installationId);
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
      const properties = await container.getBlobClient(
        blobKey(installationId, digest),
      ).getProperties();
      expect(properties.metadata?.["artifactkind"]).toBe("blob");
      expect(properties.metadata?.["artifactsha256"]).toBe(digest);

      // The staged slot is retained after promotion; sealed promotion copies,
      // it does not move.
      await expect(readStaged(storage.staging, uploadId, storageToken))
        .resolves.toEqual(bytes);
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-B: block-boundary-scale staged source promotes and serves exact bytes",
    async () => {
      const installationId = "installation-azure-promotion-block-scale";
      const storage = createStorage(installationId);
      const bytes = patternedBytes(blockBytes);
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
      const installationId = "installation-azure-promotion-size-mismatch";
      const storage = createStorage(installationId);
      const bytes = new TextEncoder().encode("size mismatch bytes");
      const digest = digestBytes(bytes);
      const {uploadId, storageToken} = await stage(storage.staging, bytes, digest);

      await expect(promote(storage, {
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
      const installationId = "installation-azure-promotion-digest-mismatch";
      const storage = createStorage(installationId);
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
      await expect(headBlob(installationId, wrongDigest)).resolves.toBeNull();
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: missing staged source rejects and installs no blob",
    async () => {
      const installationId = "installation-azure-promotion-missing-source";
      const storage = createStorage(installationId);
      const digest = digestBytes(new TextEncoder().encode("missing source"));

      await expect(promote(storage, {
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
    "PUB-018-F: replaced staged source rejects after bounded attempts and installs no blob",
    async () => {
      const installationId = "installation-azure-promotion-replaced-source";
      const storage = createStorage(installationId);
      const bytesA = new TextEncoder().encode("original sealed source bytes");
      const digestA = digestBytes(bytesA);
      const bytesB = new TextEncoder().encode("replaced sealed source bytes");
      const {uploadId, storageToken} = await stage(storage.staging, bytesA, digestA);

      // Simulate a slot rewrite mid-commit by overwriting the staged key with
      // different bytes directly through the emulator.
      const keyspace = createInstallationObjectKeyspace(installationId);
      await overwriteStaged(keyspace.staging(uploadId, storageToken), bytesB);

      await expect(promote(storage, {
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
    "PUB-018-B: same-digest concurrent promotions converge to one stored blob",
    async () => {
      const installationId = "installation-azure-promotion-race";
      const storage = createStorage(installationId);
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
      const listed: unknown[] = [];
      for await (
        const blob of container.listBlobsFlat({prefix: keyspace.blob(digest)})
      ) {
        listed.push(blob);
      }
      expect(listed.length).toBe(1);
      await expect(readBlob(storage.blobs, digest)).resolves.toEqual(bytes);
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-B: lost Copy Blob response still converges on retry",
    async () => {
      const installationId = "installation-azure-promotion-lost-response";
      const proxy = await startAzureCopyBlobFaultProxy(endpoint);
      try {
        const proxyService = new BlobServiceClient(proxy.origin, credential);
        const proxyContainer = proxyService.getContainerClient(containerName);
        const storage = createAzureBlobObjectStorageAdapters({
          container: proxyContainer,
          copySourceUrl: (source) => source.url,
          installationId,
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
        expect(proxy.destroyedCopyBlobResponses).toBe(1);
        await expect(readBlob(storage.blobs, digest)).resolves.toEqual(bytes);
      } finally {
        await proxy.stop();
      }
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: repeated lost Copy Blob responses exhaust bounded attempts",
    async () => {
      const installationId = "installation-azure-promotion-exhaustion";
      const proxy = await startAzureCopyBlobFaultProxy(endpoint, 3, "error");
      try {
        // Disable SDK retries so each promotion attempt makes exactly one
        // Copy Blob that the proxy faults.
        const proxyService = new BlobServiceClient(proxy.origin, credential, {
          retryOptions: {maxTries: 1},
        });
        const proxyContainer = proxyService.getContainerClient(containerName);
        const storage = createAzureBlobObjectStorageAdapters({
          container: proxyContainer,
          copySourceUrl: (source) => source.url,
          installationId,
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
        expect(proxy.destroyedCopyBlobResponses).toBe(3);
        await expect(headBlob(installationId, digest)).resolves.toBeNull();
      } finally {
        await proxy.stop();
      }
    },
    integrationTestTimeoutMs,
  );

  test(
    "PUB-018-F: Copy Blob source ETag mismatch retries then fails closed",
    async () => {
      const installationId = "installation-azure-promotion-etag-mismatch";
      const storage = createStorage(installationId);
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
      const proxy = await startAzureSealRaceProxy(
        endpoint,
        sourceKey,
        async () => {
          await overwriteStaged(sourceKey, bytesB);
        },
      );
      try {
        const proxyService = new BlobServiceClient(proxy.origin, credential);
        const proxyContainer = proxyService.getContainerClient(containerName);
        const racing = createAzureBlobObjectStorageAdapters({
          container: proxyContainer,
          copySourceUrl: (source) => source.url,
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
    "PUB-018-F: rejected promote still allows verified-stream put to install the blob",
    async () => {
      const installationId = "installation-azure-promotion-fallback";
      const storage = createStorage(installationId);
      const bytes = new TextEncoder().encode("fallback after rejected promotion");
      const digest = digestBytes(bytes);
      const {uploadId, storageToken} = await stage(storage.staging, bytes, digest);

      // Make promotion fail by replacing the staged source with different bytes.
      const keyspace = createInstallationObjectKeyspace(installationId);
      const replacement = new TextEncoder().encode("different fallback bytes");
      await overwriteStaged(
        keyspace.staging(uploadId, storageToken),
        replacement,
      );
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

function createStorage(
  installationId: string,
  options: {promotion?: AzureBlobObjectStorageConfig["promotion"]} = {},
) {
  return createAzureBlobObjectStorageAdapters({
    container,
    copySourceUrl: (source) => source.url,
    installationId,
    promotion: options.promotion ?? "enabled",
  });
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

const azureErrorSchema = z.object({
  statusCode: z.number().optional(),
  code: z.string().optional(),
});

async function headBlob(
  installationId: string,
  fingerprint: string,
): Promise<StoredBlob | null> {
  const keyspace = createInstallationObjectKeyspace(installationId);
  try {
    const properties = await container.getBlobClient(
      keyspace.blob(fingerprint),
    ).getProperties();
    if (
      properties.metadata?.["artifactkind"] !== "blob" ||
      properties.metadata?.["artifactsha256"] !== fingerprint
    ) {
      return null;
    }
    return {sha256: fingerprint, size: properties.contentLength ?? Number.NaN};
  } catch (error) {
    const parsed = azureErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.statusCode === 404) {
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

async function overwriteStaged(key: string, bytes: Uint8Array): Promise<void> {
  await container.getBlockBlobClient(key).uploadData(bytes, {
    metadata: {
      artifactsha256: digestBytes(bytes),
      artifactkind: "staging",
    },
  });
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

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error("Run this test through pnpm test:storage-native-cloud.");
  }
  return value;
}
