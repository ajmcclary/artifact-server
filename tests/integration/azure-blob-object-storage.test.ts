import {createHash, randomUUID} from "node:crypto";

import {
  BlobServiceClient,
  newPipeline,
  type RequestPolicyFactory,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import {afterEach, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {createAzureBlobObjectStorageAdapters} from
  "../../src/storage/azure-blob-object-storage.js";
import {FileVerificationError} from "../../src/storage/verified-file.js";
import {
  defineNativeObjectStorageContract,
  nativeBlobKey,
} from "../support/native-object-storage-contract.js";

const accountName = "devstoreaccount1";
const accountKey =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/" +
  "K1SZFPTOtr/KBHBeksoGMGw==";
const containerName = "artifact-server-integration";
const endpoint = requiredEnvironment("ARTIFACT_SERVER_TEST_AZURE_BLOB_ENDPOINT");
const credential = new StorageSharedKeyCredential(accountName, accountKey);
const service = new BlobServiceClient(endpoint, credential);
const container = service.getContainerClient(containerName);

beforeAll(async () => {
  await container.createIfNotExists();
});

defineNativeObjectStorageContract({
  name: "Azure Blob",
  create: (installationId) => createAzureBlobObjectStorageAdapters({
    container,
    installationId,
  }),
  corrupt: async ({
    bytes,
    installationId,
    kind,
    objectDigest,
    recordedDigest,
  }) => {
    const metadata = recordedDigest === null
      ? {artifactkind: kind}
      : {artifactkind: kind, artifactsha256: recordedDigest};
    await container
      .getBlockBlobClient(nativeBlobKey(installationId, objectDigest))
      .uploadData(bytes, {metadata});
  },
});

/**
 * A rival writer that, just before the adapter's own Release Lease request
 * leaves this process, breaks the write lease and takes the blob under a
 * different lease ID. Azurite then really refuses the adapter's release.
 * This is an Azure SDK request policy over the real HTTP boundary, not a
 * substituted module.
 */
class RivalLeaseTakeover {
  readonly #rivalLeaseId = randomUUID();
  readonly releaseStatuses: Array<number> = [];
  #takenBlobName: string | null = null;

  readonly policy: RequestPolicyFactory = {
    create: (next) => ({
      sendRequest: async (request) => {
        if (request.headers.get("x-ms-lease-action") !== "release") {
          return next.sendRequest(request);
        }
        const blobName = blobNameFromRequestUrl(request.url);
        const rival = container.getBlobClient(blobName);
        await rival.getBlobLeaseClient().breakLease(0);
        await rival.getBlobLeaseClient(this.#rivalLeaseId).acquireLease(15);
        this.#takenBlobName = blobName;
        try {
          const response = await next.sendRequest(request);
          this.releaseStatuses.push(response.status);
          return response;
        } catch (error) {
          this.releaseStatuses.push(
            z.object({statusCode: z.number()}).parse(error).statusCode,
          );
          throw error;
        }
      },
    }),
  };

  async restore(): Promise<void> {
    if (this.#takenBlobName === null) return;
    await container
      .getBlobClient(this.#takenBlobName)
      .getBlobLeaseClient(this.#rivalLeaseId)
      .releaseLease();
    this.#takenBlobName = null;
  }
}

function blobNameFromRequestUrl(url: string): string {
  const prefix = `/${accountName}/${containerName}/`;
  const pathname = new URL(url).pathname;
  if (!pathname.startsWith(prefix)) {
    throw new Error(`Unexpected Azure lease request path ${pathname}.`);
  }
  return decodeURIComponent(pathname.slice(prefix.length));
}

function containerWithPolicy(policy: RequestPolicyFactory) {
  // newPipeline keeps the shared-key credential on the pipeline itself, so
  // the extra policy joins its (empty) legacy factory list.
  const pipeline = newPipeline(credential);
  pipeline.factories.push(policy);
  return new BlobServiceClient(endpoint, pipeline).getContainerClient(containerName);
}

function singleChunkBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe.sequential("Azure Blob write-lease release", () => {
  let takeover: RivalLeaseTakeover;

  afterEach(async () => {
    await takeover.restore();
  });

  test("a refused lease release does not fail a write that already committed", async () => {
    takeover = new RivalLeaseTakeover();
    const installationId = `installation-release-after-commit-${randomUUID()}`;
    const storage = createAzureBlobObjectStorageAdapters({
      container: containerWithPolicy(takeover.policy),
      installationId,
    });
    const bytes = new TextEncoder().encode("committed before the lease release failed\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    await expect(storage.blobs.put({body: singleChunkBody(bytes), sha256, size: bytes.byteLength}))
      .resolves.toEqual({sha256, size: bytes.byteLength});

    expect(takeover.releaseStatuses).toEqual([409]);
    const opened = await storage.blobs.open(sha256);
    expect(new Uint8Array(await new Response(opened.body).arrayBuffer())).toEqual(bytes);
    const properties = await container
      .getBlobClient(nativeBlobKey(installationId, sha256))
      .getProperties();
    expect(properties.contentLength).toBe(bytes.byteLength);
    expect(properties.leaseState).toBe("leased");
  });

  test("a refused lease release does not mask the write's own failure", async () => {
    takeover = new RivalLeaseTakeover();
    const installationId = `installation-release-after-failure-${randomUUID()}`;
    const storage = createAzureBlobObjectStorageAdapters({
      container: containerWithPolicy(takeover.policy),
      installationId,
    });
    const declared = new TextEncoder().encode("declared bytes\n");
    const sent = new TextEncoder().encode("different bytes\n");
    const sha256 = createHash("sha256").update(declared).digest("hex");

    const write = storage.blobs.put({body: singleChunkBody(sent), sha256, size: sent.byteLength});

    await expect(write).rejects.toBeInstanceOf(FileVerificationError);
    await expect(write).rejects.toThrow(/fingerprint/u);
    expect(takeover.releaseStatuses).toEqual([409]);
    await expect(storage.blobs.open(sha256)).rejects.toBeDefined();
  });
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error("Run this test through pnpm test:storage-native-cloud.");
  }
  return value;
}
